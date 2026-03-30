import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "./errors.js";
import { normalizeResponsesWebSocketRequest } from "./responses-websocket.js";

test("normalizeResponsesWebSocketRequest converts initial response.create into a streaming request", () => {
  const normalized = normalizeResponsesWebSocketRequest(
    {
      type: "response.create",
      model: "gpt-5",
      input: []
    },
    null,
    []
  );

  assert.equal(normalized.type, undefined);
  assert.equal(normalized.stream, true);
  assert.equal(normalized.model, "gpt-5");
  assert.deepEqual(normalized.input, []);
});

test("normalizeResponsesWebSocketRequest merges append input with prior request and response output", () => {
  const normalized = normalizeResponsesWebSocketRequest(
    {
      type: "response.append",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }]
    },
    {
      model: "gpt-5",
      instructions: "",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] }]
    },
    [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }]
  );

  assert.equal(normalized.stream, true);
  assert.equal(normalized.model, "gpt-5");
  assert.equal(Array.isArray(normalized.input), true);
  assert.equal((normalized.input as unknown[]).length, 3);
});

test("normalizeResponsesWebSocketRequest expands follow-up requests into a merged transcript", () => {
  const normalized = normalizeResponsesWebSocketRequest(
    {
      type: "response.append",
      previous_response_id: "resp_123",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }]
    },
    {
      model: "gpt-5",
      instructions: "",
      input: []
    },
    [{ type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "one" }] }]
  );

  assert.equal(normalized.previous_response_id, undefined);
  assert.equal(Array.isArray(normalized.input), true);
  assert.equal((normalized.input as unknown[]).length, 2);
});

test("normalizeResponsesWebSocketRequest rejects append before create", () => {
  assert.throws(
    () => normalizeResponsesWebSocketRequest(
      {
        type: "response.append",
        input: []
      },
      null,
      []
    ),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});
