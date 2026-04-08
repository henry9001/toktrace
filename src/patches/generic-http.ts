import { randomUUID, createHash } from "node:crypto";
import { insertEvent } from "../store.js";
import { estimateCost } from "../pricing.js";
import type { LLMEvent, ProxyTarget, TokTraceOptions } from "../types.js";

export const name = "generic-http";

let patched = false;

export function isEnabled(options: TokTraceOptions): boolean {
  if (options.patchGenericHTTP === false) return false;
  return (options.proxyTargets ?? []).length > 0;
}

/**
 * Resolve a dot-separated path against a nested object.
 * e.g. getByPath(obj, "usage.prompt_tokens") → obj.usage.prompt_tokens
 */
function getByPath(obj: unknown, path: string): unknown {
  let current = obj;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function findMatchingTarget(url: string, targets: ProxyTarget[]): ProxyTarget | undefined {
  return targets.find((t) => url.includes(t.urlPattern));
}

/**
 * Try to extract the request body as a parsed JSON object.
 * Returns null if the body is absent, not JSON, or a stream.
 */
function extractRequestBody(init?: Record<string, unknown>): Record<string, unknown> | null {
  if (!init?.body) return null;
  if (typeof init.body !== "string") return null;
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function apply(options: TokTraceOptions): boolean {
  if (patched) return true;

  const targets = options.proxyTargets;
  if (!targets || targets.length === 0) return false;

  const originalFetch = globalThis.fetch as ((...args: unknown[]) => Promise<unknown>) | undefined;
  if (typeof originalFetch !== "function") return false;

  function resolveUrl(input: unknown): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input != null && typeof input === "object" && "url" in input) {
      return String((input as { url: unknown }).url);
    }
    return "";
  }

  (globalThis as Record<string, unknown>).fetch = function patchedFetch(
    ...args: unknown[]
  ): Promise<unknown> {
    const [input, init] = args;
    const url = resolveUrl(input);

    const target = findMatchingTarget(url, targets);
    if (!target) {
      return originalFetch.call(globalThis, ...args);
    }

    const start = performance.now();
    const reqBody = extractRequestBody(init as Record<string, unknown> | undefined);

    return originalFetch.call(globalThis, ...args).then((response: unknown) => {
      const resp = response as { clone(): { json(): Promise<unknown> } };

      // Clone so the caller can still read the body
      const cloned = resp.clone();

      // Parse the response body in the background without blocking the caller
      cloned.json().then((json: unknown) => {
        const latency = Math.round(performance.now() - start);
        if (json == null || typeof json !== "object") return;

        const modelPath = target.modelPath ?? "model";
        const inputPath = target.inputTokensPath ?? "usage.prompt_tokens";
        const outputPath = target.outputTokensPath ?? "usage.completion_tokens";

        const inputTokens = Number(getByPath(json, inputPath)) || 0;
        const outputTokens = Number(getByPath(json, outputPath)) || 0;

        // If there's no token data at all, skip recording
        if (inputTokens === 0 && outputTokens === 0) return;

        const model =
          String(getByPath(json, modelPath) ?? "") ||
          (reqBody?.model as string | undefined) ||
          "unknown";

        const messages = reqBody?.messages as unknown[] | undefined;

        const event: LLMEvent = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          model,
          provider: target.name,
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

        insertEvent(event, options.dbPath, {
          messages,
          body: reqBody ?? undefined,
        });
      }).catch(() => {
        // Response wasn't JSON — not an LLM call, silently skip
      });

      return response;
    });
  };

  patched = true;
  return true;
}
