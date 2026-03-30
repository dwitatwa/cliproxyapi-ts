import path from "node:path";
import { randomUUID } from "node:crypto";
import { readCodexAuthFiles, type AppConfig, type CodexKeyConfig, type RawAuthFile } from "./config.js";
import { HttpError } from "./errors.js";
import { getPlanModels, type ModelInfo } from "./models.js";
import {
  parseCodexIdTokenClaims,
  refreshCodexToken,
  writeCodexTokenFile,
  type CodexSavedTokenFile
} from "./auth/codex.js";
import {
  createInitialChatStreamState,
  translateCodexCompletedToOpenAiChat,
  translateCodexStreamLineToOpenAiChat,
  translateOpenAiChatToCodex,
  translateOpenAiResponsesToCodex
} from "./translators/codex.js";

interface ResolvedModelAlias {
  visibleId: string;
  upstreamName: string;
}

interface Credential {
  id: string;
  label: string;
  source: "api_key" | "oauth";
  token: string;
  baseUrl: string;
  priority: number;
  prefix: string;
  headers: Record<string, string>;
  excludedModels: Set<string>;
  planType: string;
  modelAliases: ResolvedModelAlias[];
  dynamicModelAliases: boolean;
  filePath?: string;
  email?: string;
  accountId?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: string;
}

interface Selection {
  credential: Credential;
  upstreamModel: string;
}

export interface ForwardResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export class CodexProxyService {
  private readonly config: AppConfig;
  private readonly credentials: Credential[];
  private readonly roundRobinOffsets = new Map<string, number>();
  private readonly refreshInFlight = new Map<string, Promise<void>>();

  private constructor(config: AppConfig, credentials: Credential[]) {
    this.config = config;
    this.credentials = credentials;
  }

  static async create(config: AppConfig): Promise<CodexProxyService> {
    const credentials = await buildCredentials(config);
    if (credentials.length === 0) {
      throw new HttpError(500, "No ChatGPT/Codex credentials configured");
    }
    return new CodexProxyService(config, credentials);
  }

  get host(): string {
    return this.config.host;
  }

  get port(): number {
    return this.config.port;
  }

  listModels(): ModelInfo[] {
    const models = new Map<string, ModelInfo>();
    for (const credential of this.credentials) {
      for (const alias of credential.modelAliases) {
        if (credential.excludedModels.has(alias.visibleId.toLowerCase()) || credential.excludedModels.has(alias.upstreamName.toLowerCase())) {
          continue;
        }
        if (!models.has(alias.visibleId.toLowerCase())) {
          models.set(alias.visibleId.toLowerCase(), buildModelInfo(alias.visibleId, alias.upstreamName, credential.planType));
        }
      }
    }
    return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async handleChatCompletions(
    body: Record<string, unknown>,
    stream: boolean,
    abortSignal: AbortSignal,
    incomingHeaders: Headers
  ): Promise<Response | ForwardResponse> {
    const requestedModel = readRequiredModel(body);
    const selection = this.selectCredential(requestedModel);
    const upstreamBody = translateOpenAiChatToCodex(body, selection.upstreamModel, true);
    const upstream = await this.fetchUpstream(selection, "/responses", upstreamBody, true, abortSignal, incomingHeaders);

    if (stream) {
      const state = createInitialChatStreamState(requestedModel);
      const encoder = new TextEncoder();
      const originalRequest = structuredClone(body);
      const readable = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          try {
            for await (const line of iterateSseDataLines(upstream)) {
              const chunks = translateCodexStreamLineToOpenAiChat(line, state, originalRequest, requestedModel);
              for (const chunk of chunks) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        }
      });

      return new Response(readable, {
        status: 200,
        headers: new Headers({
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        })
      });
    }

    const completed = await collectCompletedResponseEvent(upstream);
    const payload = translateCodexCompletedToOpenAiChat(completed, body);
    return jsonForwardResponse(payload);
  }

