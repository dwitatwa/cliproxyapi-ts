import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitialChatStreamState,
  translateCodexCompletedToOpenAiChat,
  translateCodexStreamLineToOpenAiChat,
  translateOpenAiChatToCodex,
  translateOpenAiResponsesToCodex
} from "./codex.js";

test("translateOpenAiChatToCodex maps tool calls and system role", () => {
  const body = {
    model: "gpt-5",
    messages: [
      { role: "system", content: "Be direct." },
      { role: "user", content: "ping" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "very_long_tool_name_that_should_still_map_back_cleanly_in_the_response",
              arguments: "{\"x\":1}"
            }
          }
        ]
      }
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "very_long_tool_name_that_should_still_map_back_cleanly_in_the_response",
          parameters: { type: "object" }
        }
      }
    ]
  };

  const translated = translateOpenAiChatToCodex(body, "gpt-5", true);
  const input = translated.input as Array<Record<string, unknown>>;

  assert.equal(translated.model, "gpt-5");
  assert.equal(translated.stream, true);
  assert.equal(input[0].role, "developer");
  assert.equal(input[2].type, "function_call");
  assert.notEqual(input[2].name, body.tools[0].function.name);
});

test("translateOpenAiResponsesToCodex rewrites input string and normalizes system role", () => {
  const translated = translateOpenAiResponsesToCodex(
    {
      model: "gpt-5",
      input: "hello",
      user: "abc",
      tool_choice: { type: "web_search_preview" }
    },
    "gpt-5",
    true
  );

  assert.equal(translated.stream, true);
  assert.equal(translated.instructions, "");
  assert.equal(Array.isArray(translated.input), true);
  assert.equal((translated.input as Array<Record<string, unknown>>)[0].role, "user");
  assert.equal((translated.tool_choice as Record<string, unknown>).type, "web_search");
  assert.equal("user" in translated, false);
  assert.equal("store" in translated, false);
  assert.equal("include" in translated, false);
});

test("translateCodexCompletedToOpenAiChat emits tool calls and usage", () => {
  const completed = translateCodexCompletedToOpenAiChat(
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        created_at: 1700000000,
        model: "gpt-5.4",
        status: "completed",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 4 }
        },
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "tool_a",
            arguments: "{\"ok\":true}"
          }
        ]
      }
    },
    {
      tools: [
        {
          type: "function",
          function: {
            name: "tool_a"
          }
        }
      ]
    }
  );

  assert.equal(completed.id, "resp_1");
  assert.equal((completed.choices as Array<Record<string, unknown>>)[0].finish_reason, "tool_calls");
  assert.equal((completed.usage as Record<string, unknown>).total_tokens, 30);
});

test("translateCodexStreamLineToOpenAiChat emits finish chunk", () => {
  const state = createInitialChatStreamState("gpt-5");
  translateCodexStreamLineToOpenAiChat(
    'data: {"type":"response.created","response":{"id":"resp_1","created_at":1700000000,"model":"gpt-5.4"}}',
    state,
    {},
    "gpt-5"
  );
  const chunks = translateCodexStreamLineToOpenAiChat(
    'data: {"type":"response.completed"}',
    state,
    {},
    "gpt-5"
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].id, "resp_1");
  assert.equal((chunks[0].choices as Array<Record<string, unknown>>)[0].finish_reason, "stop");
});
