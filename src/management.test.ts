import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createApiServer } from "./server.js";
import { CodexProxyService } from "./service.js";
import type { AppConfig } from "./config.js";

function buildUnsignedJwt(payload: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

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

async function startTestServer(authDir: string, callbackPort: number) {
  const port = await getAvailablePort();
  const config: AppConfig = {
    host: "127.0.0.1",
    port,
    authDir,
    requestRetry: 0,
    codexApiKey: []
  };
  const service = await CodexProxyService.create(config);
  const server = createApiServer(service, { managementCallbackPort: callbackPort });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    service,
    server,
    baseUrl: `http://127.0.0.1:${port}`
  };
}

async function stopTestServer(server: ReturnType<typeof createApiServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test("management auth-file routes update disk state and live models", async () => {
  const authDir = await mkdtemp(path.join(tmpdir(), "cliproxyapi-ts-management-"));
  const callbackPort = await getAvailablePort();
  const { server, baseUrl } = await startTestServer(authDir, callbackPort);
  const fileName = "codex-user@example.com-plus.json";
  const idToken = buildUnsignedJwt({
    email: "user@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "plus"
    }
  });

  try {
    let response = await fetch(`${baseUrl}/v1/models`);
    assert.equal(response.status, 200);
    const emptyModels = await response.json() as { data: unknown[] };
    assert.equal(emptyModels.data.length, 0);

    response = await fetch(`${baseUrl}/v0/management/auth-files?name=${encodeURIComponent(fileName)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        type: "codex",
        email: "user@example.com",
        account_id: "acct_123",
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: idToken,
        expired: "2026-04-09T13:59:01.852Z",
        last_refresh: "2026-03-30T13:59:01.852Z"
      })
    });
    assert.equal(response.status, 200);

    response = await fetch(`${baseUrl}/v1/models`);
    const liveModels = await response.json() as { data: Array<{ id: string }> };
    assert.ok(liveModels.data.some((model) => model.id === "gpt-5"));

    response = await fetch(`${baseUrl}/v0/management/auth-files/fields`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: fileName,
        prefix: "team",
        priority: 7,
        note: "primary account"
      })
    });
    assert.equal(response.status, 200);

    response = await fetch(`${baseUrl}/v0/management/auth-files/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: fileName,
        disabled: true
      })
    });
    assert.equal(response.status, 200);

    response = await fetch(`${baseUrl}/v0/management/auth-files`);
    assert.equal(response.status, 200);
    const listed = await response.json() as { files: Array<Record<string, unknown>> };
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].name, fileName);
    assert.equal(listed.files[0].prefix, "team");
    assert.equal(listed.files[0].priority, 7);
    assert.equal(listed.files[0].note, "primary account");
    assert.equal(listed.files[0].disabled, true);

    response = await fetch(`${baseUrl}/v0/management/auth-files/models?name=${encodeURIComponent(fileName)}`);
    assert.equal(response.status, 200);
    const models = await response.json() as { models: Array<{ id: string }> };
    assert.ok(models.models.some((model: { id: string }) => model.id === "gpt-5"));

    response = await fetch(`${baseUrl}/v0/management/auth-files?name=${encodeURIComponent(fileName)}`, {
      method: "DELETE"
    });
    assert.equal(response.status, 200);

    response = await fetch(`${baseUrl}/v0/management/auth-files`);
    const afterDelete = await response.json() as { files: unknown[] };
    assert.equal(afterDelete.files.length, 0);

    response = await fetch(`${baseUrl}/v1/models`);
    const emptyAfterDelete = await response.json() as { data: unknown[] };
    assert.equal(emptyAfterDelete.data.length, 0);
  } finally {
    await stopTestServer(server);
    await rm(authDir, { recursive: true, force: true });
  }
});

test("management codex auth-url creates a pending oauth session", async () => {
  const authDir = await mkdtemp(path.join(tmpdir(), "cliproxyapi-ts-oauth-"));
  const callbackPort = await getAvailablePort();
  const { server, baseUrl } = await startTestServer(authDir, callbackPort);

  try {
    let response = await fetch(`${baseUrl}/v0/management/codex-auth-url`);
    assert.equal(response.status, 200);
    const authUrlResponse = await response.json() as { status: string; state: string; url: string };
    assert.equal(authUrlResponse.status, "ok");
    assert.match(authUrlResponse.state, /^[A-Za-z0-9._-]+$/);
    assert.match(authUrlResponse.url, new RegExp(`redirect_uri=${encodeURIComponent(`http://localhost:${callbackPort}/auth/callback`)}`));

    response = await fetch(`${baseUrl}/v0/management/get-auth-status?state=${encodeURIComponent(authUrlResponse.state)}`);
    assert.equal(response.status, 200);
    let statusPayload = await response.json() as { status: string; error?: string };
    assert.equal(statusPayload.status, "wait");

    response = await fetch(`${baseUrl}/v0/management/oauth-callback`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        provider: "codex",
        state: authUrlResponse.state,
        error: "access_denied"
      })
    });
    assert.equal(response.status, 400);
    const callbackPayload = await response.json() as { status: string; error: string };
    assert.equal(callbackPayload.status, "error");
    assert.equal(callbackPayload.error, "access_denied");

    response = await fetch(`${baseUrl}/v0/management/get-auth-status?state=${encodeURIComponent(authUrlResponse.state)}`);
    assert.equal(response.status, 200);
    statusPayload = await response.json() as { status: string; error?: string };
    assert.equal(statusPayload.status, "error");
    assert.equal(statusPayload.error, "access_denied");
  } finally {
    await stopTestServer(server);
    await rm(authDir, { recursive: true, force: true });
  }
});