  async handleResponses(
    body: Record<string, unknown>,
    stream: boolean,
    abortSignal: AbortSignal,
    incomingHeaders: Headers
  ): Promise<Response | ForwardResponse> {
    const requestedModel = readRequiredModel(body);
    const selection = this.selectCredential(requestedModel);
    const upstreamBody = translateOpenAiResponsesToCodex(body, selection.upstreamModel, true);
    upstreamBody.store = false;
    const upstream = await this.fetchUpstream(selection, "/responses", upstreamBody, true, abortSignal, incomingHeaders);

    if (stream) {
      const responseHeaders = new Headers({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      return new Response(upstream.body, { status: 200, headers: responseHeaders });
    }

    const completed = await collectCompletedResponseEvent(upstream);
    if (!isRecord(completed.response)) {
      throw new HttpError(502, "Codex upstream returned an invalid response.completed payload");
    }
    return jsonForwardResponse(completed.response);
  }

  async handleCompactResponses(
    body: Record<string, unknown>,
    abortSignal: AbortSignal,
    incomingHeaders: Headers
  ): Promise<ForwardResponse> {
    const requestedModel = readRequiredModel(body);
    const selection = this.selectCredential(requestedModel);
    const upstreamBody = translateOpenAiResponsesToCodex(body, selection.upstreamModel, false);
    delete upstreamBody.stream;
    const upstream = await this.fetchUpstream(selection, "/responses/compact", upstreamBody, false, abortSignal, incomingHeaders);
    const buffer = await upstream.arrayBuffer();
    return {
      status: upstream.status,
      headers: upstream.headers,
      body: new Uint8Array(buffer)
    };
  }

  private selectCredential(requestedModel: string): Selection {
    const key = requestedModel.trim().toLowerCase();
    const candidates = this.credentials
      .map((credential) => {
        const upstreamModel = resolveRequestedModel(credential, requestedModel);
        return upstreamModel ? { credential, upstreamModel } : null;
      })
      .filter((item): item is Selection => item !== null)
      .sort((left, right) => right.credential.priority - left.credential.priority || left.credential.id.localeCompare(right.credential.id));

    if (candidates.length === 0) {
      throw new HttpError(404, `Model not found: ${requestedModel}`);
    }

    const highestPriority = candidates[0].credential.priority;
    const top = candidates.filter((item) => item.credential.priority === highestPriority);
    const offset = this.roundRobinOffsets.get(key) ?? 0;
    const selected = top[offset % top.length];
    this.roundRobinOffsets.set(key, (offset + 1) % top.length);
    return selected;
  }

  private async fetchUpstream(
    selection: Selection,
    endpoint: string,
    body: Record<string, unknown>,
    stream: boolean,
    abortSignal: AbortSignal,
    incomingHeaders: Headers
  ): Promise<Response> {
    await this.ensureCredentialReady(selection.credential);
    const url = buildUpstreamUrl(selection.credential.baseUrl, endpoint);
    const headers = buildUpstreamHeaders(selection.credential, stream, incomingHeaders);
    let response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abortSignal
    });

    if (response.status === 401 && selection.credential.source === "oauth" && selection.credential.refreshToken) {
      await this.forceRefreshCredential(selection.credential);
      const retryHeaders = buildUpstreamHeaders(selection.credential, stream, incomingHeaders);
      response = await fetch(url, {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(body),
        signal: abortSignal
      });
    }

    if (!response.ok) {
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      throw new HttpError(response.status, extractErrorMessage(parsed, text), parsed);
    }
    if (looksLikeHtmlResponse(response)) {
      const text = await response.clone().text();
      throw new HttpError(
        502,
        "Codex upstream returned HTML instead of API JSON; check the upstream path and credential",
        {
          content_type: response.headers.get("content-type"),
          preview: text.slice(0, 200)
        }
      );
    }
    return response;
  }

  private async ensureCredentialReady(credential: Credential): Promise<void> {
    if (credential.source !== "oauth" || !credential.refreshToken) {
      return;
    }
    if (!shouldRefreshCredential(credential.expiresAt)) {
      return;
    }
    await this.forceRefreshCredential(credential);
  }

  private async forceRefreshCredential(credential: Credential): Promise<void> {
    const existing = this.refreshInFlight.get(credential.id);
    if (existing) {
      await existing;
      return;
    }
    const task = this.refreshCredential(credential).finally(() => {
      this.refreshInFlight.delete(credential.id);
    });
    this.refreshInFlight.set(credential.id, task);
    await task;
  }

