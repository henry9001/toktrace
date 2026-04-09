import { join } from "node:path";
import { init } from "./init.js";
import { defaultConfigDir, loadConfig } from "./config.js";
import type { TokTraceOptions } from "./types.js";

function buildAutoOptions(): TokTraceOptions {
  const configDir = defaultConfigDir();
  const config = loadConfig(configDir);

  return {
    dbPath: join(configDir, "events.db"),
    proxyTargets: config.proxy_targets,
  };
}

// Side-effect module: importing "toktrace/auto" turns on patching.
init(buildAutoOptions());
