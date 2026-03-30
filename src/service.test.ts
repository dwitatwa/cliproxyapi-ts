import assert from "node:assert/strict";
import test from "node:test";
import { buildUpstreamUrl, looksLikeHtmlResponse } from "./service.js";

test("buildUpstreamUrl preserves the backend-api/codex base path", () => {
  const url = buildUpstreamUrl("https://chatgpt.com/backend-api/codex", "/responses/compact");
  assert.equal(url.toString(), "https://chatgpt.com/backend-api/codex/responses/compact");
});

test("buildUpstreamUrl accepts endpoints without a leading slash", () => {
  const url = buildUpstreamUrl("https://chatgpt.com/backend-api/codex/", "responses");
  assert.equal(url.toString(), "https://chatgpt.com/backend-api/codex/responses");
});

test("looksLikeHtmlResponse detects ChatGPT website fallbacks", () => {
  const response = new Response("<!DOCTYPE html><html></html>", {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8"
    }
  });
  assert.equal(looksLikeHtmlResponse(response), true);
});

test("looksLikeHtmlResponse ignores JSON API responses", () => {
  const response = new Response("{}", {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
  assert.equal(looksLikeHtmlResponse(response), false);
});
