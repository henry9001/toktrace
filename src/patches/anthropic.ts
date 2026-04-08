import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { insertEvent } from "../store.js";
import { estimateCost } from "../pricing.js";
import type { LLMEvent, TokTraceOptions } from "../types.js";

/* eslint-disable @typescript-eslint/no-require-imports */
const tryRequire: NodeRequire =
  typeof require !== "undefined"
    ? require
    : createRequire(import.meta.url);

export const name = "anthropic";

let patched = false;

export function isEnabled(options: TokTraceOptions): boolean {
  return options.patchAnthropic !== false;
}

export function apply(options: TokTraceOptions): boolean {
  if (patched) return true;

  let mod: Record<string, unknown>;
  try {
    mod = tryRequire("@anthropic-ai/sdk") as Record<string, unknown>;
  } catch {
    return false;
  }

  const Anthropic = (mod.default ?? mod) as Record<string, unknown>;
  const Messages = Anthropic.Messages as (new (...args: unknown[]) => unknown) | undefined;

  if (!Messages?.prototype) return false;

  const proto = Messages.prototype as Record<string, (...args: unknown[]) => unknown>;
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

      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const model = (response.model as string) ?? (body.model as string) ?? "unknown";
      const messages = body.messages as unknown[] | undefined;

      // Count tool_use blocks in the response content
      const content = response.content as Array<Record<string, unknown>> | undefined;
      const toolCallCount = Array.isArray(content)
        ? content.filter((b) => b.type === "tool_use").length
        : 0;

      const event: LLMEvent = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        model,
        provider: "anthropic",
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
        tool_call_count: toolCallCount,
      };

      insertEvent(event, options.dbPath, { messages, body });
      return response;
    });
  };

  patched = true;
  return true;
}
