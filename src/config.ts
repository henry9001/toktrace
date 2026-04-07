import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BudgetConfig {
  daily_token_limit?: number;
  weekly_token_limit?: number;
  /** Daily cost limit in USD */
  daily_cost_limit?: number;
  /** Weekly cost limit in USD */
  weekly_cost_limit?: number;
}

export interface TokTraceConfig {
  budget?: BudgetConfig;
}

export function defaultConfigDir(): string {
  return join(homedir(), ".toktrace");
}

export function loadConfig(configDir?: string): TokTraceConfig {
  const dir = configDir ?? defaultConfigDir();
  const path = join(dir, "config.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as TokTraceConfig;
}

export function saveConfig(config: TokTraceConfig, configDir?: string): void {
  const dir = configDir ?? defaultConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
}
