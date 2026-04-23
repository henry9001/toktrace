import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { insertEvent } from "../store.js";
import { estimateCost } from "../pricing.js";
import type { LLMEvent } from "../types.js";

export interface CodexImportResult {
  files_scanned: number;
  events_imported: number;
  events_skipped: number;
  errors: string[];
  /** Distinct `event_msg` subtypes seen (useful for reverse-engineering new rollout schemas). */
  subtypes_seen?: Record<string, number>;
}

export interface CodexImportOptions {
  /** Root dir of Codex rollouts. Defaults to $CODEX_HOME/sessions or ~/.codex/sessions. */
  root?: string;
  /** Path to the toktrace events DB. Defaults to the toktrace config DB. */
  dbPath?: string;
  /** If true, collect a histogram of event_msg subtypes into the result (no insertions). */
  inspect?: boolean;
}

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

function defaultRoot(): string {
  const base = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(base, "sessions");
}

function providerFromModel(model: string): string {
  if (model.startsWith("gpt-") || /^o[134]/.test(model) || model === "codex") return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  return "openai";
}

function normalizeUsage(u: CodexTokenUsage): {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
} {
  return {
    input_tokens: Number(u.input_tokens) || 0,
    cached_input_tokens: Number(u.cached_input_tokens) || 0,
    output_tokens: Number(u.output_tokens) || 0,
    reasoning_output_tokens: Number(u.reasoning_output_tokens) || 0,
    total_tokens: Number(u.total_tokens) || 0,
  };
}

// OpenAI cached input tokens are billed at ~50% of fresh input.
const CACHED_INPUT_MULT = 0.5;

function computeCost(
  model: string,
  usage: ReturnType<typeof normalizeUsage>,
): number {
  // input_tokens from Codex is the full new (non-cached) input count.
  // cached_input_tokens are billed at half rate.
  // reasoning tokens are priced at the output rate (o-series reasoning).
  const freshInput = estimateCost(model, usage.input_tokens, 0);
  const cachedInput = estimateCost(model, usage.cached_input_tokens, 0) * CACHED_INPUT_MULT;
  const totalOutputTokens = usage.output_tokens + usage.reasoning_output_tokens;
  const output = estimateCost(model, 0, totalOutputTokens);
  return freshInput + cachedInput + output;
}

function projectTagFromCwd(cwd: string): string {
  if (!cwd) return "codex";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || "codex";
}

function* walkRollouts(root: string): Generator<string> {
  if (!existsSync(root)) return;

  function* walk(dir: string): Generator<string> {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        yield* walk(abs);
      } else if (name.endsWith(".jsonl") && name.startsWith("rollout-")) {
        yield abs;
      }
    }
  }

  yield* walk(root);
}

export function importCodex(opts: CodexImportOptions = {}): CodexImportResult {
  const root = opts.root ?? defaultRoot();
  const result: CodexImportResult = {
    files_scanned: 0,
    events_imported: 0,
    events_skipped: 0,
    errors: [],
    subtypes_seen: opts.inspect ? {} : undefined,
  };

  for (const file of walkRollouts(root)) {
    result.files_scanned += 1;

    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch (e) {
      result.errors.push(`${file}: ${(e as Error).message}`);
      continue;
    }

    // State accumulated across lines of a single rollout
    let sessionId = file; // fallback: use file path if no session_meta
    let cwd = "";
    let currentModel = "";
    let tokenCountIndex = 0;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        result.events_skipped += 1;
        continue;
      }

      const type = entry.type;
      const payload = entry.payload as Record<string, unknown> | undefined;
      const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";

      if (type === "session_meta" && payload) {
        if (typeof payload.id === "string") sessionId = payload.id;
        if (typeof payload.cwd === "string") cwd = payload.cwd;
        continue;
      }

      if (type === "turn_context" && payload) {
        // Model can change per turn (review uses a separate model, etc.)
        if (typeof payload.model === "string") currentModel = payload.model;
        continue;
      }

      if (type === "event_msg" && payload) {
        const sub = typeof payload.type === "string" ? payload.type : "unknown";
        if (opts.inspect && result.subtypes_seen) {
          result.subtypes_seen[sub] = (result.subtypes_seen[sub] || 0) + 1;
        }

        if (sub === "token_count") {
          // Per-turn usage lives at payload.info.last_token_usage (inferred from binary struct shapes).
          const info = payload.info as Record<string, unknown> | undefined;
          const lastRaw = info?.last_token_usage as CodexTokenUsage | undefined;
          if (!lastRaw) {
            result.events_skipped += 1;
            continue;
          }
          const usage = normalizeUsage(lastRaw);

          // Skip empty usage frames (some token_count events are purely rate-limit updates).
          if (usage.input_tokens + usage.cached_input_tokens + usage.output_tokens + usage.reasoning_output_tokens === 0) {
            continue;
          }

          if (opts.inspect) continue; // inspection mode — don't write

          if (!currentModel) {
            // No turn_context seen yet — rare, skip
            result.events_skipped += 1;
            continue;
          }

          tokenCountIndex += 1;
          const eventId = `codex_${sessionId}_${tokenCountIndex}`;
          const prompt_hash = createHash("sha256").update(eventId).digest("hex").slice(0, 16);

          const totalContext = usage.input_tokens + usage.cached_input_tokens;
          const totalOutput = usage.output_tokens + usage.reasoning_output_tokens;

          const event: LLMEvent = {
            id: eventId,
            timestamp: timestamp || new Date().toISOString(),
            model: currentModel,
            provider: providerFromModel(currentModel),
            input_tokens: usage.input_tokens,
            output_tokens: totalOutput,
            total_tokens: totalContext + totalOutput,
            estimated_cost: computeCost(currentModel, usage),
            latency_ms: 0,
            prompt_hash,
            app_tag: projectTagFromCwd(cwd),
            env: "codex",
            tool_calls: null,
            context_size_tokens: totalContext,
            tool_call_count: 0,
          };

          try {
            insertEvent(event, opts.dbPath);
            result.events_imported += 1;
          } catch (e) {
            result.errors.push(`${file}:${eventId}: ${(e as Error).message}`);
          }
        }
        continue;
      }

      // response_item entries carry assistant messages but no usage; Codex emits
      // token_count events alongside them so we rely on those exclusively.
    }
  }

  return result;
}
