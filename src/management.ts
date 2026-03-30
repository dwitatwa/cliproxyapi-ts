import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import {
  buildCodexAuthUrl,
  buildSavedTokenFile,
  exchangeCodeForTokens,
  generatePkceCodes,
  parseCodexIdTokenClaims,
  refreshCodexToken,
  writeCodexTokenFile,
  type PkceCodes,
  type CodexSavedTokenFile
} from "./auth/codex.js";
import {
  loadConfig,
  readConfigFileRaw,
  saveConfig,
  type AppConfig,
  type CodexKeyConfig,
  type CodexModelAliasConfig,
  type RawAuthFile
} from "./config.js";
import { HttpError, errorMessage } from "./errors.js";
import { getPlanModels } from "./models.js";
import { CodexProxyService } from "./service.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CODEX_CALLBACK_PORT = 1455;
const CALLBACK_SUCCESS_HTML = "<html><body><h1>Codex authentication complete</h1><p>You can close this window.</p></body></html>";

interface ManagedOAuthSession {
  provider: "codex";
  state: string;
  pkce: PkceCodes;
  redirectUri: string;
  error: string;
  expiresAt: number;
}

interface AuthFileEnvelope {
  name: string;
  auth: RawAuthFile;
}

interface UsageSnapshot {
  total_requests: number;
  failed_requests: number;
  per_path: Record<string, number>;
  per_model: Record<string, number>;
}

interface RequestRecord {
  id: string;
  method: string;
  path: string;
  status: number;
  started_at: string;
  duration_ms: number;
  model?: string;
  error?: string;
}

interface InFlightRequest {
  id: string;
  method: string;
  path: string;
  startedAt: number;
  model?: string;
  error?: string;
}

interface ApiCallCredential {
  authIndex: string;
  token?: string;
  proxyUrl?: string;
  fileName?: string;
  filePath?: string;
  auth?: RawAuthFile;
}

export class CodexManagementApi {
  private readonly sessions = new Map<string, ManagedOAuthSession>();
  private codexForwarder: HttpServer | null = null;
  private readonly recentRequests: RequestRecord[] = [];
  private readonly inFlightRequests = new Map<string, InFlightRequest>();
  private readonly usage: UsageSnapshot = {
    total_requests: 0,
    failed_requests: 0,
    per_path: {},
    per_model: {}
  };

  constructor(
    private readonly service: CodexProxyService,
    private readonly callbackPort = DEFAULT_CODEX_CALLBACK_PORT
  ) {}

  beginRequest(req: IncomingMessage, url: URL): string {
    const id = randomUUID();
    this.inFlightRequests.set(id, {
      id,
      method: req.method || "GET",
      path: url.pathname,
      startedAt: Date.now()
    });
    return id;
  }

  annotateRequest(id: string, values: { model?: string; error?: string }): void {
    const request = this.inFlightRequests.get(id);
    if (!request) {
      return;
    }
    if (values.model) {
      request.model = values.model;
    }
    if (values.error) {
      request.error = values.error;
    }
  }

  finishRequest(id: string, status: number): void {
    const request = this.inFlightRequests.get(id);
    if (!request) {
      return;
    }
    this.inFlightRequests.delete(id);
    const completed: RequestRecord = {
      id: request.id,
      method: request.method,
      path: request.path,
      status,
      started_at: new Date(request.startedAt).toISOString(),
      duration_ms: Date.now() - request.startedAt,
      ...(request.model ? { model: request.model } : {}),
      ...(request.error ? { error: request.error } : {})
    };
    if (this.service.runtimeConfig.requestLog) {
      this.recentRequests.unshift(completed);
      if (this.recentRequests.length > 200) {
        this.recentRequests.length = 200;
      }
    }
    if (this.service.runtimeConfig.usageStatisticsEnabled) {
      this.usage.total_requests += 1;
      if (status >= 400) {
        this.usage.failed_requests += 1;
      }
      this.usage.per_path[request.path] = (this.usage.per_path[request.path] || 0) + 1;
      if (request.model) {
        this.usage.per_model[request.model] = (this.usage.per_model[request.model] || 0) + 1;
      }
    }
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method === "GET" && url.pathname === "/codex/callback") {
      await this.handleCodexCallback(req, res, url);
      return true;
    }

    if (url.pathname === "/management.html") {
      this.assertAuthorized(req);
      await this.writeHtml(res, 200, this.renderManagementHtml());
      return true;
    }

    if (!url.pathname.startsWith("/v0/management")) {
      return false;
    }

    this.assertAuthorized(req);

    const method = req.method || "GET";
    if (method === "GET" && url.pathname === "/v0/management/config") {
      await this.writeJson(res, 200, this.publicConfig());
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/config.yaml") {
      await this.writeConfigYaml(res);
      return true;
    }

    if ((method === "PUT" || method === "PATCH") && url.pathname === "/v0/management/config.yaml") {
      await this.putConfigYaml(req, res);
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/latest-version") {
      await this.writeJson(res, 200, { "latest-version": await readPackageVersion() });
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/debug") {
      await this.writeJson(res, 200, { debug: this.service.runtimeConfig.debug });
      return true;
    }

    if ((method === "PUT" || method === "PATCH") && url.pathname === "/v0/management/debug") {
      await this.updateBooleanConfig(req, res, "debug", (value) => {
        this.service.runtimeConfig.debug = value;
      });
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/request-log") {
      await this.writeJson(res, 200, { "request-log": this.service.runtimeConfig.requestLog });
      return true;
    }

    if ((method === "PUT" || method === "PATCH") && url.pathname === "/v0/management/request-log") {
      await this.updateBooleanConfig(req, res, "request-log", (value) => {
        this.service.runtimeConfig.requestLog = value;
      });
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/request-retry") {
      await this.writeJson(res, 200, { "request-retry": this.service.runtimeConfig.requestRetry });
      return true;
    }

    if ((method === "PUT" || method === "PATCH") && url.pathname === "/v0/management/request-retry") {
      await this.updateIntegerConfig(req, res, "request-retry", (value) => {
        this.service.runtimeConfig.requestRetry = Math.max(0, value);
      });
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/proxy-url") {
      await this.writeJson(res, 200, { "proxy-url": this.service.runtimeConfig.proxyUrl || "" });
      return true;
    }

    if ((method === "PUT" || method === "PATCH") && url.pathname === "/v0/management/proxy-url") {
      await this.updateStringConfig(req, res, "proxy-url", (value) => {
        this.service.runtimeConfig.proxyUrl = value || undefined;
      });
      return true;
    }

    if (method === "DELETE" && url.pathname === "/v0/management/proxy-url") {
      this.service.runtimeConfig.proxyUrl = undefined;
      await this.persistConfig();
      await this.writeJson(res, 200, { status: "ok" });
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/usage") {
      await this.writeJson(res, 200, {
        usage: structuredClone(this.usage),
        failed_requests: this.usage.failed_requests
      });
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/usage/export") {
      await this.writeJson(res, 200, {
        version: 1,
        exported_at: new Date().toISOString(),
        usage: structuredClone(this.usage)
      });
      return true;
    }

