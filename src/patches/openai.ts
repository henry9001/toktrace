import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";

/* eslint-disable @typescript-eslint/no-require-imports */
const tryRequire: NodeRequire =
  typeof require !== "undefined"
    ? require
    : createRequire(import.meta.url);
import { insertEvent } from "../store.js";
import { estimateCost } from "../pricing.js";
import type { LLMEvent, TokTraceOptions } from "../types.js";

export const name = "openai";

let patched = false;

export function isEnabled(options: TokTraceOptions): boolean {
  return options.patchOpenAI !== false;
}

export function apply(options: TokTraceOptions): boolean {
  if (patched) return true;

  let mod: Record<string, unknown>;
  try {
    mod = tryRequire("openai") as Record<string, unknown>;
  } catch {
    return false;
  }

  const OpenAI = (mod.default ?? mod) as Record<string, unknown>;
  const Chat = OpenAI.Chat as Record<string, unknown> | undefined;
  const Completions = Chat?.Completions as (new (...args: unknown[]) => unknown) | undefined;

  if (!Completions?.prototype) return false;

  const proto = Completions.prototype as Record<string, (...args: unknown[]) => unknown>;
  const originalCreate = proto.create;
  if (typeof originalCreate !== "function") return false;

  proto.create = function patchedCreate(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    const body = (args[0] ?? {}) as Record<string, unknown>;
    if (body.stream) {
      return originalCreate.call(this, ...args);
    }

    const start = performance.now();
    const result = originalCreate.call(this, ...args) as Promise<Record<string, unknown>>;

    return result.then((response: Record<string, unknown>) => {
      const latency = Math.round(performance.now() - start);
      const usage = response.usage as Record<string, number> | undefined;
      if (!usage) return response;

      const inputTokens = usage.prompt_tokens ?? 0;
      const outputTokens = usage.completion_tokens ?? 0;
      const model = (response.model as string) ?? (body.model as string) ?? "unknown";
      const messages = body.messages as unknown[] | undefined;

      const event: LLMEvent = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        model,
        provider: "openai",
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        estimated_cost: estimateCost(model, inputTokens, outputTokens),
        latency_ms: latency,
        prompt_hash: messages
          ? createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16)
          : null,
        app_tag: null,
        env: process.env.NODE_ENV ?? null,
      };

      insertEvent(event, options.dbPath);
      return response;
    });
  };

  patched = true;
  return true;
}
