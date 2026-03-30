import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface CodexModelAliasConfig {
  name?: string;
  alias?: string;
}

export interface CodexKeyConfig {
  "api-key"?: string;
  "base-url"?: string;
  priority?: number;
  prefix?: string;
  websockets?: boolean;
  "proxy-url"?: string;
  headers?: Record<string, string>;
  models?: CodexModelAliasConfig[];
  "excluded-models"?: string[];
}

export interface RawAuthFile {
  id?: string;
  provider?: string;
  type?: string;
  prefix?: string;
  label?: string;
  disabled?: boolean;
  proxy_url?: string;
  attributes?: Record<string, string>;
  metadata?: Record<string, unknown>;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  email?: string;
  expired?: string;
  last_refresh?: string;
}

export interface AppConfig {
  host: string;
  port: number;
  authDir?: string;
  requestRetry: number;
  codexApiKey: CodexKeyConfig[];
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  const ext = path.extname(configPath).toLowerCase();
  const parsed = ext === ".json" ? JSON.parse(raw) as Record<string, unknown> : parseYaml(raw) as Record<string, unknown>;

  const authDirRaw = typeof parsed["auth-dir"] === "string" ? parsed["auth-dir"] : undefined;
  return {
    host: normalizeHost(parsed.host),
    port: normalizePort(parsed.port),
    authDir: authDirRaw ? path.resolve(path.dirname(configPath), authDirRaw) : undefined,
    requestRetry: normalizePositiveInt(parsed["request-retry"], 0),
    codexApiKey: Array.isArray(parsed["codex-api-key"]) ? parsed["codex-api-key"] as CodexKeyConfig[] : []
  };
}

export async function readCodexAuthFiles(authDir: string | undefined): Promise<Array<{ filePath: string; auth: RawAuthFile }>> {
  if (!authDir) {
    return [];
  }

  let entries: string[];
  try {
    entries = await fs.readdir(authDir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const results: Array<{ filePath: string; auth: RawAuthFile }> = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith(".json")) {
      continue;
    }

    const filePath = path.join(authDir, entry);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const auth = JSON.parse(raw) as RawAuthFile;
      const provider = (auth.provider || auth.type || "").trim().toLowerCase();
      if (provider !== "codex") {
        continue;
      }
      if (auth.disabled) {
        continue;
      }
      results.push({ filePath, auth });
    } catch {
      continue;
    }
  }

  return results;
}

function normalizeHost(value: unknown): string {
  if (typeof value !== "string") {
    return process.env.HOST?.trim() || "0.0.0.0";
  }
  const trimmed = value.trim();
  return trimmed || process.env.HOST?.trim() || "0.0.0.0";
}

function normalizePort(value: unknown): number {
  const envPort = Number.parseInt(process.env.PORT || "", 10);
  if (Number.isInteger(envPort) && envPort > 0) {
    return envPort;
  }
  return normalizePositiveInt(value, 8317);
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}