    if (method === "POST" && url.pathname === "/v0/management/usage/import") {
      await this.importUsage(req, res);
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/logs") {
      await this.writeJson(res, 200, { logs: this.recentRequests });
      return true;
    }

    if (method === "POST" && url.pathname === "/v0/management/api-call") {
      await this.apiCall(req, res);
      return true;
    }

    if (method === "DELETE" && url.pathname === "/v0/management/logs") {
      this.recentRequests.length = 0;
      await this.writeJson(res, 200, { status: "ok" });
      return true;
    }

    if (method === "GET" && url.pathname.startsWith("/v0/management/request-log-by-id/")) {
      const id = decodeURIComponent(url.pathname.slice("/v0/management/request-log-by-id/".length));
      const match = this.recentRequests.find((entry) => entry.id === id);
      if (!match) {
        throw new HttpError(404, "request log not found");
      }
      await this.writeJson(res, 200, match);
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/quota-exceeded/switch-project") {
      await this.writeJson(res, 200, { value: this.service.runtimeConfig.quotaExceededSwitchProject });
      return true;
    }

    if ((method === "PUT" || method === "PATCH") && url.pathname === "/v0/management/quota-exceeded/switch-project") {
      await this.updateBooleanConfig(req, res, "value", (value) => {
        this.service.runtimeConfig.quotaExceededSwitchProject = value;
      });
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/quota-exceeded/switch-preview-model") {
      await this.writeJson(res, 200, { value: this.service.runtimeConfig.quotaExceededSwitchPreviewModel });
      return true;
    }

    if ((method === "PUT" || method === "PATCH") && url.pathname === "/v0/management/quota-exceeded/switch-preview-model") {
      await this.updateBooleanConfig(req, res, "value", (value) => {
        this.service.runtimeConfig.quotaExceededSwitchPreviewModel = value;
      });
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/codex-api-key") {
      await this.writeJson(res, 200, {
        "codex-api-key": this.service.runtimeConfig.codexApiKey.map((entry, index) => ({
          ...entry,
          auth_index: `codex-api-key:${index}`
        }))
      });
      return true;
    }

    if (method === "PUT" && url.pathname === "/v0/management/codex-api-key") {
      await this.putCodexKeys(req, res);
      return true;
    }

    if (method === "PATCH" && url.pathname === "/v0/management/codex-api-key") {
      await this.patchCodexKey(req, res);
      return true;
    }

    if (method === "DELETE" && url.pathname === "/v0/management/codex-api-key") {
      await this.deleteCodexKey(res, url);
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/oauth-excluded-models") {
      await this.writeJson(res, 200, { "oauth-excluded-models": this.service.runtimeConfig.oauthExcludedModels });
      return true;
    }

    if (method === "PUT" && url.pathname === "/v0/management/oauth-excluded-models") {
      await this.putOauthExcludedModels(req, res);
      return true;
    }

    if (method === "PATCH" && url.pathname === "/v0/management/oauth-excluded-models") {
      await this.patchOauthExcludedModels(req, res);
      return true;
    }

    if (method === "DELETE" && url.pathname === "/v0/management/oauth-excluded-models") {
      await this.deleteOauthExcludedModels(res, url);
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/oauth-model-alias") {
      await this.writeJson(res, 200, { "oauth-model-alias": this.service.runtimeConfig.oauthModelAlias });
      return true;
    }

    if (method === "PUT" && url.pathname === "/v0/management/oauth-model-alias") {
      await this.putOauthModelAlias(req, res);
      return true;
    }

    if (method === "PATCH" && url.pathname === "/v0/management/oauth-model-alias") {
      await this.patchOauthModelAlias(req, res);
      return true;
    }

    if (method === "DELETE" && url.pathname === "/v0/management/oauth-model-alias") {
      await this.deleteOauthModelAlias(res, url);
      return true;
    }

    if (method === "GET" && url.pathname.startsWith("/v0/management/model-definitions/")) {
      await this.getModelDefinitions(res, decodeURIComponent(url.pathname.slice("/v0/management/model-definitions/".length)));
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/auth-files") {
      await this.writeJson(res, 200, { files: await this.listAuthFiles() });
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/auth-files/models") {
      await this.writeJson(res, 200, { models: await this.listAuthFileModels(url.searchParams.get("name")) });
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/auth-files/download") {
      await this.downloadAuthFile(res, url.searchParams.get("name"));
      return true;
    }

    if (method === "POST" && url.pathname === "/v0/management/auth-files") {
      await this.uploadAuthFile(req, res, url);
      return true;
    }

    if (method === "DELETE" && url.pathname === "/v0/management/auth-files") {
      await this.deleteAuthFiles(req, res, url);
      return true;
    }

    if (method === "PATCH" && url.pathname === "/v0/management/auth-files/status") {
      await this.patchAuthFileStatus(req, res);
      return true;
    }

    if (method === "PATCH" && url.pathname === "/v0/management/auth-files/fields") {
      await this.patchAuthFileFields(req, res);
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/codex-auth-url") {
      await this.requestCodexAuthUrl(res);
      return true;
    }

    if (method === "POST" && url.pathname === "/v0/management/oauth-callback") {
      await this.postOAuthCallback(req, res);
      return true;
    }

    if (method === "GET" && url.pathname === "/v0/management/get-auth-status") {
      await this.getAuthStatus(res, url.searchParams.get("state"));
      return true;
    }

