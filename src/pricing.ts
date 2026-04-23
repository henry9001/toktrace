/** Per-token pricing in USD. Fallback returns 0 for unknown models. */

export interface ModelPricing {
  input: number;
  output: number;
}

/**
 * Static pricing table: cost per token (USD) for input and output.
 * Prices sourced from provider pricing pages. For display purposes,
 * multiply by 1_000 to get cost per 1k tokens.
 */
const PRICING: Record<string, ModelPricing> = {
  // ── OpenAI ──────────────────────────────────────────────
  "gpt-4.1":           { input: 2e-6,    output: 8e-6 },
  "gpt-4.1-mini":      { input: 0.4e-6,  output: 1.6e-6 },
  "gpt-4.1-nano":      { input: 0.1e-6,  output: 0.4e-6 },
  "gpt-4o":            { input: 2.5e-6,  output: 10e-6 },
  "gpt-4o-mini":       { input: 0.15e-6, output: 0.6e-6 },
  "gpt-4-turbo":       { input: 10e-6,   output: 30e-6 },
  "gpt-4":             { input: 30e-6,   output: 60e-6 },
  "gpt-3.5-turbo":     { input: 0.5e-6,  output: 1.5e-6 },
  "o3":                { input: 10e-6,   output: 40e-6 },
  "o3-mini":           { input: 1.1e-6,  output: 4.4e-6 },
  "o4-mini":           { input: 1.1e-6,  output: 4.4e-6 },
  "o1":                { input: 15e-6,   output: 60e-6 },
  "o1-mini":           { input: 3e-6,    output: 12e-6 },

  // ── Anthropic ───────────────────────────────────────────
  "claude-opus-4-7":              { input: 15e-6,   output: 75e-6 },
  "claude-sonnet-4-7":            { input: 3e-6,    output: 15e-6 },
  "claude-opus-4-6":              { input: 15e-6,   output: 75e-6 },
  "claude-sonnet-4-6":            { input: 3e-6,    output: 15e-6 },
  "claude-opus-4":                { input: 15e-6,   output: 75e-6 },
  "claude-sonnet-4":              { input: 3e-6,    output: 15e-6 },
  "claude-haiku-4-5":             { input: 0.8e-6,  output: 4e-6 },
  "claude-3-5-sonnet":            { input: 3e-6,    output: 15e-6 },
  "claude-3-5-haiku":             { input: 0.8e-6,  output: 4e-6 },
  "claude-3-opus":                { input: 15e-6,   output: 75e-6 },
  "claude-3-sonnet":              { input: 3e-6,    output: 15e-6 },
  "claude-3-haiku":               { input: 0.25e-6, output: 1.25e-6 },

  // ── Google Gemini ───────────────────────────────────────
  "gemini-2.5-pro":    { input: 1.25e-6, output: 10e-6 },
  "gemini-2.5-flash":  { input: 0.15e-6, output: 0.6e-6 },
  "gemini-2.0-flash":  { input: 0.1e-6,  output: 0.4e-6 },
  "gemini-1.5-pro":    { input: 1.25e-6, output: 5e-6 },
  "gemini-1.5-flash":  { input: 0.075e-6, output: 0.3e-6 },
};

/**
 * Sorted keys by descending length so longer (more specific) prefixes
 * match before shorter ones (e.g. "gpt-4o-mini" before "gpt-4o").
 */
const PREFIX_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const prefixKey = PREFIX_KEYS.find((k) => model.startsWith(k));
  const pricing = PRICING[model] ?? (prefixKey ? PRICING[prefixKey] : undefined);
  if (!pricing) return 0;
  return pricing.input * inputTokens + pricing.output * outputTokens;
}

/** Return a copy of the full pricing table (per-token rates). */
export function getPricingTable(): Record<string, ModelPricing> {
  return { ...PRICING };
}

/** Provider grouping derived from model name prefix. */
function providerFor(model: string): string {
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  return "unknown";
}

export interface PricingEntry {
  model: string;
  provider: string;
  input_per_1k: number;
  output_per_1k: number;
}

/** List all models with pricing expressed as cost per 1k tokens. */
export function listPricing(): PricingEntry[] {
  return Object.entries(PRICING).map(([model, p]) => ({
    model,
    provider: providerFor(model),
    input_per_1k: p.input * 1_000,
    output_per_1k: p.output * 1_000,
  }));
}
