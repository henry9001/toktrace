import type { TokTraceOptions } from "./types.js";
import { loadConfig } from "./config.js";
import * as openaiPatch from "./patches/openai.js";
import * as anthropicPatch from "./patches/anthropic.js";
import * as genericHttpPatch from "./patches/generic-http.js";

interface PatchModule {
  name: string;
  isEnabled(options: TokTraceOptions): boolean;
  apply(options: TokTraceOptions): boolean;
}

const patches: PatchModule[] = [openaiPatch, anthropicPatch, genericHttpPatch];

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
  const config = loadConfig();
  const effectiveOptions: TokTraceOptions = {
    ...options,
    capturePromptBody: options.capturePromptBody ?? config.privacy?.capture_prompt_body ?? false,
    redactionProfiles: options.redactionProfiles ?? config.privacy?.redaction_hooks ?? [],
  };

  for (const patch of patches) {
    if (patch.isEnabled(effectiveOptions)) {
      patch.apply(effectiveOptions);
    }
  }
}
