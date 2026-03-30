import type { IncomingMessage } from "node:http";
import { URL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { buildOpenAiError, errorMessage, HttpError } from "./errors.js";
import { CodexProxyService } from "./service.js";

const wsServer = new WebSocketServer({ noServer: true });

const REQUEST_TYPE_CREATE = "response.create";
const REQUEST_TYPE_APPEND = "response.append";
const RESPONSE_COMPLETED = "response.completed";

interface WebsocketSessionState {
  lastRequest: Record<string, unknown> | null;
  lastResponseOutput: unknown[];
  queue: Promise<void>;
  activeAbortController: AbortController | null;
}

export function attachResponsesWebSocketHandler(
  server: import("node:http").Server,
  service: CodexProxyService
): void {
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/v1/responses" || !isWebSocketUpgrade(req)) {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(req, socket, head, (ws) => {
      void handleResponsesWebSocketConnection(service, ws, req);
    });
  });
}

async function handleResponsesWebSocketConnection(
  service: CodexProxyService,
  ws: WebSocket,
  req: IncomingMessage
): Promise<void> {
  const state: WebsocketSessionState = {
    lastRequest: null,
    lastResponseOutput: [],
    queue: Promise.resolve(),
    activeAbortController: null
  };

  ws.on("message", (raw) => {
    state.queue = state.queue
      .then(() => handleWebSocketMessage(service, ws, req, state, raw))
      .catch(async (error: unknown) => {
        if (ws.readyState === ws.OPEN) {
          await sendWebSocketError(ws, error);
        }
      });
  });

  ws.on("close", () => {
    state.activeAbortController?.abort();
  });

  ws.on("error", () => {
    state.activeAbortController?.abort();
  });
}

async function handleWebSocketMessage(
  service: CodexProxyService,
  ws: WebSocket,
  req: IncomingMessage,
  state: WebsocketSessionState,
  raw: RawData
): Promise<void> {
  const request = parseWebSocketJson(raw);
  const normalized = normalizeResponsesWebSocketRequest(request, state.lastRequest, state.lastResponseOutput);

  if (shouldHandleSyntheticPrewarm(request, state.lastRequest)) {
    state.lastRequest = structuredClone(normalized);
    for (const payload of syntheticPrewarmPayloads(normalized)) {
      await sendJsonFrame(ws, payload);
    }
    state.lastResponseOutput = [];
    return;
  }
  state.lastRequest = structuredClone(normalized);

  const incomingHeaders = buildIncomingHeaders(req);
  const abortController = new AbortController();
  state.activeAbortController = abortController;

  try {
    const response = await service.handleResponses(
      normalized,
      true,
      abortController.signal,
      incomingHeaders
    );

    if (!(response instanceof Response)) {
      throw new HttpError(500, "Responses websocket expected a streaming response");
    }

    let completed = false;
    let completedOutput: unknown[] = [];
    for await (const payload of iterateResponseEventPayloads(response)) {
      if (typeof payload.type === "string" && payload.type === RESPONSE_COMPLETED) {
        completed = true;
        completedOutput = readCompletedOutput(payload);
      }
      await sendJsonFrame(ws, payload);
    }

    if (!completed) {
      throw new HttpError(408, "stream closed before response.completed");
    }
    state.lastResponseOutput = completedOutput;
  } finally {
    if (state.activeAbortController === abortController) {
      state.activeAbortController = null;
    }
  }
}

function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return (req.headers.upgrade || "").toLowerCase() === "websocket";
}

function parseWebSocketJson(raw: RawData): Record<string, unknown> {
  const text = raw instanceof Buffer ? raw.toString("utf8") : String(raw);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("WebSocket payload must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new HttpError(400, `Invalid websocket JSON: ${errorMessage(error)}`);
  }
}

export function normalizeResponsesWebSocketRequest(
  raw: Record<string, unknown>,
  lastRequest: Record<string, unknown> | null,
  lastResponseOutput: unknown[]
): Record<string, unknown> {
  const requestType = typeof raw.type === "string" ? raw.type.trim() : "";
  switch (requestType) {
    case REQUEST_TYPE_CREATE:
      if (!lastRequest) {
        return normalizeCreateRequest(raw);
      }
      return normalizeSubsequentRequest(raw, lastRequest, lastResponseOutput);
    case REQUEST_TYPE_APPEND:
      return normalizeSubsequentRequest(raw, lastRequest, lastResponseOutput);
    default:
      throw new HttpError(400, `unsupported websocket request type: ${requestType || "<missing>"}`);
  }
}