    throw new HttpError(501, "This management route is not implemented in the TypeScript port");
  }

  async close(): Promise<void> {
    await this.stopCodexForwarder();
  }

  private assertAuthorized(req: IncomingMessage): void {
    const config = this.service.runtimeConfig;
    const remoteAddress = req.socket.remoteAddress || "";
    if (!config.allowRemoteManagement && !isLocalAddress(remoteAddress)) {
      throw new HttpError(403, "remote management disabled");
    }

    const expected = (config.managementKey || "").trim();
    if (!expected) {
      return;
    }

    const provided = extractManagementKey(req);
    if (!provided) {
      throw new HttpError(401, "missing management key");
    }
    if (provided !== expected) {
      throw new HttpError(401, "invalid management key");
    }
  }

  private publicConfig(): Record<string, unknown> {
    const config = this.service.runtimeConfig;
    return {
      host: config.host,
      port: config.port,
      "auth-dir": config.authDir,
      "proxy-url": config.proxyUrl || "",
      "request-retry": config.requestRetry,
      debug: config.debug,
      "request-log": config.requestLog,
      "usage-statistics-enabled": config.usageStatisticsEnabled,
      "logging-to-file": config.loggingToFile,
      "allow-remote-management": config.allowRemoteManagement,
      "quota-exceeded-switch-project": config.quotaExceededSwitchProject,
      "quota-exceeded-switch-preview-model": config.quotaExceededSwitchPreviewModel,
      "force-model-prefix": config.forceModelPrefix || "",
      "oauth-excluded-models": config.oauthExcludedModels,
      "oauth-model-alias": config.oauthModelAlias,
      "codex-api-key": config.codexApiKey
    };
  }

  private async writeConfigYaml(res: ServerResponse): Promise<void> {
    const raw = await readConfigFileRaw(this.service.runtimeConfig.configPath);
    res.statusCode = 200;
    res.setHeader("content-type", "application/yaml; charset=utf-8");
    res.end(raw);
  }

  private async putConfigYaml(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readRawBody(req);
    await writeFile(this.service.runtimeConfig.configPath, body, "utf8");
    const nextConfig = await loadConfig(this.service.runtimeConfig.configPath);
    await this.service.applyConfig(nextConfig);
    await this.writeJson(res, 200, { ok: true, changed: ["config"] });
  }

  private async updateBooleanConfig(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    apply: (value: boolean) => void
  ): Promise<void> {
    const value = extractBooleanValue(await readJsonBody(req), key);
    apply(value);
    await this.persistConfig();
    await this.writeJson(res, 200, { ok: true });
  }

  private async updateIntegerConfig(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    apply: (value: number) => void
  ): Promise<void> {
    const body = await readJsonBody(req);
    const value = extractIntegerValue(body, key);
    apply(value);
    await this.persistConfig();
    await this.writeJson(res, 200, { ok: true });
  }

  private async updateStringConfig(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    apply: (value: string) => void
  ): Promise<void> {
    const body = await readJsonBody(req);
    const value = extractStringValue(body, key);
    apply(value);
    await this.persistConfig();
    await this.writeJson(res, 200, { ok: true });
  }

  private async importUsage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const incoming = body.usage;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      throw new HttpError(400, "invalid usage payload");
    }
    const usage = incoming as Record<string, unknown>;
    this.usage.total_requests += asNonNegativeInt(usage.total_requests);
    this.usage.failed_requests += asNonNegativeInt(usage.failed_requests);
    mergeCounterMap(this.usage.per_path, usage.per_path);
    mergeCounterMap(this.usage.per_model, usage.per_model);
    await this.writeJson(res, 200, {
      added: this.usage.total_requests,
      skipped: 0,
      total_requests: this.usage.total_requests,
      failed_requests: this.usage.failed_requests
    });
  }

  private async apiCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const method = typeof body.method === "string" ? body.method.trim().toUpperCase() : "";
    const urlString = typeof body.url === "string" ? body.url.trim() : "";
    if (!method) {
      throw new HttpError(400, "missing method");
    }
    if (!urlString) {
      throw new HttpError(400, "missing url");
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(urlString);
    } catch {
      throw new HttpError(400, "invalid url");
    }
    if (!targetUrl.protocol || !targetUrl.host) {
      throw new HttpError(400, "invalid url");
    }

    const authIndex = firstDefinedString(body.auth_index, body.authIndex, body.AuthIndex)?.trim() || "";
    const credential = await this.resolveApiCallCredential(authIndex);
    const token = credential ? await this.resolveTokenForApiCallCredential(credential) : "";

    const rawHeaders = body.header;
    const headers = rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)
      ? normalizeStringMap(rawHeaders as Record<string, unknown>)
      : {};
    for (const [key, value] of Object.entries(headers)) {
      if (value.includes("$TOKEN$")) {
        if (!token) {
          throw new HttpError(400, "auth token not found");
        }
        headers[key] = value.replaceAll("$TOKEN$", token);
      }
    }

    const data = typeof body.data === "string" ? body.data : "";
    const proxyUrl = credential?.proxyUrl?.trim() || this.service.runtimeConfig.proxyUrl?.trim() || "";
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

    const response = await undiciFetch(targetUrl, {
      method,
      headers,
      body: data || undefined,
      dispatcher
    });
    const responseBody = await response.text();
    const header: Record<string, string[]> = {};
    response.headers.forEach((value, key) => {
      header[key] = value.split(",").map((item) => item.trim()).filter(Boolean);
    });

    await this.writeJson(res, 200, {
      status_code: response.status,
      header,
      body: responseBody
    });
  }

  private async resolveApiCallCredential(authIndex: string): Promise<ApiCallCredential | null> {
    const trimmed = authIndex.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith("file:")) {
      const name = trimmed.slice("file:".length);
      const file = await this.readAuthFileByName(name);
      return {
        authIndex: trimmed,
        token: readAuthToken(file.auth),
        proxyUrl: file.auth.proxy_url || file.auth.attributes?.proxy_url || undefined,
        fileName: file.name,
        filePath: file.filePath,
        auth: file.auth
      };
    }

    if (trimmed.startsWith("codex-api-key:")) {
      const index = Number.parseInt(trimmed.slice("codex-api-key:".length), 10);
      if (!Number.isInteger(index) || index < 0 || index >= this.service.runtimeConfig.codexApiKey.length) {
        throw new HttpError(404, "auth credential not found");
      }
      const entry = this.service.runtimeConfig.codexApiKey[index];
      return {
        authIndex: trimmed,
        token: (entry["api-key"] || "").trim(),
        proxyUrl: (entry["proxy-url"] || "").trim() || undefined
      };
    }

    if (trimmed.toLowerCase().endsWith(".json")) {
      const file = await this.readAuthFileByName(trimmed);
      return {
        authIndex: `file:${file.name}`,
        token: readAuthToken(file.auth),
        proxyUrl: file.auth.proxy_url || file.auth.attributes?.proxy_url || undefined,
        fileName: file.name,
        filePath: file.filePath,
        auth: file.auth
      };
    }

    throw new HttpError(404, "auth credential not found");
  }

  private async resolveTokenForApiCallCredential(credential: ApiCallCredential): Promise<string> {
    if (!credential.auth) {
      return credential.token || "";
    }
    const auth = credential.auth;
    const token = readAuthToken(auth);
    const expiresAt = readTokenExpiry(auth);
    const refreshToken = readRefreshToken(auth);
    if (!refreshToken || !shouldRefreshToken(expiresAt)) {
      return token;
    }

    const refreshed = await refreshCodexToken(refreshToken);
    const merged = mergeSavedTokenIntoAuth(auth, refreshed);
    if (credential.fileName) {
      await this.writeAuthFile(credential.fileName, merged);
    }
    credential.auth = merged;
    credential.token = refreshed.access_token;
    return refreshed.access_token;
  }

  private async putCodexKeys(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readOptionalJsonBody(req);
    let items: CodexKeyConfig[];
    if (Array.isArray(body)) {
      items = body as CodexKeyConfig[];
    } else if (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).items)) {
      items = (body as Record<string, unknown>).items as CodexKeyConfig[];
    } else {
      throw new HttpError(400, "invalid body");
    }
    this.service.runtimeConfig.codexApiKey = items.filter(isCodexKeyConfig);
    await this.persistConfigAndReload();
    await this.writeJson(res, 200, { status: "ok" });
  }

  private async patchCodexKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const index = typeof body.index === "number" ? body.index : undefined;
    const match = typeof body.match === "string" ? body.match.trim() : "";
    const value = body.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(400, "invalid body");
    }
    let targetIndex = typeof index === "number" && Number.isInteger(index) ? index : -1;
    if (targetIndex < 0 && match) {
      targetIndex = this.service.runtimeConfig.codexApiKey.findIndex((entry) => (entry["api-key"] || "").trim() === match);
    }
    if (targetIndex < 0 || targetIndex >= this.service.runtimeConfig.codexApiKey.length) {
      throw new HttpError(404, "item not found");
    }
    const current = { ...this.service.runtimeConfig.codexApiKey[targetIndex] };
    const patch = value as Record<string, unknown>;
    if (patch["api-key"] !== undefined) {
      current["api-key"] = typeof patch["api-key"] === "string" ? patch["api-key"].trim() : "";
    }
    if (patch.prefix !== undefined) {
      current.prefix = typeof patch.prefix === "string" ? patch.prefix.trim() : "";
    }
    if (patch["base-url"] !== undefined) {
      const baseUrl = typeof patch["base-url"] === "string" ? patch["base-url"].trim() : "";
      if (!baseUrl) {
        this.service.runtimeConfig.codexApiKey.splice(targetIndex, 1);
        await this.persistConfigAndReload();
        await this.writeJson(res, 200, { status: "ok" });
        return;
      }
      current["base-url"] = baseUrl;
    }
    if (patch["proxy-url"] !== undefined) {
      current["proxy-url"] = typeof patch["proxy-url"] === "string" ? patch["proxy-url"].trim() : "";
    }
    if (patch.headers && typeof patch.headers === "object" && !Array.isArray(patch.headers)) {
      current.headers = normalizeStringMap(patch.headers as Record<string, unknown>);
    }
    if (Array.isArray(patch["excluded-models"])) {
      current["excluded-models"] = patch["excluded-models"].filter((item): item is string => typeof item === "string");
    }
    if (Array.isArray(patch.models)) {
      current.models = patch.models
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) => ({
          name: typeof item.name === "string" ? item.name.trim() : "",
          alias: typeof item.alias === "string" ? item.alias.trim() : ""
        }))
        .filter((item) => item.name || item.alias);
    }
    if (typeof patch.priority === "number" && Number.isInteger(patch.priority)) {
      current.priority = patch.priority;
    }
    this.service.runtimeConfig.codexApiKey[targetIndex] = current;
    await this.persistConfigAndReload();
    await this.writeJson(res, 200, { status: "ok" });
  }

  private async deleteCodexKey(res: ServerResponse, url: URL): Promise<void> {
    const apiKey = url.searchParams.get("api-key")?.trim() || "";
    const index = url.searchParams.get("index");
    if (apiKey) {
      this.service.runtimeConfig.codexApiKey = this.service.runtimeConfig.codexApiKey.filter((entry) => (entry["api-key"] || "").trim() !== apiKey);
    } else if (index) {
      const parsed = Number.parseInt(index, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed >= this.service.runtimeConfig.codexApiKey.length) {
        throw new HttpError(400, "missing api-key or index");
      }
      this.service.runtimeConfig.codexApiKey.splice(parsed, 1);
    } else {
      throw new HttpError(400, "missing api-key or index");
    }
    await this.persistConfigAndReload();
    await this.writeJson(res, 200, { status: "ok" });
  }

  private async putOauthExcludedModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readOptionalJsonBody(req);
    const items = body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).items
      ? (body as Record<string, unknown>).items
      : body;
    if (!items || typeof items !== "object" || Array.isArray(items)) {
      throw new HttpError(400, "invalid body");
    }
    this.service.runtimeConfig.oauthExcludedModels = normalizeExcludedModelsMap(items as Record<string, unknown>);
    await this.persistConfigAndReload();
    await this.writeJson(res, 200, { status: "ok" });
  }

  private async patchOauthExcludedModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const provider = expectString(body.provider, "provider").toLowerCase();
    const models = Array.isArray(body.models) ? body.models.filter((item): item is string => typeof item === "string") : [];
    if (models.length === 0) {
      delete this.service.runtimeConfig.oauthExcludedModels[provider];
    } else {
      this.service.runtimeConfig.oauthExcludedModels[provider] = [...new Set(models.map((item) => item.trim().toLowerCase()).filter(Boolean))];
    }
    await this.persistConfigAndReload();
    await this.writeJson(res, 200, { status: "ok" });
  }

  private async deleteOauthExcludedModels(res: ServerResponse, url: URL): Promise<void> {
    const provider = (url.searchParams.get("provider") || "").trim().toLowerCase();
    if (!provider) {
      throw new HttpError(400, "missing provider");
    }
    delete this.service.runtimeConfig.oauthExcludedModels[provider];
    await this.persistConfigAndReload();
    await this.writeJson(res, 200, { status: "ok" });
  }

  private async putOauthModelAlias(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readOptionalJsonBody(req);
    const items = body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).items
      ? (body as Record<string, unknown>).items
      : body;
    if (!items || typeof items !== "object" || Array.isArray(items)) {
      throw new HttpError(400, "invalid body");
    }
    this.service.runtimeConfig.oauthModelAlias = normalizeAliasMap(items as Record<string, unknown>);
    await this.persistConfigAndReload();
    await this.writeJson(res, 200, { status: "ok" });
  }

  private async patchOauthModelAlias(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const channel = expectString(body.channel ?? body.provider, "channel").toLowerCase();
    const aliases = Array.isArray(body.aliases) ? normalizeAliasEntries(body.aliases) : [];
    if (aliases.length === 0) {
      delete this.service.runtimeConfig.oauthModelAlias[channel];
    } else {
      this.service.runtimeConfig.oauthModelAlias[channel] = aliases;
    }
    await this.persistConfigAndReload();
    await this.writeJson(res, 200, { status: "ok" });
  }

  private async deleteOauthModelAlias(res: ServerResponse, url: URL): Promise<void> {
    const channel = ((url.searchParams.get("channel") || url.searchParams.get("provider")) || "").trim().toLowerCase();
    if (!channel) {
      throw new HttpError(400, "missing channel");
    }
    delete this.service.runtimeConfig.oauthModelAlias[channel];
    await this.persistConfigAndReload();
    await this.writeJson(res, 200, { status: "ok" });
  }

  private async getModelDefinitions(res: ServerResponse, channel: string): Promise<void> {
    if (channel.trim().toLowerCase() !== "codex") {
      throw new HttpError(404, "channel not found");
    }
    await this.writeJson(res, 200, {
      channel: "codex",
      models: getPlanModels("pro")
    });
  }

  private async persistConfig(): Promise<void> {
    await saveConfig(this.service.runtimeConfig);
  }

  private async persistConfigAndReload(): Promise<void> {
    await this.persistConfig();
    await this.service.reloadCredentials();
  }

  private renderManagementHtml(): string {
    const keyInfo = this.service.runtimeConfig.managementKey ? "Management key required." : "Localhost access allowed without a management key.";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CLIProxyAPI TS Management</title>
  <style>
    :root { color-scheme: light; --bg:#f5f1e8; --panel:#fffdf8; --ink:#1f2a1f; --muted:#6a6f64; --line:#d8d1c2; --accent:#0d6b52; }
    body { margin:0; font-family: Georgia, "Times New Roman", serif; background:linear-gradient(180deg,#efe8d8,#f7f4ec); color:var(--ink); }
    main { max-width:980px; margin:0 auto; padding:32px 20px 60px; }
    .hero { display:grid; gap:12px; margin-bottom:24px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:18px; padding:18px; margin-bottom:18px; box-shadow:0 10px 30px rgba(0,0,0,.05); }
    button { background:var(--accent); color:white; border:0; padding:10px 14px; border-radius:999px; cursor:pointer; }
    code, pre { font-family: "SFMono-Regular", Consolas, monospace; }
    pre { white-space:pre-wrap; background:#f3efe6; padding:12px; border-radius:12px; border:1px solid var(--line); }
    .muted { color:var(--muted); }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>CLIProxyAPI TS Management</h1>
      <p class="muted">Codex-only management panel. ${escapeHtml(keyInfo)}</p>
    </section>
    <section class="panel">
      <button id="login">Start Codex Login</button>
      <p id="login-state" class="muted"></p>
      <pre id="login-url"></pre>
    </section>
    <section class="panel">
      <h2>Auth Files</h2>
      <pre id="auth-files">Loading...</pre>
    </section>
    <section class="panel">
      <h2>Recent Requests</h2>
      <pre id="request-logs">Loading...</pre>
    </section>
  <script>
    async function refreshAuthFiles() {
      const res = await fetch('/v0/management/auth-files');
      document.getElementById('auth-files').textContent = JSON.stringify(await res.json(), null, 2);
    }
    async function refreshLogs() {
      const res = await fetch('/v0/management/logs');
      document.getElementById('request-logs').textContent = JSON.stringify(await res.json(), null, 2);
    }
    document.getElementById('login').addEventListener('click', async () => {
      const res = await fetch('/v0/management/codex-auth-url');
      const payload = await res.json();
      document.getElementById('login-url').textContent = payload.url || JSON.stringify(payload, null, 2);
      document.getElementById('login-state').textContent = payload.state ? 'State: ' + payload.state : 'Failed to start login';
      if (payload.url) window.open(payload.url, '_blank', 'noopener');
    });
    refreshAuthFiles();
    refreshLogs();
  </script>
</body>
</html>`;
  }

  private async requestCodexAuthUrl(res: ServerResponse): Promise<void> {
    const authDir = this.requireAuthDir();
    await mkdir(authDir, { recursive: true, mode: 0o700 });

    const pkce = generatePkceCodes();
    const state = createOAuthState();
    const redirectUri = `http://localhost:${this.callbackPort}/auth/callback`;

    this.registerSession({
      provider: "codex",
      state,
      pkce,
      redirectUri,
      error: "",
      expiresAt: Date.now() + OAUTH_SESSION_TTL_MS
    });

    await this.startCodexForwarder();
    await this.writeJson(res, 200, {
      status: "ok",
      url: buildCodexAuthUrl(state, redirectUri, pkce),
      state
    });
  }

  private async postOAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    if (provider !== "codex" && provider !== "openai") {
      throw new HttpError(400, "unsupported provider");
    }

    let state = typeof body.state === "string" ? body.state.trim() : "";
    let code = typeof body.code === "string" ? body.code.trim() : "";
    let oauthError = typeof body.error === "string" ? body.error.trim() : "";
    if (typeof body.redirect_url === "string" && body.redirect_url.trim()) {
      const redirectUrl = new URL(body.redirect_url);
      state ||= redirectUrl.searchParams.get("state")?.trim() || "";
      code ||= redirectUrl.searchParams.get("code")?.trim() || "";
      oauthError ||= redirectUrl.searchParams.get("error_description")?.trim()
        || redirectUrl.searchParams.get("error")?.trim()
        || "";
    }

    await this.finishCodexOAuth(state, code, oauthError);
    await this.writeJson(res, 200, { status: "ok" });
  }

  private async handleCodexCallback(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get("state")?.trim() || "";
    const code = url.searchParams.get("code")?.trim() || "";
    const oauthError = url.searchParams.get("error_description")?.trim()
      || url.searchParams.get("error")?.trim()
      || "";

    try {
      await this.finishCodexOAuth(state, code, oauthError);
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(CALLBACK_SUCCESS_HTML);
    } catch (error) {
      res.statusCode = error instanceof HttpError ? error.statusCode : 500;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<html><body><h1>Codex authentication failed</h1><p>${escapeHtml(errorMessage(error))}</p></body></html>`);
    }
  }

  private async finishCodexOAuth(state: string, code: string, oauthError: string): Promise<void> {
    validateOAuthState(state);
    const session = this.getSession(state);
    if (!session) {
      throw new HttpError(404, "unknown or expired state");
    }
    if (session.error) {
      throw new HttpError(409, "oauth flow is not pending");
    }
    if (oauthError) {
      this.setSessionError(state, oauthError);
      throw new HttpError(400, oauthError);
    }
    if (!code) {
      this.setSessionError(state, "Missing authorization code");
      throw new HttpError(400, "code or error is required");
    }

    try {
      const tokenResponse = await exchangeCodeForTokens(code, session.redirectUri, session.pkce);
      const saved = buildSavedTokenFile(tokenResponse);
      await this.persistCodexToken(saved);
      this.completeSession(state);
    } catch (error) {
      const message = errorMessage(error);
      this.setSessionError(state, message);
      throw error;
    } finally {
      await this.stopCodexForwarder();
    }
  }

  private async persistCodexToken(saved: CodexSavedTokenFile): Promise<void> {
    const authDir = this.requireAuthDir();
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    await writeCodexTokenFile(authDir, saved);
    await this.service.reloadCredentials();
  }

  private async getAuthStatus(res: ServerResponse, rawState: string | null): Promise<void> {
    const state = rawState?.trim() || "";
    if (!state) {
      await this.writeJson(res, 200, { status: "ok" });
      return;
    }
    validateOAuthState(state);
    const session = this.getSession(state);
    if (!session) {
      await this.writeJson(res, 200, { status: "ok" });
      return;
    }
    if (session.error) {
      await this.writeJson(res, 200, { status: "error", error: session.error });
      return;
    }
    await this.writeJson(res, 200, { status: "wait" });
  }

  private async listAuthFiles(): Promise<Record<string, unknown>[]> {
    const entries = await this.readManagedAuthFiles();
    return entries.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  }

  private async listAuthFileModels(rawName: string | null): Promise<Array<Record<string, unknown>>> {
    const file = await this.readAuthFileByName(rawName);
    const planType = readAuthPlanType(file.auth);
    return getPlanModels(planType).map((model) => ({
      id: model.id,
      display_name: model.display_name || model.id,
      owned_by: model.owned_by,
      type: model.type
    }));
  }

  private async downloadAuthFile(res: ServerResponse, rawName: string | null): Promise<void> {
    const { filePath, name } = await this.resolveAuthFile(rawName);
    const data = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("content-disposition", `attachment; filename="${name}"`);
    res.end(data);
  }

  private async uploadAuthFile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("multipart/form-data")) {
      throw new HttpError(501, "Multipart auth uploads are not implemented in the TypeScript port");
    }

    const body = await readJsonBody(req);
    const envelope = parseAuthFileUploadEnvelope(url.searchParams.get("name"), body);
    const filePath = this.resolveAuthFilePath(envelope.name);
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, `${JSON.stringify(envelope.auth, null, 2)}\n`, { mode: 0o600 });
    await this.service.reloadCredentials();
    await this.writeJson(res, 200, { status: "ok", file: envelope.name });
  }

  private async deleteAuthFiles(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const names = await readDeleteNames(req, url);
    if (url.searchParams.get("all") === "true" || url.searchParams.get("all") === "1" || url.searchParams.get("all") === "*") {
      const entries = await this.readManagedAuthFiles();
      for (const entry of entries) {
        await rm(this.resolveAuthFilePath(String(entry.name)), { force: true });
      }
      await this.service.reloadCredentials();
      await this.writeJson(res, 200, { status: "ok", deleted: entries.length });
      return;
    }
    if (names.length === 0) {
      throw new HttpError(400, "invalid name");
    }

    for (const name of names) {
      await rm(this.resolveAuthFilePath(name), { force: false });
    }
    await this.service.reloadCredentials();
    await this.writeJson(res, 200, {
      status: "ok",
      deleted: names.length,
      files: names
    });
  }

  private async patchAuthFileStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const name = expectString(body.name, "name");
    if (typeof body.disabled !== "boolean") {
      throw new HttpError(400, "disabled is required");
    }
    const authFile = await this.readAuthFileByName(name);
    authFile.auth.disabled = body.disabled;
    await this.writeAuthFile(authFile.name, authFile.auth);
    await this.writeJson(res, 200, { status: "ok", disabled: body.disabled });
  }

  private async patchAuthFileFields(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const name = expectString(body.name, "name");
    const authFile = await this.readAuthFileByName(name);
    const auth = authFile.auth;

    let changed = false;
    if (body.prefix !== undefined) {
      auth.prefix = asOptionalString(body.prefix);
      changed = true;
    }
    if (body.proxy_url !== undefined) {
      auth.proxy_url = asOptionalString(body.proxy_url);
      changed = true;
    }
    if (body.label !== undefined) {
      auth.label = asOptionalString(body.label);
      changed = true;
    }
    if (body.priority !== undefined) {
      applyPriority(auth, body.priority);
      changed = true;
    }
    if (body.note !== undefined) {
      applyNote(auth, body.note);
      changed = true;
    }

    if (!changed) {
      throw new HttpError(400, "no fields to update");
    }

    await this.writeAuthFile(authFile.name, auth);
    await this.writeJson(res, 200, { status: "ok" });
  }

  private async writeAuthFile(name: string, auth: RawAuthFile): Promise<void> {
    const normalized = normalizeManagedAuthFile(auth);
    const filePath = this.resolveAuthFilePath(name);
    await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await this.service.reloadCredentials();
  }

  private async readAuthFileByName(rawName: string | null): Promise<{ name: string; filePath: string; auth: RawAuthFile }> {
    const { filePath, name } = await this.resolveAuthFile(rawName);
    const raw = await readFile(filePath, "utf8");
    const auth = normalizeManagedAuthFile(parseRawAuthFile(raw));
    return { name, filePath, auth };
  }

  private async resolveAuthFile(rawName: string | null): Promise<{ filePath: string; name: string }> {
    const name = sanitizeAuthFileName(rawName || "");
    const filePath = this.resolveAuthFilePath(name);
    try {
      await stat(filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new HttpError(404, "file not found");
      }
      throw error;
    }
    return { filePath, name };
  }

  private resolveAuthFilePath(name: string): string {
    return path.join(this.requireAuthDir(), sanitizeAuthFileName(name));
  }

  private async readManagedAuthFiles(): Promise<Record<string, unknown>[]> {
    const authDir = this.requireAuthDir();
    let names: string[];
    try {
      names = await readdir(authDir);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const entries: Record<string, unknown>[] = [];
    for (const name of names.sort()) {
      if (!name.toLowerCase().endsWith(".json")) {
        continue;
      }
      const filePath = path.join(authDir, name);
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      let auth: RawAuthFile;
      try {
        auth = normalizeManagedAuthFile(parseRawAuthFile(raw));
      } catch {
        continue;
      }
      const provider = String(auth.provider || auth.type || "").trim().toLowerCase();
      if (provider && provider !== "codex") {
        continue;
      }
      const info = await stat(filePath);
      const claims = typeof auth.id_token === "string" ? parseCodexIdTokenClaims(auth.id_token) : null;
      const planType = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type?.trim() || readAuthPlanType(auth);
      const entry: Record<string, unknown> = {
        id: path.basename(name, path.extname(name)),
        auth_index: `file:${name}`,
        name,
        type: "codex",
        provider: "codex",
        source: "file",
        size: info.size,
        modtime: info.mtime.toISOString(),
        disabled: auth.disabled === true
      };
      if (auth.label) {
        entry.label = auth.label;
      }
      if (auth.email) {
        entry.email = auth.email;
      }
      if (auth.account_id) {
        entry.account_id = auth.account_id;
      }
      if (auth.prefix) {
        entry.prefix = auth.prefix;
      }
      const priority = readAuthPriority(auth);
      if (priority !== undefined) {
        entry.priority = priority;
      }
      const note = readAuthNote(auth);
      if (note) {
        entry.note = note;
      }
      if (auth.last_refresh) {
        entry.last_refresh = auth.last_refresh;
      }
      if (auth.expired) {
        entry.expired = auth.expired;
      }
      if (planType) {
        entry.id_token = {
          chatgpt_account_id: auth.account_id || claims?.["https://api.openai.com/auth"]?.chatgpt_account_id || "",
          plan_type: planType
        };
      }
      entries.push(entry);
    }
    return entries;
  }

  private registerSession(session: ManagedOAuthSession): void {
    this.purgeExpiredSessions();
    this.sessions.set(session.state, session);
  }

  private getSession(state: string): ManagedOAuthSession | undefined {
    this.purgeExpiredSessions();
    return this.sessions.get(state);
  }

  private setSessionError(state: string, error: string): void {
    const session = this.getSession(state);
    if (!session) {
      return;
    }
    session.error = error.trim() || "Authentication failed";
    session.expiresAt = Date.now() + OAUTH_SESSION_TTL_MS;
    this.sessions.set(state, session);
  }

  private completeSession(state: string): void {
    this.sessions.delete(state);
  }

  private purgeExpiredSessions(): void {
    const now = Date.now();
    for (const [state, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(state);
      }
    }
  }

  private async startCodexForwarder(): Promise<void> {
    await this.stopCodexForwarder();
    const targetBase = `http://127.0.0.1:${this.service.port}/codex/callback`;
    const server = createServer((req, res) => {
      const incoming = new URL(req.url || "/", `http://127.0.0.1:${this.callbackPort}`);
      const target = new URL(targetBase);
      target.search = incoming.search;
      res.statusCode = 302;
      res.setHeader("cache-control", "no-store");
      res.setHeader("location", target.toString());
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.callbackPort, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.codexForwarder = server;
  }

  private async stopCodexForwarder(): Promise<void> {
    if (!this.codexForwarder) {
      return;
    }
    const server = this.codexForwarder;
    this.codexForwarder = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private requireAuthDir(): string {
    const authDir = this.service.authDir?.trim();
    if (!authDir) {
      throw new HttpError(400, "This management API requires auth-dir in config");
    }
    return authDir;
  }

  private async writeJson(res: ServerResponse, statusCode: number, payload: unknown): Promise<void> {
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  }

  private async writeHtml(res: ServerResponse, statusCode: number, html: string): Promise<void> {
    res.statusCode = statusCode;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  }
}

function parseRawAuthFile(raw: string): RawAuthFile {
  const parsed = JSON.parse(raw) as RawAuthFile;
  const provider = String(parsed.provider || parsed.type || "").trim().toLowerCase();
  if (provider && provider !== "codex") {
    throw new HttpError(400, "This TypeScript port only supports Codex auth files");
  }
  return parsed;
}

function normalizeManagedAuthFile(auth: RawAuthFile): RawAuthFile {
  const out: RawAuthFile = { ...auth };
  out.type = "codex";
  out.provider = "codex";
  if (typeof out.email === "string") {
    out.email = out.email.trim();
  }
  if (typeof out.account_id === "string") {
    out.account_id = out.account_id.trim();
  }
  if (!out.attributes) {
    out.attributes = {};
  }
  if (!out.metadata) {
    out.metadata = {};
  }
  if (out.prefix) {
    out.prefix = out.prefix.trim();
  }
  if (out.label) {
    out.label = out.label.trim();
  }
  if (out.proxy_url) {
    out.proxy_url = out.proxy_url.trim();
  }
  if (typeof out.access_token === "string" && out.access_token.trim() && !out.metadata.access_token) {
    out.metadata.access_token = out.access_token.trim();
  }
  if (typeof out.refresh_token === "string" && out.refresh_token.trim() && !out.metadata.refresh_token) {
    out.metadata.refresh_token = out.refresh_token.trim();
  }
  if (typeof out.id_token === "string" && out.id_token.trim() && !out.metadata.id_token) {
    out.metadata.id_token = out.id_token.trim();
  }
  if (typeof out.email === "string" && out.email.trim() && !out.metadata.email) {
    out.metadata.email = out.email.trim();
  }
  if (typeof out.account_id === "string" && out.account_id.trim() && !out.metadata.account_id) {
    out.metadata.account_id = out.account_id.trim();
  }
  if (typeof out.expired === "string" && out.expired.trim() && !out.metadata.expired) {
    out.metadata.expired = out.expired.trim();
  }
  if (typeof out.last_refresh === "string" && out.last_refresh.trim() && !out.metadata.last_refresh) {
    out.metadata.last_refresh = out.last_refresh.trim();
  }
  return out;
}

function readAuthToken(auth: RawAuthFile): string {
  return typeof auth.attributes?.api_key === "string" && auth.attributes.api_key.trim()
    ? auth.attributes.api_key.trim()
    : typeof auth.metadata?.access_token === "string" && auth.metadata.access_token.trim()
      ? auth.metadata.access_token.trim()
      : typeof auth.access_token === "string" && auth.access_token.trim()
        ? auth.access_token.trim()
        : typeof auth.metadata?.token === "string" && auth.metadata.token.trim()
          ? auth.metadata.token.trim()
          : typeof auth.metadata?.id_token === "string" && auth.metadata.id_token.trim()
            ? auth.metadata.id_token.trim()
            : typeof auth.metadata?.cookie === "string" && auth.metadata.cookie.trim()
              ? auth.metadata.cookie.trim()
              : "";
}

function readRefreshToken(auth: RawAuthFile): string {
  return typeof auth.metadata?.refresh_token === "string" && auth.metadata.refresh_token.trim()
    ? auth.metadata.refresh_token.trim()
    : typeof auth.refresh_token === "string" && auth.refresh_token.trim()
      ? auth.refresh_token.trim()
      : "";
}

function readTokenExpiry(auth: RawAuthFile): string | undefined {
  return typeof auth.metadata?.expired === "string" && auth.metadata.expired.trim()
    ? auth.metadata.expired.trim()
    : typeof auth.expired === "string" && auth.expired.trim()
      ? auth.expired.trim()
      : undefined;
}

function shouldRefreshToken(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return parsed - Date.now() <= 5 * 60 * 1000;
}

function mergeSavedTokenIntoAuth(auth: RawAuthFile, saved: CodexSavedTokenFile): RawAuthFile {
  const merged = normalizeManagedAuthFile({
    ...auth,
    access_token: saved.access_token,
    refresh_token: saved.refresh_token,
    id_token: saved.id_token,
    account_id: saved.account_id,
    email: saved.email,
    expired: saved.expired,
    last_refresh: saved.last_refresh,
    metadata: {
      ...(auth.metadata || {}),
      access_token: saved.access_token,
      refresh_token: saved.refresh_token,
      id_token: saved.id_token,
      account_id: saved.account_id,
      email: saved.email,
      expired: saved.expired,
      last_refresh: saved.last_refresh
    }
  });
  return merged;
}

function parseAuthFileUploadEnvelope(queryName: string | null, body: Record<string, unknown>): AuthFileEnvelope {
  if (queryName?.trim()) {
    return {
      name: sanitizeAuthFileName(queryName),
      auth: normalizeManagedAuthFile(body as RawAuthFile)
    };
  }

  const name = typeof body.name === "string" ? sanitizeAuthFileName(body.name) : "";
  if (!name) {
    throw new HttpError(400, "name is required");
  }

  const candidate = body.auth ?? body.content;
  if (typeof candidate === "string") {
    return {
      name,
      auth: normalizeManagedAuthFile(parseRawAuthFile(candidate))
    };
  }
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return {
      name,
      auth: normalizeManagedAuthFile(candidate as RawAuthFile)
    };
  }
  throw new HttpError(400, "auth file content is required");
}

async function readDeleteNames(req: IncomingMessage, url: URL): Promise<string[]> {
  const queryNames = uniqueNames(url.searchParams.getAll("name"));
  if (queryNames.length > 0) {
    return queryNames;
  }

  const raw = await readOptionalJsonBody(req);
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return uniqueNames(raw.filter((item): item is string => typeof item === "string"));
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? [record.name] : [];
  const names = Array.isArray(record.names) ? record.names.filter((item: unknown): item is string => typeof item === "string") : [];
  return uniqueNames([...name, ...names]);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.map((name) => sanitizeAuthFileName(name)).filter(Boolean))];
}

function firstDefinedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function sanitizeAuthFileName(rawName: string): string {
  const name = rawName.trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new HttpError(400, "invalid name");
  }
  if (!name.toLowerCase().endsWith(".json")) {
    throw new HttpError(400, "name must end with .json");
  }
  return name;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}

function extractBooleanValue(body: Record<string, unknown>, key: string): boolean {
  const direct = body[key];
  if (typeof direct === "boolean") {
    return direct;
  }
  if (typeof body.value === "boolean") {
    return body.value;
  }
  throw new HttpError(400, "invalid body");
}

function extractIntegerValue(body: Record<string, unknown>, key: string): number {
  const direct = body[key];
  if (typeof direct === "number" && Number.isInteger(direct)) {
    return direct;
  }
  if (typeof body.value === "number" && Number.isInteger(body.value)) {
    return body.value;
  }
  throw new HttpError(400, "invalid body");
}

function extractStringValue(body: Record<string, unknown>, key: string): string {
  const direct = body[key];
  if (typeof direct === "string") {
    return direct.trim();
  }
  if (typeof body.value === "string") {
    return body.value.trim();
  }
  throw new HttpError(400, "invalid body");
}

function asOptionalString(value: unknown): string | undefined {
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "field must be a string");
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function applyPriority(auth: RawAuthFile, value: unknown): void {
  const attributes = auth.attributes || (auth.attributes = {});
  const metadata = auth.metadata || (auth.metadata = {});
  if (value === null || value === 0 || value === "0" || value === "") {
    delete attributes.priority;
    delete metadata.priority;
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, "priority must be an integer");
  }
  attributes.priority = String(value);
  metadata.priority = value;
}

function applyNote(auth: RawAuthFile, value: unknown): void {
  const attributes = auth.attributes || (auth.attributes = {});
  const metadata = auth.metadata || (auth.metadata = {});
  if (value === null) {
    delete attributes.note;
    delete metadata.note;
    return;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "note must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    delete attributes.note;
    delete metadata.note;
    return;
  }
  attributes.note = trimmed;
  metadata.note = trimmed;
}

function readAuthPlanType(auth: RawAuthFile): string {
  const direct = typeof auth.attributes?.plan_type === "string" && auth.attributes.plan_type.trim()
    ? auth.attributes.plan_type
    : typeof auth.attributes?.chatgpt_plan_type === "string" && auth.attributes.chatgpt_plan_type.trim()
      ? auth.attributes.chatgpt_plan_type
      : typeof auth.metadata?.plan_type === "string" && auth.metadata.plan_type.trim()
        ? auth.metadata.plan_type
        : typeof auth.metadata?.chatgpt_plan_type === "string" && auth.metadata.chatgpt_plan_type.trim()
          ? auth.metadata.chatgpt_plan_type
          : parseCodexIdTokenClaims(auth.id_token || "")?.["https://api.openai.com/auth"]?.chatgpt_plan_type
            || "pro";
  return direct.trim().toLowerCase();
}

function readAuthPriority(auth: RawAuthFile): number | undefined {
  const raw = auth.attributes?.priority ?? auth.metadata?.priority;
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readAuthNote(auth: RawAuthFile): string | undefined {
  const raw = typeof auth.attributes?.note === "string" && auth.attributes.note.trim()
    ? auth.attributes.note.trim()
    : typeof auth.metadata?.note === "string" && auth.metadata.note.trim()
      ? auth.metadata.note.trim()
      : undefined;
  return raw;
}

function normalizeStringMap(headers: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      continue;
    }
    const headerName = key.trim();
    const headerValue = value.trim();
    if (!headerName || !headerValue) {
      continue;
    }
    output[headerName] = headerValue;
  }
  return output;
}

