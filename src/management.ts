import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import {
  buildCodexCredentialFileName,
  buildCodexAuthUrl,
  buildSavedTokenFile,
  exchangeCodeForTokens,
  generatePkceCodes,
  parseCodexIdTokenClaims,
  writeCodexTokenFile,
  type PkceCodes,
  type CodexSavedTokenFile
} from "./auth/codex.js";
import { type RawAuthFile } from "./config.js";
import { HttpError, errorMessage } from "./errors.js";
import { getPlanModels } from "./models.js";
import { CodexProxyService } from "./service.js";

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

export class CodexManagementApi {
  private readonly sessions = new Map<string, ManagedOAuthSession>();
  private codexForwarder: HttpServer | null = null;

  constructor(
    private readonly service: CodexProxyService,
    private readonly callbackPort = DEFAULT_CODEX_CALLBACK_PORT
  ) {}

  async handleRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method === "GET" && url.pathname === "/codex/callback") {
      await this.handleCodexCallback(req, res, url);
      return true;
    }

    if (url.pathname === "/management.html") {
      throw new HttpError(501, "Management UI is not implemented in the TypeScript port");
    }

    if (!url.pathname.startsWith("/v0/management")) {
      return false;
    }

    const method = req.method || "GET";
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

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.map((name) => sanitizeAuthFileName(name)).filter(Boolean))];
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

function createOAuthState(): string {
  return randomUUID().replaceAll("-", "");
}

function validateOAuthState(state: string): void {
  const trimmed = state.trim();
  if (!trimmed || trimmed.length > 128 || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new HttpError(400, "invalid state");
  }
}

function buildDefaultManagedFileName(saved: CodexSavedTokenFile): string {
  const claims = parseCodexIdTokenClaims(saved.id_token);
  const planType = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type?.trim().toLowerCase() || "";
  return buildCodexCredentialFileName(saved.email, planType, saved.account_id);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readOptionalJsonBody(req);
  if (!raw || Array.isArray(raw) || typeof raw !== "object") {
    throw new HttpError(400, "invalid JSON body");
  }
  return raw as Record<string, unknown>;
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
