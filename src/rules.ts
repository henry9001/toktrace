import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { LLMEvent } from "./types.js";
import { loadConfig } from "./config.js";
import type { RulesConfig } from "./config.js";

export interface RuleViolation {
  id: string;
  event_id: string;
  rule: string;
  level: "info" | "warning";
  message: string;
  detail: string | null;
  fired_at: string;
}

/** Create the rule_violations table if it does not yet exist. */
export function initRulesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_violations (
      id        TEXT PRIMARY KEY,
      event_id  TEXT NOT NULL,
      rule      TEXT NOT NULL,
      level     TEXT NOT NULL,
      message   TEXT NOT NULL,
      detail    TEXT,
      fired_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_violations_event ON rule_violations(event_id);
    CREATE INDEX IF NOT EXISTS idx_violations_rule  ON rule_violations(rule);
  `);
}

/**
 * Estimate token count from text.
 * Rough heuristic: ~4 characters per token (GPT-family average).
 * Sufficient for detecting overlong prompts without a full tokenizer.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract system prompt text from a request body, handling both
 * OpenAI and Anthropic message formats.
 *
 * - Anthropic: `body.system` (string or content-block array)
 * - OpenAI:    messages with `role === "system"` or `role === "developer"`
 */
export function extractSystemPromptText(
  messages: unknown[] | undefined,
  body: Record<string, unknown> | undefined
): string | null {
  // Anthropic format: body.system is a string or array of content blocks
  if (body?.system != null) {
    if (typeof body.system === "string") return body.system;
    if (Array.isArray(body.system)) {
      return (body.system as Array<unknown>)
        .map((block) => {
          if (typeof block === "string") return block;
          const b = block as Record<string, unknown>;
          if (b?.type === "text" && typeof b.text === "string") return b.text;
          return JSON.stringify(block);
        })
        .join("\n");
    }
  }

  // OpenAI format: messages with role "system" or "developer"
  if (messages && Array.isArray(messages)) {
    const systemMessages = messages.filter((m: unknown) => {
      const msg = m as Record<string, unknown>;
      return msg.role === "system" || msg.role === "developer";
    });
    if (systemMessages.length > 0) {
      return systemMessages
        .map((m: unknown) => {
          const msg = m as Record<string, unknown>;
          if (typeof msg.content === "string") return msg.content;
          if (Array.isArray(msg.content)) {
            return (msg.content as Array<unknown>)
              .map((part) => {
                if (typeof part === "string") return part;
                const p = part as Record<string, unknown>;
                if (p?.type === "text" && typeof p.text === "string")
                  return p.text;
                return "";
              })
              .join("");
          }
          return "";
        })
        .join("\n");
    }
  }

  return null;
}

const DEFAULT_TOKEN_THRESHOLD = 1000;

/**
 * Check whether the system prompt exceeds the configured token threshold.
 * Returns a RuleViolation if it does, null otherwise.
 */
export function checkOverlongSystemPrompt(
  db: Database.Database,
  event: LLMEvent,
  messages: unknown[] | undefined,
  body: Record<string, unknown> | undefined,
  config?: RulesConfig
): RuleViolation | null {
  const threshold =
    config?.overlong_system_prompt_tokens ?? DEFAULT_TOKEN_THRESHOLD;
  if (threshold <= 0) return null;

  const systemText = extractSystemPromptText(messages, body);
  if (!systemText) return null;

  const tokenCount = estimateTokenCount(systemText);
  if (tokenCount <= threshold) return null;

  const violation: RuleViolation = {
    id: randomUUID(),
    event_id: event.id,
    rule: "overlong_system_prompt",
    level: tokenCount > threshold * 2 ? "warning" : "info",
    message: `System prompt is ~${tokenCount} tokens (threshold: ${threshold}). Consider trimming or summarizing.`,
    detail: JSON.stringify({
      estimated_tokens: tokenCount,
      threshold,
      char_count: systemText.length,
      model: event.model,
      provider: event.provider,
    }),
    fired_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT OR IGNORE INTO rule_violations
       (id, event_id, rule, level, message, detail, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    violation.id,
    violation.event_id,
    violation.rule,
    violation.level,
    violation.message,
    violation.detail,
    violation.fired_at
  );

  return violation;
}

/**
 * Run all configured rules against an event.
 * Called from insertEvent after the event is stored.
 */
export function checkRules(
  db: Database.Database,
  event: LLMEvent,
  messages: unknown[] | undefined,
  body: Record<string, unknown> | undefined,
  config?: RulesConfig
): RuleViolation[] {
  const rulesConfig = config ?? loadConfig().rules;
  if (rulesConfig?.enabled === false) return [];

  const violations: RuleViolation[] = [];

  const v = checkOverlongSystemPrompt(db, event, messages, body, rulesConfig);
  if (v) violations.push(v);

  return violations;
}

/** Query rule violations, optionally filtered by rule name or event ID. */
export function queryViolations(
  db: Database.Database,
  opts: { rule?: string; eventId?: string; limit?: number } = {}
): RuleViolation[] {
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (opts.rule) {
    conditions.push("rule = @rule");
    params.rule = opts.rule;
  }
  if (opts.eventId) {
    conditions.push("event_id = @eventId");
    params.eventId = opts.eventId;
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit != null ? `LIMIT ${opts.limit}` : "";

  return db
    .prepare(
      `SELECT * FROM rule_violations ${where} ORDER BY fired_at DESC ${limit}`
    )
    .all(params) as RuleViolation[];
}
