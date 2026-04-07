/** Per-token pricing in USD. Fallback returns 0 for unknown models. */

interface ModelPricing {
  input: number;
  output: number;
}

const PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "gpt-4o": { input: 2.5e-6, output: 10e-6 },
  "gpt-4o-mini": { input: 0.15e-6, output: 0.6e-6 },
  "gpt-4-turbo": { input: 10e-6, output: 30e-6 },
  "gpt-4": { input: 30e-6, output: 60e-6 },
  "gpt-3.5-turbo": { input: 0.5e-6, output: 1.5e-6 },
  "o1": { input: 15e-6, output: 60e-6 },
  "o1-mini": { input: 3e-6, output: 12e-6 },
  "o3-mini": { input: 1.1e-6, output: 4.4e-6 },
  // Anthropic
  "claude-opus-4-20250514": { input: 15e-6, output: 75e-6 },
  "claude-sonnet-4-20250514": { input: 3e-6, output: 15e-6 },
  "claude-3-5-sonnet-20241022": { input: 3e-6, output: 15e-6 },
  "claude-3-5-haiku-20241022": { input: 0.8e-6, output: 4e-6 },
  "claude-3-opus-20240229": { input: 15e-6, output: 75e-6 },
  "claude-3-sonnet-20240229": { input: 3e-6, output: 15e-6 },
  "claude-3-haiku-20240307": { input: 0.25e-6, output: 1.25e-6 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model]
    ?? Object.entries(PRICING).find(([k]) => model.startsWith(k))?.[1];
  if (!pricing) return 0;
  return pricing.input * inputTokens + pricing.output * outputTokens;
}
