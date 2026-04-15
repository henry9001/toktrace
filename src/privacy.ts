import { createHash } from "node:crypto";
import type { TokTraceOptions } from "./types.js";

function applyBuiltinProfiles(text: string, profiles: string[]): string {
  let output = text;
  if (profiles.includes("email")) {
    output = output.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
  }
  if (profiles.includes("api-key")) {
    output = output.replace(/\b(sk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[redacted-api-key]");
  }
  if (profiles.includes("number")) {
    output = output.replace(/\b\d{9,16}\b/g, "[redacted-number]");
  }
  return output;
}

function redactValue(value: unknown, options: TokTraceOptions): unknown {
  if (typeof value === "string") {
    const profiles = options.redactionProfiles ?? [];
    const customHooks = options.redactionHooks ?? [];
    let redacted = applyBuiltinProfiles(value, profiles);
    for (const hook of customHooks) redacted = hook(redacted);
    return redacted;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, options));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, options)]),
    );
  }
  return value;
}

export function sanitizePromptPayload(
  options: TokTraceOptions,
  messages: unknown[] | undefined,
  body: Record<string, unknown> | undefined,
): { promptHash: string | null; messages: unknown[] | undefined; body: Record<string, unknown> | undefined } {
  if (options.capturePromptBody !== true) {
    return { promptHash: null, messages: undefined, body: undefined };
  }

  const safeMessages = messages ? (redactValue(messages, options) as unknown[]) : undefined;
  const safeBody = body ? (redactValue(body, options) as Record<string, unknown>) : undefined;
  const promptHash = safeMessages
    ? createHash("sha256").update(JSON.stringify(safeMessages)).digest("hex").slice(0, 16)
    : null;

  return { promptHash, messages: safeMessages, body: safeBody };
}

