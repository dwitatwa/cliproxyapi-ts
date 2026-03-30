import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";

const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEFAULT_CALLBACK_PORT = 1455;
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;

export interface CodexIdTokenClaims {
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
}

export interface CodexSavedTokenFile {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
  last_refresh: string;
  email: string;
  type: "codex";
  expired: string;
}

interface PkceCodes {
  codeVerifier: string;
  codeChallenge: string;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
}

interface DeviceUserCodeResponse {
  device_auth_id?: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
}

interface DeviceTokenPollResponse {
  authorization_code?: string;
  code_verifier?: string;
  code_challenge?: string;
}

interface LoginOptions {
  noBrowser?: boolean;
  callbackPort?: number;
}

export async function runCodexLogin(config: AppConfig, options: LoginOptions = {}): Promise<void> {
  const authDir = requireAuthDir(config);
  const callbackPort = options.callbackPort && options.callbackPort > 0 ? options.callbackPort : DEFAULT_CALLBACK_PORT;
  const redirectUri = `http://localhost:${callbackPort}/auth/callback`;
  const pkce = generatePkceCodes();
  const state = randomUUID();
  const callback = await startOAuthCallbackServer(callbackPort);

  try {
    const authUrl = buildAuthUrl(state, redirectUri, pkce);
    process.stdout.write(`Open this URL to continue Codex login:\n${authUrl}\n`);
    if (!options.noBrowser) {
      await openBrowser(authUrl);
    }

    const result = await callback.waitForCallback(5 * 60 * 1000);
    if (result.error) {
      throw new HttpError(400, `OAuth error: ${result.error}`);
    }
    if (!result.code) {
      throw new HttpError(400, "Missing authorization code from Codex callback");
    }
    if (result.state !== state) {
      throw new HttpError(400, "OAuth state mismatch");
    }

    const tokenResponse = await exchangeCodeForTokens(result.code, redirectUri, pkce);
    const saved = buildSavedTokenFile(tokenResponse);
    const filePath = await writeCodexTokenFile(authDir, saved);
    process.stdout.write(`Codex login successful.\nSaved credentials: ${filePath}\n`);
  } finally {
    await callback.close();
  }
}

export async function runCodexDeviceLogin(config: AppConfig, options: LoginOptions = {}): Promise<void> {
  const authDir = requireAuthDir(config);
  const userCodeResponse = await requestDeviceUserCode();
  const deviceAuthId = (userCodeResponse.device_auth_id || "").trim();
  const userCode = ((userCodeResponse.user_code || userCodeResponse.usercode) || "").trim();
  if (!deviceAuthId || !userCode) {
    throw new HttpError(500, "Codex device flow did not return required fields");
  }

  process.stdout.write(`Codex device URL: ${DEVICE_VERIFICATION_URL}\n`);
  process.stdout.write(`Codex device code: ${userCode}\n`);
  if (!options.noBrowser) {
    await openBrowser(DEVICE_VERIFICATION_URL);
  }

  const pollIntervalMs = parseDevicePollInterval(userCodeResponse.interval);
  const deviceToken = await pollDeviceToken(deviceAuthId, userCode, pollIntervalMs);
  const code = (deviceToken.authorization_code || "").trim();
  const codeVerifier = (deviceToken.code_verifier || "").trim();
  const codeChallenge = (deviceToken.code_challenge || "").trim();
  if (!code || !codeVerifier || !codeChallenge) {
    throw new HttpError(500, "Codex device flow token response missing required fields");
  }

  const tokenResponse = await exchangeCodeForTokens(code, DEVICE_REDIRECT_URI, {
    codeVerifier,
    codeChallenge
  });
  const saved = buildSavedTokenFile(tokenResponse);
  const filePath = await writeCodexTokenFile(authDir, saved);
  process.stdout.write(`Codex device login successful.\nSaved credentials: ${filePath}\n`);
}

export async function refreshCodexToken(refreshToken: string): Promise<CodexSavedTokenFile> {
  if (!refreshToken.trim()) {
    throw new HttpError(400, "Missing refresh token");
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken.trim(),
    scope: "openid profile email"
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body
  });
  const payload = await readJsonOrText(response);
  if (!response.ok) {
    throw new HttpError(response.status, extractErrorMessage(payload, "Codex token refresh failed"), payload);
  }
  return buildSavedTokenFile(payload as OAuthTokenResponse);
}

export function parseCodexIdTokenClaims(idToken: string): CodexIdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const normalized = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as CodexIdTokenClaims;
  } catch {
    return null;
  }
}

export function buildCodexCredentialFileName(email: string, planType: string, accountId: string): string {
  const normalizedPlan = normalizePlanType(planType);
  const trimmedEmail = email.trim();
  if (!normalizedPlan) {
    return `codex-${trimmedEmail}.json`;
  }
  if (normalizedPlan === "team") {
    const hash = accountId.trim()
      ? createHash("sha256").update(accountId.trim()).digest("hex").slice(0, 8)
      : "";
    return `codex-${hash}-${trimmedEmail}-${normalizedPlan}.json`;
  }
  return `codex-${trimmedEmail}-${normalizedPlan}.json`;
}