function normalizeCreateRequest(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(raw);
  delete normalized.type;
  normalized.stream = true;
  if (!Array.isArray(normalized.input)) {
    normalized.input = [];
  }
  const model = typeof normalized.model === "string" ? normalized.model.trim() : "";
  if (!model) {
    throw new HttpError(400, "missing model in response.create request");
  }
  return normalized;
}

function normalizeSubsequentRequest(
  raw: Record<string, unknown>,
  lastRequest: Record<string, unknown> | null,
  lastResponseOutput: unknown[]
): Record<string, unknown> {
  if (!lastRequest) {
    throw new HttpError(400, "websocket request received before response.create");
  }
  if (!Array.isArray(raw.input)) {
    throw new HttpError(400, "websocket request requires array field: input");
  }

  const normalized = structuredClone(raw);
  delete normalized.type;
  normalized.stream = true;

  if (typeof normalized.model !== "string" || !normalized.model.trim()) {
    normalized.model = lastRequest.model;
  }
  if (!Object.hasOwn(normalized, "instructions") && Object.hasOwn(lastRequest, "instructions")) {
    normalized.instructions = lastRequest.instructions;
  }
  delete normalized.previous_response_id;
  normalized.input = [
    ...asArray(lastRequest.input),
    ...normalizeResponseOutputForInput(lastResponseOutput),
    ...raw.input
  ];
  return normalized;
}

function shouldHandleSyntheticPrewarm(
  raw: Record<string, unknown>,
  lastRequest: Record<string, unknown> | null
): boolean {
  return (
    !lastRequest &&
    raw.type === REQUEST_TYPE_CREATE &&
    raw.generate === false
  );
}

function syntheticPrewarmPayloads(request: Record<string, unknown>): Array<Record<string, unknown>> {
  const responseId = `resp_prewarm_${crypto.randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const modelName = typeof request.model === "string" ? request.model.trim() : "";

  const createdPayload: Record<string, unknown> = {
    type: "response.created",
    sequence_number: 0,
    response: {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status: "in_progress",
      background: false,
      error: null,
      output: [],
      ...(modelName ? { model: modelName } : {})
    }
  };

  const completedPayload: Record<string, unknown> = {
    type: RESPONSE_COMPLETED,
    sequence_number: 1,
    response: {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status: "completed",
      background: false,
      error: null,
      output: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      },
      ...(modelName ? { model: modelName } : {})
    }
  };

  return [createdPayload, completedPayload];
}

async function* iterateResponseEventPayloads(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of iterateReadableStream(response.body)) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const eventBlock = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const payload of parseEventBlock(eventBlock)) {
        yield payload;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  const finalBlock = buffer.trim();
  if (finalBlock) {
    for (const payload of parseEventBlock(finalBlock)) {
      yield payload;
    }
  }
}

function parseEventBlock(block: string): Array<Record<string, unknown>> {
  const payloads: Array<Record<string, unknown>> = [];
  const lines = block.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    const parsed = JSON.parse(data) as unknown;
    if (isRecord(parsed)) {
      payloads.push(parsed);
    }
  }
  return payloads;
}

function readCompletedOutput(payload: Record<string, unknown>): unknown[] {
  if (isRecord(payload.response) && Array.isArray(payload.response.output)) {
    return structuredClone(payload.response.output);
  }
  return [];
}

function normalizeResponseOutputForInput(output: unknown[]): unknown[] {
  const normalized: unknown[] = [];
  for (const item of output) {
    if (!isRecord(item) || typeof item.type !== "string") {
      continue;
    }
    switch (item.type) {
      case "message":
        if (typeof item.role !== "string" || !Array.isArray(item.content)) {
          continue;
        }
        normalized.push({
          type: "message",
          role: item.role,
          content: item.content.map((part) => {
            if (!isRecord(part)) {
              return part;
            }
            const cleanPart = { ...part };
            delete cleanPart.annotations;
            delete cleanPart.logprobs;
            return cleanPart;
          })
        });
        break;
      case "function_call":
        normalized.push({
          type: "function_call",
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments
        });
        break;
      default:
        break;
    }
  }
  return normalized;
}

async function sendJsonFrame(ws: WebSocket, payload: Record<string, unknown>): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(payload), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function sendWebSocketError(ws: WebSocket, error: unknown): Promise<void> {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const payload = {
    type: "error",
    status: statusCode,
    ...buildOpenAiError(statusCode, errorMessage(error))
  };
  await sendJsonFrame(ws, payload);
}

function buildIncomingHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value) && value.length > 0) {
      headers.set(key, value.join(", "));
    }
  }
  return headers;
}

async function* iterateReadableStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? structuredClone(value) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