  private async refreshCredential(credential: Credential): Promise<void> {
    if (!credential.refreshToken) {
      return;
    }
    const refreshed = await refreshCodexToken(credential.refreshToken);
    applySavedTokenToCredential(credential, refreshed);
    if (credential.filePath) {
      credential.filePath = await writeCodexTokenFile(path.dirname(credential.filePath), refreshed);
    }
  }
}

function buildModelInfo(visibleId: string, upstreamName: string, planType: string): ModelInfo {
  const staticModel = getPlanModels(planType).find((item) => item.id === upstreamName);
  if (!staticModel) {
    return {
      id: visibleId,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "openai",
      type: "openai",
      display_name: upstreamName
    };
  }
  return {
    ...staticModel,
    id: visibleId,
    display_name: upstreamName
  };
}

function resolveRequestedModel(credential: Credential, requestedModel: string): string | undefined {
  const key = requestedModel.trim().toLowerCase();
  for (const alias of credential.modelAliases) {
    if (alias.visibleId.toLowerCase() === key) {
      return alias.upstreamName;
    }
  }
  return undefined;
}

async function buildCredentials(config: AppConfig): Promise<Credential[]> {
  const credentials: Credential[] = [];

  config.codexApiKey.forEach((entry, index) => {
    const token = (entry["api-key"] || "").trim();
    if (!token) {
      return;
    }
    credentials.push({
      id: `config-codex-${index + 1}`,
      label: "codex-apikey",
      source: "api_key",
      token,
      baseUrl: (entry["base-url"] || "https://chatgpt.com/backend-api/codex").trim(),
      priority: typeof entry.priority === "number" ? entry.priority : 0,
      prefix: (entry.prefix || "").trim(),
      headers: normalizeHeaders(entry.headers),
      excludedModels: new Set(normalizeExcludedModels(entry["excluded-models"])),
      planType: "pro",
      modelAliases: buildModelAliases((entry.models || []).map((model) => ({
        name: (model.name || "").trim(),
        alias: (model.alias || "").trim()
      })), (entry.prefix || "").trim(), "pro"),
      dynamicModelAliases: (entry.models || []).length === 0
    });
  });

  for (const { filePath, auth } of await readCodexAuthFiles(config.authDir)) {
    const credential = credentialFromAuthFile(filePath, auth);
    if (credential) {
      credentials.push(credential);
    }
  }

  return credentials;
}

function credentialFromAuthFile(filePath: string, auth: RawAuthFile): Credential | undefined {
  const attributes = auth.attributes || {};
  const metadata = auth.metadata || {};
  const token = typeof attributes.api_key === "string" && attributes.api_key.trim()
    ? attributes.api_key.trim()
    : typeof metadata.access_token === "string" && metadata.access_token.trim()
      ? metadata.access_token.trim()
      : typeof auth.access_token === "string" && auth.access_token.trim()
        ? auth.access_token.trim()
      : "";

  if (!token) {
    return undefined;
  }

  const prefix = (auth.prefix || "").trim();
  const planType = readPlanType(attributes, metadata, auth);
  const refreshToken = typeof metadata.refresh_token === "string" && metadata.refresh_token.trim()
    ? metadata.refresh_token.trim()
    : typeof auth.refresh_token === "string" && auth.refresh_token.trim()
      ? auth.refresh_token.trim()
      : undefined;
  const idToken = typeof metadata.id_token === "string" && metadata.id_token.trim()
    ? metadata.id_token.trim()
    : typeof auth.id_token === "string" && auth.id_token.trim()
      ? auth.id_token.trim()
      : undefined;
  const email = typeof metadata.email === "string" && metadata.email.trim()
    ? metadata.email.trim()
    : typeof auth.email === "string" && auth.email.trim()
      ? auth.email.trim()
      : undefined;
  const accountId = typeof metadata.account_id === "string" && metadata.account_id.trim()
    ? metadata.account_id.trim()
    : typeof auth.account_id === "string" && auth.account_id.trim()
      ? auth.account_id.trim()
      : undefined;
  const expiresAt = typeof metadata.expired === "string" && metadata.expired.trim()
    ? metadata.expired.trim()
    : typeof auth.expired === "string" && auth.expired.trim()
      ? auth.expired.trim()
      : undefined;

  return {
    id: auth.id || path.basename(filePath, path.extname(filePath)),
    label: auth.label || "codex-auth-file",
    source: typeof attributes.api_key === "string" && attributes.api_key.trim() ? "api_key" : "oauth",
    token,
    baseUrl: (attributes.base_url || "https://chatgpt.com/backend-api/codex").trim(),
    priority: Number.parseInt(attributes.priority || "0", 10) || 0,
    prefix,
    headers: extractCustomHeaders(attributes),
    excludedModels: new Set(splitCsv(attributes.excluded_models)),
    planType,
    modelAliases: buildModelAliases([], prefix, planType),
    dynamicModelAliases: true,
    filePath,
    email,
    accountId,
    refreshToken,
    idToken,
    expiresAt
  };
}

