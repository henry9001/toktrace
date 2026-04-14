import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProxyTarget } from "./types.js";

export interface BudgetConfig {
  daily_token_limit?: number;
  weekly_token_limit?: number;
  /** Daily cost limit in USD */
  daily_cost_limit?: number;
  /** Weekly cost limit in USD */
  weekly_cost_limit?: number;
}

export interface AlertsConfig {
  /** Enable desktop notifications (notify-send / osascript). Defaults to true. */
  desktop?: boolean;
  /** Enable CLI stderr warnings. Defaults to true. */
  cli?: boolean;
}

export interface RulesConfig {
  /** Set to false to disable all rule checks. Defaults to true. */
  enabled?: boolean;
  /** Token threshold for the overlong system prompt rule. Defaults to 1000. */
  overlong_system_prompt_tokens?: number;
}

export interface TokTraceConfig {
  budget?: BudgetConfig;
  alerts?: AlertsConfig;
  /** Configuration for optimization rules (e.g. overlong system prompt detection). */
  rules?: RulesConfig;
  /** Proxy targets for generic HTTP interception of unsupported providers. */
  proxy_targets?: ProxyTarget[];
  /** Privacy controls for local capture and redaction behavior. */
  privacy?: {
    /** Capture raw prompt bodies (default false). */
    capture_prompt_body?: boolean;
    /** User-defined redaction hook names/modules. */
    redaction_hooks?: string[];
  };
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