export function buildSavedTokenFile(payload: OAuthTokenResponse): CodexSavedTokenFile {
  const claims = parseCodexIdTokenClaims(payload.id_token);
  const email = (claims?.email || "").trim();
  const accountId = (claims?.["https://api.openai.com/auth"]?.chatgpt_account_id || "").trim();
  if (!email) {
    throw new HttpError(500, "Codex token response did not include account email");
  }
  return {
    id_token: payload.id_token,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    account_id: accountId,
    last_refresh: new Date().toISOString(),
    email,
    type: "codex",
    expired: new Date(Date.now() + payload.expires_in * 1000).toISOString()
  };
}

export async function writeCodexTokenFile(authDir: string, saved: CodexSavedTokenFile): Promise<string> {
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  const planType = parseCodexIdTokenClaims(saved.id_token)?.["https://api.openai.com/auth"]?.chatgpt_plan_type || "";
  const fileName = buildCodexCredentialFileName(saved.email, planType, saved.account_id);
  const filePath = path.join(authDir, fileName);
  await writeFile(filePath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

function requireAuthDir(config: AppConfig): string {
  if (!config.authDir?.trim()) {
    throw new HttpError(400, "This command requires auth-dir in config");
  }
  return config.authDir;
}

function generatePkceCodes(): PkceCodes {
  const codeVerifier = randomBytes(96).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function buildAuthUrl(state: string, redirectUri: string, pkce: PkceCodes): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid email profile offline_access",
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true"
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: pkce.codeVerifier
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body
  });
  const payload = await readJsonOrText(response);
  if (!response.ok) {
    throw new HttpError(response.status, extractErrorMessage(payload, "Codex token exchange failed"), payload);
  }
  return payload as OAuthTokenResponse;
}

async function requestDeviceUserCode(): Promise<DeviceUserCodeResponse> {
  const response = await fetch(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ client_id: CLIENT_ID })
  });
  const payload = await readJsonOrText(response);
  if (!response.ok) {
    throw new HttpError(response.status, extractErrorMessage(payload, "Codex device code request failed"), payload);
  }
  return payload as DeviceUserCodeResponse;
}

async function pollDeviceToken(deviceAuthId: string, userCode: string, intervalMs: number): Promise<DeviceTokenPollResponse> {
  const deadline = Date.now() + DEVICE_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) {
      throw new HttpError(408, "Codex device authentication timed out after 15 minutes");
    }

    const response = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode
      })
    });

    if (response.ok) {
      return await response.json() as DeviceTokenPollResponse;
    }

    if (response.status === 403 || response.status === 404) {
      await sleep(intervalMs);
      continue;
    }

    const payload = await readJsonOrText(response);
    throw new HttpError(response.status, extractErrorMessage(payload, "Codex device polling failed"), payload);
  }
}

function parseDevicePollInterval(raw: string | number | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw * 1000;
  }
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1000;
    }
  }
  return 5000;
}

async function openBrowser(url: string): Promise<void> {
  const commands = process.platform === "darwin"
    ? [["open", url]]
    : process.platform === "win32"
      ? [["cmd", "/c", "start", "", url]]
      : [["xdg-open", url]];

  for (const [command, ...args] of commands) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        child.on("error", reject);
        child.unref();
        resolve();
      });
      return;
    } catch {
      continue;
    }
  }
}

function normalizePlanType(planType: string): string {
  return planType
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase())
    .join("-");
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string") {
    return payload || fallback;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (record.error && typeof record.error === "object" && typeof (record.error as Record<string, unknown>).message === "string") {
      return (record.error as Record<string, unknown>).message as string;
    }
    if (typeof record.message === "string") {
      return record.message;
    }
    if (typeof record.error === "string") {
      return record.error;
    }
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startOAuthCallbackServer(port: number): Promise<{
  waitForCallback: (timeoutMs: number) => Promise<{ code?: string; state?: string; error?: string }>;
  close: () => Promise<void>;
}> {
  let resolveCallback: ((value: { code?: string; state?: string; error?: string }) => void) | null = null;
  const callbackPromise = new Promise<{ code?: string; state?: string; error?: string }>((resolve) => {
    resolveCallback = resolve;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/auth/callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code") || undefined;
    const state = url.searchParams.get("state") || undefined;
    const error = url.searchParams.get("error") || url.searchParams.get("error_description") || undefined;
    resolveCallback?.({ code, state, error });
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<html><body><h1>Codex authentication complete</h1><p>You can close this window.</p></body></html>");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    waitForCallback: async (timeoutMs: number) => Promise.race([
      callbackPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new HttpError(408, "Timeout waiting for Codex callback")), timeoutMs))
    ]),
    close: async () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }).catch(() => {})
  };
}
