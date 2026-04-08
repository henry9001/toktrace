import type { LLMEvent, SuggestionCard } from "./types.js";
import { getPricingTable } from "./pricing.js";

/** A rule module that evaluates event history and produces suggestion cards. */
export interface SuggestionRule {
  /** Unique rule identifier, used as the `rule` field in emitted cards. */
  id: string;
  /** Human-readable rule name. */
  name: string;
  /** Evaluate the rule against a set of events. Return zero or more cards. */
  evaluate(events: LLMEvent[]): SuggestionCard[];
}

// ── Built-in rules ──────────────────────────────────────────────────────

const highTokenUsage: SuggestionRule = {
  id: "high-token-usage",
  name: "High Token Usage",
  evaluate(events) {
    const total = events.reduce((sum, e) => sum + e.total_tokens, 0);
    if (total <= 100_000) return [];
    return [
      {
        rule: this.id,
        title: "High token usage detected",
        impact: `${total.toLocaleString()} tokens consumed — reducing prompt length could significantly cut costs.`,
        action: "Review prompts for unnecessary context, repeated instructions, or verbose system messages.",
        confidence: Math.min(1, total / 500_000),
      },
    ];
  },
};

const modelDowngrade: SuggestionRule = {
  id: "model-downgrade",
  name: "Model Downgrade Opportunity",
  evaluate(events) {
    const pricing = getPricingTable();
    const byModel: Record<string, { cost: number; count: number }> = {};
    for (const e of events) {
      if (!byModel[e.model]) byModel[e.model] = { cost: 0, count: 0 };
      byModel[e.model].cost += e.estimated_cost;
      byModel[e.model].count += 1;
    }

    const cards: SuggestionCard[] = [];
    const sorted = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost);
    if (sorted.length === 0) return cards;

    const [topModel, topStats] = sorted[0];
    if (topStats.cost <= 0.10) return cards;

    const topPricing = pricing[topModel];
    if (!topPricing) return cards;

    // Find a cheaper alternative from the same provider
    const provider = topModel.startsWith("claude-")
      ? "claude-"
      : topModel.startsWith("gpt-")
        ? "gpt-"
        : topModel.startsWith("gemini-")
          ? "gemini-"
          : null;

    if (!provider) return cards;

    const cheaper = Object.entries(pricing).find(
      ([m, p]) =>
        m !== topModel &&
        m.startsWith(provider) &&
        p.input < topPricing.input &&
        p.output < topPricing.output,
    );

    if (cheaper) {
      const savings = topStats.cost * (1 - (cheaper[1].input + cheaper[1].output) / (topPricing.input + topPricing.output));
      cards.push({
        rule: this.id,
        title: `Consider ${cheaper[0]} instead of ${topModel}`,
        impact: `Top spender: ${topModel} ($${topStats.cost.toFixed(4)} across ${topStats.count} calls). Switching could save ~$${savings.toFixed(4)}.`,
        action: `Evaluate whether ${cheaper[0]} meets quality requirements for your use case, then route low-stakes calls to it.`,
        confidence: 0.6,
      });
    }

    return cards;
  },
};

const highLatency: SuggestionRule = {
  id: "high-latency",
  name: "High Latency Detection",
  evaluate(events) {
    if (events.length < 5) return [];
    const avgLatency = events.reduce((sum, e) => sum + e.latency_ms, 0) / events.length;
    if (avgLatency <= 5000) return [];

    return [
      {
        rule: this.id,
        title: "Average latency is high",
        impact: `Average latency is ${Math.round(avgLatency)}ms across ${events.length} calls — this may indicate oversized prompts or slow model selections.`,
        action: "Consider shorter prompts, streaming responses, or switching to a faster model for latency-sensitive paths.",
        confidence: Math.min(1, avgLatency / 15_000),
      },
    ];
  },
};

const outputHeavy: SuggestionRule = {
  id: "output-heavy",
  name: "Output-Heavy Usage Pattern",
  evaluate(events) {
    const totalInput = events.reduce((sum, e) => sum + e.input_tokens, 0);
    const totalOutput = events.reduce((sum, e) => sum + e.output_tokens, 0);
    if (totalInput === 0 || totalOutput === 0) return [];

    const ratio = totalOutput / totalInput;
    if (ratio <= 3) return [];

    return [
      {
        rule: this.id,
        title: "Output tokens dominate usage",
        impact: `Output/input ratio is ${ratio.toFixed(1)}x — output tokens are typically more expensive per token.`,
        action: "Use max_tokens or stop sequences to limit generation length where full responses aren't needed.",
        confidence: Math.min(1, ratio / 10),
      },
    ];
  },
};

const repeatedStaticContext: SuggestionRule = {
  id: "repeated-static-context",
  name: "Repeated Static Context Chunk",
  evaluate(events) {
    // Group events by prompt_hash (skip events without a hash)
    const byHash: Record<string, { count: number; totalInputTokens: number }> = {};
    for (const e of events) {
      if (!e.prompt_hash) continue;
      if (!byHash[e.prompt_hash]) byHash[e.prompt_hash] = { count: 0, totalInputTokens: 0 };
      byHash[e.prompt_hash].count += 1;
      byHash[e.prompt_hash].totalInputTokens += e.input_tokens;
    }

    // Find hashes repeated in >5 calls where avg input >200 tokens
    const candidates = Object.entries(byHash).filter(([, stats]) => {
      const avgInput = stats.totalInputTokens / stats.count;
      return stats.count > 5 && avgInput > 200;
    });

    if (candidates.length === 0) return [];

    // Pick the most repeated pattern
    candidates.sort((a, b) => b[1].count - a[1].count);
    const [, top] = candidates[0];
    const avgTokens = Math.round(top.totalInputTokens / top.count);
    const wastedTokens = avgTokens * (top.count - 1);

    return [
      {
        rule: this.id,
        title: "Repeated static context detected",
        impact: `The same prompt (~${avgTokens.toLocaleString()} input tokens) was sent ${top.count} times — ~${wastedTokens.toLocaleString()} redundant tokens across ${candidates.length} repeated pattern${candidates.length > 1 ? "s" : ""}.`,
        action: "Extract the repeated content into a cached system prompt (e.g. Anthropic prompt caching, OpenAI cached completions) or deduplicate by moving static context to a shared prefix.",
        confidence: Math.min(1, top.count / 20),
      },
    ];
  },
};

/** All built-in rules, in evaluation order. */
export const builtinRules: SuggestionRule[] = [
  highTokenUsage,
  modelDowngrade,
  highLatency,
  outputHeavy,
  repeatedStaticContext,
];

/**
 * Run suggestion rules against a set of LLM events and collect all resulting cards.
 *
 * @param events - Event history to evaluate
 * @param rules  - Rules to run; defaults to all built-in rules
 * @returns Array of suggestion cards from all rules
 */
export function runRules(
  events: LLMEvent[],
  rules?: SuggestionRule[],
): SuggestionCard[] {
  const activeRules = rules ?? builtinRules;
  return activeRules.flatMap((rule) => rule.evaluate(events));
}
