import type { TokTraceOptions } from "./types.js";
import * as openaiPatch from "./patches/openai.js";
import * as anthropicPatch from "./patches/anthropic.js";

interface PatchModule {
  name: string;
  isEnabled(options: TokTraceOptions): boolean;
  apply(options: TokTraceOptions): boolean;
}

const patches: PatchModule[] = [openaiPatch, anthropicPatch];

let initialized = false;

/**
 * Initialize TokTrace. Call this once at the start of your application
 * to enable automatic LLM call tracing.
 *
 * Iterates all known SDK patch modules and applies those that are
 * enabled (all on by default) and whose SDK is installed.
 */
export function init(options: TokTraceOptions = {}): void {
  if (initialized) return;
  initialized = true;

  for (const patch of patches) {
    if (patch.isEnabled(options)) {
      patch.apply(options);
    }
  }
}