function normalizeExcludedModelsMap(entries: Record<string, unknown>): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const [provider, models] of Object.entries(entries)) {
    if (!Array.isArray(models)) {
      continue;
    }
    const normalized = models
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (normalized.length > 0) {
      output[provider.trim().toLowerCase()] = [...new Set(normalized)];
    }
  }
  return output;
}

function normalizeAliasEntries(entries: unknown[]): CodexModelAliasConfig[] {
  return entries
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => ({
      name: typeof item.name === "string" ? item.name.trim() : "",
      alias: typeof item.alias === "string" ? item.alias.trim() : ""
    }))
    .filter((item) => item.name && item.alias);
}

function normalizeAliasMap(entries: Record<string, unknown>): Record<string, CodexModelAliasConfig[]> {
  const output: Record<string, CodexModelAliasConfig[]> = {};
  for (const [channel, aliases] of Object.entries(entries)) {
    if (!Array.isArray(aliases)) {
      continue;
    }
    const normalized = normalizeAliasEntries(aliases);
    if (normalized.length > 0) {
      output[channel.trim().toLowerCase()] = normalized;
    }
  }
  return output;
}

function isCodexKeyConfig(value: unknown): value is CodexKeyConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function mergeCounterMap(target: Record<string, number>, source: unknown): void {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return;
  }
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    target[key] = (target[key] || 0) + asNonNegativeInt(value);
  }
}

function createOAuthState(): string {
  return randomUUID().replaceAll("-", "");
}

function validateOAuthState(state: string): void {
  const trimmed = state.trim();
  if (!trimmed || trimmed.length > 128 || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new HttpError(400, "invalid state");
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readOptionalJsonBody(req);
  if (!raw || Array.isArray(raw) || typeof raw !== "object") {
    throw new HttpError(400, "invalid JSON body");
  }
  return raw as Record<string, unknown>;
}

function extractManagementKey(req: IncomingMessage): string {
  const headerValue = req.headers["x-management-key"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function isLocalAddress(remoteAddress: string): boolean {
  const normalized = remoteAddress.trim();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1" || normalized === "";
}

async function readPackageVersion(): Promise<string> {
  try {
    const packagePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "package.json");
    const raw = await readFile(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version || "0.0.0";
  } catch {
    return process.env.npm_package_version || "0.0.0";
  }
}

async function readOptionalJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    return undefined;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new HttpError(400, `Invalid JSON body: ${errorMessage(error)}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
