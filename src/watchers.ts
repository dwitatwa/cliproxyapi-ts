import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { CodexProxyService } from "./service.js";

export function startRuntimeWatchers(service: CodexProxyService): () => void {
  const watchers: FSWatcher[] = [];
  let configTimer: NodeJS.Timeout | undefined;
  let authTimer: NodeJS.Timeout | undefined;

  const queueConfigReload = () => {
    clearTimeout(configTimer);
    configTimer = setTimeout(() => {
      void loadConfig(service.runtimeConfig.configPath)
        .then((nextConfig) => service.applyConfig(nextConfig))
        .catch(() => {});
    }, 150);
  };

  const queueAuthReload = () => {
    clearTimeout(authTimer);
    authTimer = setTimeout(() => {
      void service.reloadCredentials().catch(() => {});
    }, 150);
  };

  try {
    watchers.push(watch(service.runtimeConfig.configPath, queueConfigReload));
  } catch {}

  const authDir = service.authDir;
  if (authDir) {
    try {
      watchers.push(watch(authDir, (_eventType, fileName) => {
        if (!fileName || path.extname(String(fileName)).toLowerCase() === ".json") {
          queueAuthReload();
        }
      }));
    } catch {}
  }

  return () => {
    clearTimeout(configTimer);
    clearTimeout(authTimer);
    for (const watcher of watchers) {
      watcher.close();
    }
  };
}
