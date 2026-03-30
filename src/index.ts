#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { access } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createApiServer } from "./server.js";
import { CodexProxyService } from "./service.js";
import { runCodexDeviceLogin, runCodexLogin } from "./auth/codex.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = await resolveConfigPath(args);
  const config = await loadConfig(configPath);

  if (isCodexLoginCommand(args)) {
    await runCodexLogin(config, {
      noBrowser: hasFlag(args, "--no-browser"),
      callbackPort: parseIntegerFlag(args, "--oauth-callback-port")
    });
    return;
  }

  if (isCodexDeviceLoginCommand(args)) {
    await runCodexDeviceLogin(config, {
      noBrowser: hasFlag(args, "--no-browser")
    });
    return;
  }

  const service = await CodexProxyService.create(config);
  const server = createApiServer(service);

  server.listen(service.port, service.host, () => {
    process.stdout.write(`CLIProxyAPI-TS listening on http://${service.host}:${service.port}\n`);
    process.stdout.write(`Config: ${configPath}\n`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function resolveConfigPath(argv: string[]): Promise<string> {
  const explicit = readFlag(argv, "--config");
  if (explicit) {
    return path.resolve(explicit);
  }

  if (process.env.CLIPROXYAPI_TS_CONFIG?.trim()) {
    return path.resolve(process.env.CLIPROXYAPI_TS_CONFIG.trim());
  }

  const candidates = ["config.yaml", "config.yml", "config.json"];
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    try {
      await access(absolute);
      return absolute;
    } catch {
      continue;
    }
  }

  throw new Error("No config file found. Pass --config <path> or create config.yaml");
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  return undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function parseIntegerFlag(argv: string[], flag: string): number | undefined {
  const value = readFlag(argv, flag);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isCodexLoginCommand(argv: string[]): boolean {
  return argv[0] === "codex-login" || argv.includes("--codex-login");
}

function isCodexDeviceLoginCommand(argv: string[]): boolean {
  return argv[0] === "codex-device-login" || argv.includes("--codex-device-login");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
