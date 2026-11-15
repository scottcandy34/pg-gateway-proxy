import path from "node:path";
import { loadOrCreate } from "./config.js";
import { createLogger } from "./log.js";
import { startProxy } from "./server.js";

const configPath = process.env.CONFIG_PATH ?? path.resolve("config.yml");

try {
  const { config, created } = await loadOrCreate(configPath);
  const log = createLogger(config.log.level, config.log.format);
  if (created) log.warn("wrote a default config; edit it before pointing clients at this proxy", { path: configPath });
  else log.info("loaded config", { path: configPath });
  const running = await startProxy(config, log);
  const stop = async (signal: string) => {
    log.info("shutting down", { signal });
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`pg-gateway-proxy: ${message}`);
  process.exit(1);
}
