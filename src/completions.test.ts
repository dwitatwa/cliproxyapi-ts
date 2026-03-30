import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { saveConfig, type AppConfig } from "./config.js";
import { createApiServer } from "./server.js";
import { CodexProxyService } from "./service.js";

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate port");
  }
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

test("v1/completions adapts chat output into legacy completion shape", async () => {
  const authDir = await mkdtemp(path.join(tmpdir(), "codexproxy-completions-"));
  const port = await getAvailablePort();
  const config: AppConfig = {
    configPath: path.join(authDir, "config.yaml"),
    configFormat: "yaml",
    host: "127.0.0.1",
    port,
    authDir,
    proxyUrl: undefined,
    requestRetry: 0,
    managementKey: undefined,
    allowRemoteManagement: false,
    debug: false,
    requestLog: false,
    usageStatisticsEnabled: true,
    loggingToFile: false,
    quotaExceededSwitchProject: false,
    quotaExceededSwitchPreviewModel: false,
    forceModelPrefix: undefined,
    oauthExcludedModels: {},
    oauthModelAlias: {},
    codexApiKey: [{
      "api-key": "api-key-1",
      "base-url": "https://chatgpt.com/backend-api/codex",
      priority: 100
    }]
  };
  await saveConfig(config);
  const service = await CodexProxyService.create(config);
  const server = createApiServer(service);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://chatgpt.com/backend-api/codex/")) {
      return new Response(
        [
          'data: {"type":"response.created","response":{"id":"resp_1","created_at":1700000000,"model":"gpt-5"}}',
          'data: {"type":"response.completed","response":{"id":"resp_1","created_at":1700000000,"model":"gpt-5","status":"completed","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5},"output":[{"type":"message","content":[{"type":"output_text","text":"Hello from completions"}]}]}}',
          "data: [DONE]"
        ].join("\n\n"),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream"
          }
        }
      );
    }
    return originalFetch(input, init);
  };

  try {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");

    const response = await originalFetch(`http://127.0.0.1:${port}/v1/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5",
        prompt: "Say hello"
      })
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as Record<string, unknown>;
    assert.equal(payload.object, "text_completion");
    assert.equal((payload.choices as Array<Record<string, unknown>>)[0].text, "Hello from completions");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(authDir, { recursive: true, force: true });
  }
});