function readPlanType(attributes: Record<string, string>, metadata: Record<string, unknown>, auth: RawAuthFile): string {
  const direct = attributes.plan_type || attributes.chatgpt_plan_type;
  if (direct) {
    return direct.trim().toLowerCase();
  }
  if (typeof metadata.plan_type === "string" && metadata.plan_type.trim()) {
    return metadata.plan_type.trim().toLowerCase();
  }
  if (typeof metadata.chatgpt_plan_type === "string" && metadata.chatgpt_plan_type.trim()) {
    return metadata.chatgpt_plan_type.trim().toLowerCase();
  }
  const idToken = typeof metadata.id_token === "string" && metadata.id_token.trim()
    ? metadata.id_token.trim()
    : typeof auth.id_token === "string" && auth.id_token.trim()
      ? auth.id_token.trim()
      : "";
  const claims = idToken ? parseCodexIdTokenClaims(idToken) : null;
  const fromToken = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
  if (typeof fromToken === "string" && fromToken.trim()) {
    return fromToken.trim().toLowerCase();
  }
  return "pro";
}

function buildModelAliases(
  configModels: Array<{ name: string; alias: string }>,
  prefix: string,
  planType: string
): ResolvedModelAlias[] {
  const seen = new Set<string>();
  const models: ResolvedModelAlias[] = [];

  if (configModels.length > 0) {
    for (const model of configModels) {
      const upstreamName = model.name || model.alias;
      const visibleBase = model.alias || model.name;
      if (!upstreamName || !visibleBase) {
        continue;
      }
      const visibleId = prefix ? `${prefix}/${visibleBase}` : visibleBase;
      const key = visibleId.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      models.push({ visibleId, upstreamName });
    }
    return models;
  }

  for (const model of getPlanModels(planType)) {
    const visibleId = prefix ? `${prefix}/${model.id}` : model.id;
    const key = visibleId.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    models.push({ visibleId, upstreamName: model.id });
  }
  return models;
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  if (!headers) {
    return output;
  }
  for (const [key, value] of Object.entries(headers)) {
    const headerName = key.trim();
    const headerValue = value.trim();
    if (!headerName || !headerValue) {
      continue;
    }
    output[headerName] = headerValue;
  }
  return output;
}

function extractCustomHeaders(attributes: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!key.startsWith("header_")) {
      continue;
    }
    const headerName = key.slice("header_".length).replaceAll("_", "-").trim();
    if (!headerName || !value.trim()) {
      continue;
    }
    headers[headerName] = value.trim();
  }
  return headers;
}

function normalizeExcludedModels(excluded: string[] | undefined): string[] {
  if (!excluded) {
    return [];
  }
  return excluded.map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function readRequiredModel(body: Record<string, unknown>): string {
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) {
    throw new HttpError(400, "Missing required field: model");
  }
  return model;
}

