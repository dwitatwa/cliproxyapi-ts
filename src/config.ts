import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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
  configPath: string;
  configFormat: "yaml" | "json";
  host: string;
  port: number;
  authDir?: string;
  proxyUrl?: string;
  requestRetry: number;
  managementKey?: string;
  allowRemoteManagement: boolean;
  debug: boolean;
  requestLog: boolean;
  usageStatisticsEnabled: boolean;
  loggingToFile: boolean;
  quotaExceededSwitchProject: boolean;
  quotaExceededSwitchPreviewModel: boolean;
  forceModelPrefix?: string;
  oauthExcludedModels: Record<string, string[]>;
  oauthModelAlias: Record<string, CodexModelAliasConfig[]>;
  codexApiKey: CodexKeyConfig[];
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  const ext = path.extname(configPath).toLowerCase();
  const parsed = ext === ".json" ? JSON.parse(raw) as Record<string, unknown> : parseYaml(raw) as Record<string, unknown>;

  const authDirRaw = typeof parsed["auth-dir"] === "string" ? parsed["auth-dir"] : undefined;
  return {
    configPath: path.resolve(configPath),
    configFormat: ext === ".json" ? "json" : "yaml",
    host: normalizeHost(parsed.host),
    port: normalizePort(parsed.port),
    authDir: authDirRaw ? path.resolve(path.dirname(configPath), authDirRaw) : undefined,
    proxyUrl: normalizeOptionalString(parsed["proxy-url"]),
    requestRetry: normalizePositiveInt(parsed["request-retry"], 0),
    managementKey: normalizeOptionalString(parsed["management-key"]) || normalizeOptionalString(process.env.MANAGEMENT_PASSWORD),
    allowRemoteManagement: normalizeBoolean(parsed["allow-remote-management"], false),
    debug: normalizeBoolean(parsed.debug, false),
    requestLog: normalizeBoolean(parsed["request-log"], false),
    usageStatisticsEnabled: normalizeBoolean(parsed["usage-statistics-enabled"], true),
    loggingToFile: normalizeBoolean(parsed["logging-to-file"], false),
    quotaExceededSwitchProject: normalizeBoolean(parsed["quota-exceeded-switch-project"], false),
    quotaExceededSwitchPreviewModel: normalizeBoolean(parsed["quota-exceeded-switch-preview-model"], false),
    forceModelPrefix: normalizeOptionalString(parsed["force-model-prefix"]),
    oauthExcludedModels: normalizeOAuthExcludedModels(parsed["oauth-excluded-models"]),
    oauthModelAlias: normalizeOAuthModelAlias(parsed["oauth-model-alias"]),
    codexApiKey: Array.isArray(parsed["codex-api-key"]) ? parsed["codex-api-key"] as CodexKeyConfig[] : []
  };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const payload = {
    host: config.host,
    port: config.port,
    ...(config.authDir ? { "auth-dir": toRelativeConfigPath(config.configPath, config.authDir) } : {}),
    ...(config.proxyUrl ? { "proxy-url": config.proxyUrl } : {}),
    "request-retry": config.requestRetry,
    ...(config.managementKey ? { "management-key": config.managementKey } : {}),
    "allow-remote-management": config.allowRemoteManagement,
    debug: config.debug,
    "request-log": config.requestLog,
    "usage-statistics-enabled": config.usageStatisticsEnabled,
    "logging-to-file": config.loggingToFile,
    "quota-exceeded-switch-project": config.quotaExceededSwitchProject,
    "quota-exceeded-switch-preview-model": config.quotaExceededSwitchPreviewModel,
    ...(config.forceModelPrefix ? { "force-model-prefix": config.forceModelPrefix } : {}),
    ...(Object.keys(config.oauthExcludedModels).length > 0 ? { "oauth-excluded-models": config.oauthExcludedModels } : {}),
    ...(Object.keys(config.oauthModelAlias).length > 0 ? { "oauth-model-alias": config.oauthModelAlias } : {}),
    "codex-api-key": config.codexApiKey
  };

  const data = config.configFormat === "json"
    ? `${JSON.stringify(payload, null, 2)}\n`
    : stringifyYaml(payload);
  await fs.writeFile(config.configPath, data, "utf8");
}

export async function readConfigFileRaw(configPath: string): Promise<string> {
  return fs.readFile(configPath, "utf8");
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

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "1":
      case "true":
      case "yes":
      case "on":
        return true;
      case "0":
      case "false":
      case "no":
      case "off":
        return false;
      default:
        break;
    }
  }
  return fallback;
}

function normalizeOAuthExcludedModels(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, string[]> = {};
  for (const [key, models] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(models)) {
      continue;
    }
    const normalized = models
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (normalized.length > 0) {
      output[key.trim().toLowerCase()] = [...new Set(normalized)];
    }
  }
  return output;
}

function normalizeOAuthModelAlias(value: unknown): Record<string, CodexModelAliasConfig[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, CodexModelAliasConfig[]> = {};
  for (const [key, aliases] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(aliases)) {
      continue;
    }
    const normalized = aliases
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
      .map((item) => ({
        name: typeof item.name === "string" ? item.name.trim() : "",
        alias: typeof item.alias === "string" ? item.alias.trim() : ""
      }))
      .filter((item) => item.name && item.alias);
    if (normalized.length > 0) {
      output[key.trim().toLowerCase()] = normalized;
    }
  }
  return output;
}

function toRelativeConfigPath(configPath: string, targetPath: string): string {
  const relative = path.relative(path.dirname(configPath), targetPath);
  return relative && !relative.startsWith("..") ? relative : targetPath;
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
