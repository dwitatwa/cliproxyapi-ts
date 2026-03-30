export interface ChatStreamState {
  responseId: string;
  createdAt: number;
  model: string;
  functionCallIndex: number;
  hasReceivedArgumentsDelta: boolean;
  hasToolCallAnnounced: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function shortenNameIfNeeded(name: string): string {
  const limit = 64;
  if (name.length <= limit) {
    return name;
  }
  if (name.startsWith("mcp__")) {
    const idx = name.lastIndexOf("__");
    if (idx > 0) {
      const candidate = `mcp__${name.slice(idx + 2)}`;
      return candidate.slice(0, limit);
    }
  }
  return name.slice(0, limit);
}

function buildShortNameMap(names: string[]): Map<string, string> {
  const limit = 64;
  const used = new Set<string>();
  const output = new Map<string, string>();

  const baseCandidate = (name: string): string => shortenNameIfNeeded(name);
  const makeUnique = (candidate: string): string => {
    if (!used.has(candidate)) {
      return candidate;
    }
    for (let index = 1; ; index += 1) {
      const suffix = `_${index}`;
      const unique = `${candidate.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
      if (!used.has(unique)) {
        return unique;
      }
    }
  };

  for (const name of names) {
    const shortName = makeUnique(baseCandidate(name));
    used.add(shortName);
    output.set(name, shortName);
  }

  return output;
}

function buildReverseToolNameMap(originalRequest: Record<string, unknown>): Map<string, string> {
  const toolNames: string[] = [];
  for (const tool of asArray<Record<string, unknown>>(originalRequest.tools)) {
    if (tool.type !== "function" || !isRecord(tool.function) || typeof tool.function.name !== "string") {
      continue;
    }
    toolNames.push(tool.function.name);
  }

  const shortMap = buildShortNameMap(toolNames);
  const reverse = new Map<string, string>();
  for (const [original, short] of shortMap.entries()) {
    reverse.set(short, original);
  }
  return reverse;
}

function normalizeBuiltinToolType(type: string): string {
  switch (type) {
    case "web_search_preview":
    case "web_search_preview_2025_03_11":
      return "web_search";
    default:
      return type;
  }
}

export function translateOpenAiChatToCodex(rawBody: Record<string, unknown>, modelName: string, stream: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    instructions: "",
    stream,
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    model: modelName,
    store: false,
    reasoning: {
      effort: typeof rawBody.reasoning_effort === "string" ? rawBody.reasoning_effort : "medium",
      summary: "auto"
    },
    input: []
  };

  const toolNames: string[] = [];
  for (const tool of asArray<Record<string, unknown>>(rawBody.tools)) {
    if (tool.type !== "function" || !isRecord(tool.function) || typeof tool.function.name !== "string") {
      continue;
    }
    toolNames.push(tool.function.name);
  }
  const shortNameMap = buildShortNameMap(toolNames);

  for (const message of asArray<Record<string, unknown>>(rawBody.messages)) {
    const role = typeof message.role === "string" ? message.role : "";

    if (role === "tool") {
      const contentValue = typeof message.content === "string" ? message.content : "";
      (out.input as unknown[]).push({
        type: "function_call_output",
        call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
        output: contentValue
      });
      continue;
    }

    const outputRole = role === "system" ? "developer" : role;
    const contentParts: Array<Record<string, unknown>> = [];
    const content = message.content;

    if (typeof content === "string" && content !== "") {
      contentParts.push({
        type: role === "assistant" ? "output_text" : "input_text",
        text: content
      });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part) || typeof part.type !== "string") {
          continue;
        }
        switch (part.type) {
          case "text":
            if (typeof part.text === "string") {
              contentParts.push({
                type: role === "assistant" ? "output_text" : "input_text",
                text: part.text
              });
            }
            break;
          case "image_url":
            if (role === "user" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
              contentParts.push({
                type: "input_image",
                image_url: part.image_url.url
              });
            }
            break;
          case "file":
            if (role === "user" && isRecord(part.file) && typeof part.file.file_data === "string") {
              const item: Record<string, unknown> = {
                type: "input_file",
                file_data: part.file.file_data
              };
              if (typeof part.file.filename === "string" && part.file.filename) {
                item.filename = part.file.filename;
              }
              contentParts.push(item);
            }
            break;
          default:
            break;
        }
      }
    }

    if (role !== "assistant" || contentParts.length > 0) {
      (out.input as unknown[]).push({
        type: "message",
        role: outputRole,
        content: contentParts
      });
    }

    if (role === "assistant") {
      for (const toolCall of asArray<Record<string, unknown>>(message.tool_calls)) {
        if (toolCall.type !== "function" || !isRecord(toolCall.function)) {
          continue;
        }
        const originalName = typeof toolCall.function.name === "string" ? toolCall.function.name : "";
        const shortenedName = shortNameMap.get(originalName) || shortenNameIfNeeded(originalName);
        (out.input as unknown[]).push({
          type: "function_call",
          call_id: typeof toolCall.id === "string" ? toolCall.id : "",
          name: shortenedName,
          arguments: typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : ""
        });
      }
    }
  }

  if (isRecord(rawBody.response_format)) {
    const responseFormat = rawBody.response_format;
    const text: Record<string, unknown> = {};
    if (responseFormat.type === "text") {
      text.format = { type: "text" };
    } else if (responseFormat.type === "json_schema" && isRecord(responseFormat.json_schema)) {
      text.format = {
        type: "json_schema",
        ...(responseFormat.json_schema.name ? { name: responseFormat.json_schema.name } : {}),
        ...(responseFormat.json_schema.strict !== undefined ? { strict: responseFormat.json_schema.strict } : {}),
        ...(responseFormat.json_schema.schema ? { schema: responseFormat.json_schema.schema } : {})
      };
    }
    if (isRecord(rawBody.text) && rawBody.text.verbosity !== undefined) {
      text.verbosity = rawBody.text.verbosity;
    }
    if (Object.keys(text).length > 0) {
      out.text = text;
    }
  } else if (isRecord(rawBody.text) && rawBody.text.verbosity !== undefined) {
    out.text = { verbosity: rawBody.text.verbosity };
  }

  const toolsOut: unknown[] = [];
  for (const tool of asArray<Record<string, unknown>>(rawBody.tools)) {
    if (tool.type !== "function") {
      if (typeof tool.type === "string") {
        toolsOut.push({
          ...tool,
          type: normalizeBuiltinToolType(tool.type)
        });
      }
      continue;
    }
    if (!isRecord(tool.function)) {
      continue;
    }
    const originalName = typeof tool.function.name === "string" ? tool.function.name : "";
    const shortenedName = shortNameMap.get(originalName) || shortenNameIfNeeded(originalName);
    toolsOut.push({
      type: "function",
      name: shortenedName,
      ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
      ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
      ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {})
    });
  }
  if (toolsOut.length > 0) {
    out.tools = toolsOut;
  }

  if (typeof rawBody.tool_choice === "string") {
    out.tool_choice = rawBody.tool_choice;
  } else if (isRecord(rawBody.tool_choice)) {
    if (rawBody.tool_choice.type === "function" && isRecord(rawBody.tool_choice.function)) {
      const originalName = typeof rawBody.tool_choice.function.name === "string" ? rawBody.tool_choice.function.name : "";
      const shortenedName = shortNameMap.get(originalName) || shortenNameIfNeeded(originalName);
      out.tool_choice = {
        type: "function",
        ...(shortenedName ? { name: shortenedName } : {})
      };
    } else if (typeof rawBody.tool_choice.type === "string") {
      out.tool_choice = {
        ...rawBody.tool_choice,
        type: normalizeBuiltinToolType(rawBody.tool_choice.type)
      };
    }
  }

  return out;
}

export function translateOpenAiResponsesToCodex(rawBody: Record<string, unknown>, modelName: string, stream: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(rawBody);

  if (typeof out.input === "string") {
    out.input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: out.input }]
      }
    ];
  }

  out.model = modelName;
  out.stream = stream;
  out.parallel_tool_calls = true;
  if (typeof out.instructions !== "string") {
    out.instructions = "";
  }

  delete out.max_output_tokens;
  delete out.max_completion_tokens;
  delete out.temperature;
  delete out.top_p;
  delete out.user;
  delete out.truncation;
  delete out.context_management;
  delete out.store;
  delete out.include;

  if (out.service_tier !== "priority") {
    delete out.service_tier;
  }

  if (Array.isArray(out.input)) {
    out.input = out.input.map((item) => {
      if (!isRecord(item)) {
        return item;
      }
      if (item.role === "system") {
        return { ...item, role: "developer" };
      }
      return item;
    });
  }

  if (Array.isArray(out.tools)) {
    out.tools = out.tools.map((tool) => {
      if (!isRecord(tool) || typeof tool.type !== "string") {
        return tool;
      }
      return { ...tool, type: normalizeBuiltinToolType(tool.type) };
    });
  }

  if (isRecord(out.tool_choice) && typeof out.tool_choice.type === "string") {
    out.tool_choice = {
      ...out.tool_choice,
      type: normalizeBuiltinToolType(out.tool_choice.type)
    };
  }

  return out;
}

export function translateCodexCompletedToOpenAiChat(event: Record<string, unknown>, originalRequest: Record<string, unknown>): Record<string, unknown> {
  const response = isRecord(event.response) ? event.response : {};
  const output = asArray<Record<string, unknown>>(response.output);
  const reverseToolNames = buildReverseToolNameMap(originalRequest);

  let contentText: string | undefined;
  let reasoningText: string | undefined;
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const item of output) {
    switch (item.type) {
      case "reasoning": {
        for (const summaryItem of asArray<Record<string, unknown>>(item.summary)) {
          if (summaryItem.type === "summary_text" && typeof summaryItem.text === "string") {
            reasoningText = summaryItem.text;
            break;
          }
        }
        break;
      }
      case "message": {
        for (const contentItem of asArray<Record<string, unknown>>(item.content)) {
          if (contentItem.type === "output_text" && typeof contentItem.text === "string") {
            contentText = contentItem.text;
            break;
          }
        }
        break;
      }
      case "function_call": {
        const rawName = typeof item.name === "string" ? item.name : "";
        toolCalls.push({
          id: typeof item.call_id === "string" ? item.call_id : "",
          type: "function",
          function: {
            name: reverseToolNames.get(rawName) || rawName,
            arguments: typeof item.arguments === "string" ? item.arguments : ""
          }
        });
        break;
      }
      default:
        break;
    }
  }

  const usage = isRecord(response.usage) ? response.usage : {};
  const outputTokensDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const inputTokensDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};

  return {
    id: typeof response.id === "string" ? response.id : "",
    object: "chat.completion",
    created: typeof response.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1000),
    model: typeof response.model === "string" ? response.model : "",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: contentText ?? null,
          reasoning_content: reasoningText ?? null,
          tool_calls: toolCalls.length > 0 ? toolCalls : null
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        native_finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
      }
    ],
    usage: {
      prompt_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      completion_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
      prompt_tokens_details: {
        cached_tokens: typeof inputTokensDetails.cached_tokens === "number" ? inputTokensDetails.cached_tokens : 0
      },
      completion_tokens_details: {
        reasoning_tokens: typeof outputTokensDetails.reasoning_tokens === "number" ? outputTokensDetails.reasoning_tokens : 0
      }
    }
  };
}

export function createInitialChatStreamState(modelName: string): ChatStreamState {
  return {
    responseId: "",
    createdAt: 0,
    model: modelName,
    functionCallIndex: -1,
    hasReceivedArgumentsDelta: false,
    hasToolCallAnnounced: false
  };
}

export function translateCodexStreamLineToOpenAiChat(
  line: string,
  state: ChatStreamState,
  originalRequest: Record<string, unknown>,
  requestedModel: string
): Array<Record<string, unknown>> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return [];
  }

  const payload = trimmed.slice(5).trim();
  if (payload === "" || payload === "[DONE]") {
    return [];
  }

  const event = JSON.parse(payload) as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";
  const reverseToolNames = buildReverseToolNameMap(originalRequest);

  if (type === "response.created" && isRecord(event.response)) {
    state.responseId = typeof event.response.id === "string" ? event.response.id : "";
    state.createdAt = typeof event.response.created_at === "number" ? event.response.created_at : 0;
    state.model = typeof event.response.model === "string" ? event.response.model : requestedModel;
    return [];
  }

  const template = {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: state.createdAt,
    model: state.model || requestedModel,
    choices: [
      {
        index: 0,
        delta: {} as Record<string, unknown>,
        finish_reason: null as string | null,
        native_finish_reason: null as string | null
      }
    ]
  };

  switch (type) {
    case "response.reasoning_summary_text.delta":
      if (typeof event.delta === "string") {
        template.choices[0].delta.role = "assistant";
        template.choices[0].delta.reasoning_content = event.delta;
        return [template];
      }
      return [];
    case "response.reasoning_summary_text.done":
      template.choices[0].delta.role = "assistant";
      template.choices[0].delta.reasoning_content = "\n\n";
      return [template];
    case "response.output_text.delta":
      if (typeof event.delta === "string") {
        template.choices[0].delta.role = "assistant";
        template.choices[0].delta.content = event.delta;
        return [template];
      }
      return [];
    case "response.output_item.added":
      if (!isRecord(event.item) || event.item.type !== "function_call") {
        return [];
      }
      state.functionCallIndex += 1;
      state.hasReceivedArgumentsDelta = false;
      state.hasToolCallAnnounced = true;
      template.choices[0].delta.role = "assistant";
      template.choices[0].delta.tool_calls = [
        {
          index: state.functionCallIndex,
          id: typeof event.item.call_id === "string" ? event.item.call_id : "",
          type: "function",
          function: {
            name: reverseToolNames.get(typeof event.item.name === "string" ? event.item.name : "") ||
              (typeof event.item.name === "string" ? event.item.name : ""),
            arguments: ""
          }
        }
      ];
      return [template];
    case "response.function_call_arguments.delta":
      state.hasReceivedArgumentsDelta = true;
      template.choices[0].delta.tool_calls = [
        {
          index: state.functionCallIndex,
          function: {
            arguments: typeof event.delta === "string" ? event.delta : ""
          }
        }
      ];
      return [template];
    case "response.function_call_arguments.done":
      if (state.hasReceivedArgumentsDelta) {
        return [];
      }
      template.choices[0].delta.tool_calls = [
        {
          index: state.functionCallIndex,
          function: {
            arguments: typeof event.arguments === "string" ? event.arguments : ""
          }
        }
      ];
      return [template];
    case "response.output_item.done":
      if (!isRecord(event.item) || event.item.type !== "function_call") {
        return [];
      }
      if (state.hasToolCallAnnounced) {
        state.hasToolCallAnnounced = false;
        return [];
      }
      state.functionCallIndex += 1;
      template.choices[0].delta.role = "assistant";
      template.choices[0].delta.tool_calls = [
        {
          index: state.functionCallIndex,
          id: typeof event.item.call_id === "string" ? event.item.call_id : "",
          type: "function",
          function: {
            name: reverseToolNames.get(typeof event.item.name === "string" ? event.item.name : "") ||
              (typeof event.item.name === "string" ? event.item.name : ""),
            arguments: typeof event.item.arguments === "string" ? event.item.arguments : ""
          }
        }
      ];
      return [template];
    case "response.completed":
      template.choices[0].finish_reason = state.functionCallIndex >= 0 ? "tool_calls" : "stop";
      template.choices[0].native_finish_reason = template.choices[0].finish_reason;
      return [template];
    default:
      return [];
  }
}