function buildUpstreamHeaders(credential: Credential, stream: boolean, incomingHeaders: Headers): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${credential.token}`);
  headers.set("accept", stream ? "text/event-stream" : "application/json");
  headers.set("connection", "keep-alive");
  headers.set("session_id", incomingHeaders.get("session_id") || randomUUID());
  headers.set("user-agent", incomingHeaders.get("user-agent") || "codex_cli_rs/0.116.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464");
  if (incomingHeaders.get("originator")) {
    headers.set("originator", incomingHeaders.get("originator") as string);
  } else if (credential.source === "oauth") {
    headers.set("originator", "codex_cli_rs");
  }
  if (credential.source === "oauth" && credential.accountId) {
    headers.set("chatgpt-account-id", credential.accountId);
  }
  if (incomingHeaders.get("version")) {
    headers.set("version", incomingHeaders.get("version") as string);
  }
  if (incomingHeaders.get("x-client-request-id")) {
    headers.set("x-client-request-id", incomingHeaders.get("x-client-request-id") as string);
  }
  if (incomingHeaders.get("x-codex-turn-metadata")) {
    headers.set("x-codex-turn-metadata", incomingHeaders.get("x-codex-turn-metadata") as string);
  }
  for (const [key, value] of Object.entries(credential.headers)) {
    headers.set(key, value);
  }
  return headers;
}

export function buildUpstreamUrl(baseUrl: string, endpoint: string): URL {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  return new URL(normalizedEndpoint, normalizedBase);
}

export function looksLikeHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") || "";
  return /\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(contentType);
}

function shouldRefreshCredential(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return parsed - Date.now() <= 5 * 60 * 1000;
}

function applySavedTokenToCredential(credential: Credential, saved: CodexSavedTokenFile): void {
  credential.token = saved.access_token;
  credential.refreshToken = saved.refresh_token || credential.refreshToken;
  credential.idToken = saved.id_token;
  credential.email = saved.email;
  credential.accountId = saved.account_id;
  credential.expiresAt = saved.expired;

  const claims = parseCodexIdTokenClaims(saved.id_token);
  const planType = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type?.trim().toLowerCase() || credential.planType;
  if (planType !== credential.planType) {
    credential.planType = planType;
    if (credential.dynamicModelAliases) {
      credential.modelAliases = buildModelAliases([], credential.prefix, planType);
    }
  }
}

function extractErrorMessage(parsed: unknown, fallback: string): string {
  if (isRecord(parsed)) {
    if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
    if (typeof parsed.detail === "string") {
      return parsed.detail;
    }
  }
  return fallback || "Upstream request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function* iterateSseDataLines(response: Response): AsyncGenerator<string> {
  if (!response.body) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of iterateReadableStream(response.body)) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim() !== "") {
        yield line;
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  const finalLine = buffer.trim();
  if (finalLine) {
    yield finalLine;
  }
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

async function collectCompletedResponseEvent(response: Response): Promise<Record<string, unknown>> {
  let lastEventType = "";
  for await (const line of iterateSseDataLines(response)) {
    if (!line.trim().startsWith("data:")) {
      continue;
    }
    const payload = line.trim().slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    const event = JSON.parse(payload) as Record<string, unknown>;
    lastEventType = typeof event.type === "string" ? event.type : "";
    if (event.type === "response.completed") {
      if (isRecord(event.response) && isRecord(event.response.error)) {
        throw new HttpError(502, extractErrorMessage(event.response.error, "Codex upstream returned response.completed with error"), event);
      }
      return event;
    }
    if (event.type === "response.failed") {
      throw new HttpError(502, extractCodexTerminalError(event, "Codex upstream reported response.failed"), event);
    }
    if (event.type === "response.incomplete") {
      throw new HttpError(502, extractCodexTerminalError(event, "Codex upstream reported response.incomplete"), event);
    }
    if (event.type === "error") {
      throw new HttpError(502, extractCodexTerminalError(event, "Codex upstream reported error event"), event);
    }
  }
  if (lastEventType) {
    throw new HttpError(502, `Codex upstream closed after terminal event ${lastEventType} without response.completed`);
  }
  throw new HttpError(502, "Codex upstream closed before response.completed");
}

function jsonForwardResponse(payload: unknown): ForwardResponse {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body
  };
}

function extractCodexTerminalError(event: Record<string, unknown>, fallback: string): string {
  if (isRecord(event.response)) {
    if (isRecord(event.response.error)) {
      return extractErrorMessage(event.response.error, fallback);
    }
    if (typeof event.response.status === "string" && event.response.status.trim()) {
      const status = event.response.status.trim();
      if (isRecord(event.response.incomplete_details)) {
        return `${status}: ${extractErrorMessage(event.response.incomplete_details, fallback)}`;
      }
      return `${status}: ${fallback}`;
    }
  }
  if (isRecord(event.error)) {
    return extractErrorMessage(event.error, fallback);
  }
  return extractErrorMessage(event, fallback);
}
