import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { buildOpenAiError, errorMessage, HttpError } from "./errors.js";
import { CodexProxyService, type ForwardResponse } from "./service.js";
import { attachResponsesWebSocketHandler } from "./responses-websocket.js";
import { CodexManagementApi } from "./management.js";

interface CreateApiServerOptions {
  managementCallbackPort?: number;
}

export function createApiServer(service: CodexProxyService, options: CreateApiServerOptions = {}) {
  const managementApi = new CodexManagementApi(service, options.managementCallbackPort);
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(service, managementApi, req, res);
    } catch (error) {
      await writeJson(res, error instanceof HttpError ? error.statusCode : 500, buildOpenAiError(
        error instanceof HttpError ? error.statusCode : 500,
        errorMessage(error)
      ));
    }
  });
  attachResponsesWebSocketHandler(server, service);
  server.on("close", () => {
    void managementApi.close();
  });
  return server;
}

async function handleRequest(
  service: CodexProxyService,
  managementApi: CodexManagementApi,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", "http://localhost");

  if (method === "GET" && url.pathname === "/") {
    await writeJson(res, 200, {
      message: "CLIProxyAPI TypeScript",
      supported_providers: ["chatgpt", "codex"],
      endpoints: [
        "GET /v1/models",
        "GET /v1/responses (WebSocket)",
        "POST /v1/chat/completions",
        "POST /v1/responses",
        "POST /v1/responses/compact",
        "GET /v0/management/auth-files",
        "GET /v0/management/codex-auth-url"
      ]
    });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/models") {
    await writeJson(res, 200, {
      object: "list",
      data: service.listModels().map((model) => ({
        id: model.id,
        object: model.object,
        created: model.created,
        owned_by: model.owned_by
      }))
    });
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    await writeJson(res, 200, { status: "ok" });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/responses") {
    throw new HttpError(426, "Upgrade Required");
  }

  if (url.pathname.startsWith("/v0/management") || url.pathname === "/management.html" || url.pathname === "/codex/callback") {
    try {
      if (await managementApi.handleRequest(req, res, url)) {
        return;
      }
    } catch (error) {
      await writeManagementError(res, error);
      return;
    }
  }

  if (url.pathname.startsWith("/v1/") && ![
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/responses/compact",
    "/v1/models"
  ].includes(url.pathname)) {
    throw new HttpError(501, "This TypeScript port only supports ChatGPT/Codex OpenAI-compatible routes");
  }

  if (method !== "POST") {
    throw new HttpError(404, "Not found");
  }

  const body = await readJsonBody(req);
  const streamRequested = body.stream === true;
  const incomingHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      incomingHeaders.set(key, value);
    } else if (Array.isArray(value) && value.length > 0) {
      incomingHeaders.set(key, value.join(", "));
    }
  }

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  if (url.pathname === "/v1/chat/completions") {
    const response = await service.handleChatCompletions(body, streamRequested, abortController.signal, incomingHeaders);
    await writeResponse(res, response);
    return;
  }

  if (url.pathname === "/v1/responses") {
    const response = await service.handleResponses(body, streamRequested, abortController.signal, incomingHeaders);
    await writeResponse(res, response);
    return;
  }

  if (url.pathname === "/v1/responses/compact") {
    if (streamRequested) {
      throw new HttpError(400, "Streaming is not supported for compact responses");
    }
    const response = await service.handleCompactResponses(body, abortController.signal, incomingHeaders);
    await writeForwardResponse(res, response);
    return;
  }

  throw new HttpError(404, "Not found");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) {
    return {};
  }
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch (error) {
    throw new HttpError(400, `Invalid JSON body: ${errorMessage(error)}`);
  }
}

async function writeResponse(res: ServerResponse, response: Response | ForwardResponse): Promise<void> {
  if (response instanceof Response) {
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    if (!response.body) {
      res.end();
      return;
    }
    for await (const chunk of iterateReadableStream(response.body)) {
      res.write(chunk);
    }
    res.end();
    return;
  }

  await writeForwardResponse(res, response);
}

async function writeForwardResponse(res: ServerResponse, response: ForwardResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(Buffer.from(response.body));
}

async function writeJson(res: ServerResponse, statusCode: number, payload: unknown): Promise<void> {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

async function writeManagementError(res: ServerResponse, error: unknown): Promise<void> {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  await writeJson(res, statusCode, {
    status: "error",
    error: errorMessage(error)
  });
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
