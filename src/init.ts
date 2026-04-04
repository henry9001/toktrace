import type { TokTraceOptions } from "./types.js";

/**
 * Initialize TokTrace. Call this once at the start of your application
 * to enable automatic LLM call tracing.
 */
export function init(_options: TokTraceOptions = {}): void {
  // Instrumentation hooks will be wired in subsequent epics
}
