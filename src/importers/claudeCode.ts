import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { insertEvent } from "../store.js";
import { estimateCost } from "../pricing.js";
import type { LLMEvent } from "../types.js";

export interface ImportResult {
  files_scanned: number;
  events_imported: number;
  events_skipped: number;
  errors: string[];
}

export interface ClaudeCodeImportOptions {
  /** Root directory of Claude Code project logs. Defaults to ~/.claude/projects */
  root?: string;
  /** Path to the toktrace events DB. Defaults to the toktrace config DB. */
  dbPath?: string;
}

interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

const DEFAULT_ROOT = join(homedir(), ".claude", "projects");

// Anthropic cache pricing multipliers (relative to base input rate).
// Cache writes cost 25% more, cache reads cost 90% less.
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

function providerFromModel(model: string): string {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || /^o[134]/.test(model)) return "openai";
  return "unknown";
}

function computeCostWithCache(model: string, usage: Required<ClaudeUsage>): number {
  const baseInput = estimateCost(model, usage.input_tokens, 0);
  const outputCost = estimateCost(model, 0, usage.output_tokens);
  const writeCost = estimateCost(model, usage.cache_creation_input_tokens, 0) * CACHE_WRITE_MULT;
  const readCost = estimateCost(model, usage.cache_read_input_tokens, 0) * CACHE_READ_MULT;
  return baseInput + outputCost + writeCost + readCost;
}

function projectTagFromPath(projectDirName: string): string {
  // Claude Code encodes project paths as dir names like "-home-ec2-user-gt".
  // Use the final path segment as the app_tag (e.g. "gt").
  const stripped = projectDirName.replace(/^-+/, "");
  const parts = stripped.split("-").filter(Boolean);
  return parts[parts.length - 1] || "claude-code";
}

function* findJsonlFiles(root: string): Generator<{ file: string; projectTag: string }> {
  if (!existsSync(root)) return;
  for (const projectDir of readdirSync(root)) {
    const abs = join(root, projectDir);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    const tag = projectTagFromPath(projectDir);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith(".jsonl")) yield { file: join(abs, f), projectTag: tag };
    }
  }
}

export function importClaudeCode(opts: ClaudeCodeImportOptions = {}): ImportResult {
  const root = opts.root ?? DEFAULT_ROOT;
  const result: ImportResult = {
    files_scanned: 0,
    events_imported: 0,
    events_skipped: 0,
    errors: [],
  };

  for (const { file, projectTag } of findJsonlFiles(root)) {
    result.files_scanned += 1;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch (e) {
      result.errors.push(`${file}: ${(e as Error).message}`);
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        result.events_skipped += 1;
        continue;
      }

      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg || msg.role !== "assistant" || !msg.usage) continue;
      if (typeof msg.id !== "string" || typeof msg.model !== "string") {
        result.events_skipped += 1;
        continue;
      }
      // Synthetic entries (e.g. "<synthetic>") are Claude Code bookkeeping,
      // not real LLM calls — ignore them silently.
      if (msg.model.startsWith("<") && msg.model.endsWith(">")) continue;

      const u = msg.usage as ClaudeUsage;
      const usage: Required<ClaudeUsage> = {
        input_tokens: Number(u.input_tokens) || 0,
        cache_creation_input_tokens: Number(u.cache_creation_input_tokens) || 0,
        cache_read_input_tokens: Number(u.cache_read_input_tokens) || 0,
        output_tokens: Number(u.output_tokens) || 0,
      };

      const totalInputContext =
        usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
      const total_tokens = totalInputContext + usage.output_tokens;

      const estimated_cost = computeCostWithCache(msg.model, usage);

      const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
      const prompt_hash = createHash("sha256").update(msg.id).digest("hex").slice(0, 16);

      const content_arr = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
      const tool_call_count = content_arr.filter((c) => c?.type === "tool_use").length;

      const event: LLMEvent = {
        id: msg.id,
        timestamp,
        model: msg.model,
        provider: providerFromModel(msg.model),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens,
        estimated_cost,
        latency_ms: 0,
        prompt_hash,
        app_tag: projectTag,
        env: "claude-code",
        tool_calls: null,
        context_size_tokens: totalInputContext,
        tool_call_count,
      };

      try {
        insertEvent(event, opts.dbPath);
        result.events_imported += 1;
      } catch (e) {
        result.errors.push(`${file}:${msg.id}: ${(e as Error).message}`);
      }
    }
  }

  return result;
}
