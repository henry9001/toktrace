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

const highRetryLoop: SuggestionRule = {
  id: "high-retry-loop",
  name: "High Retry Loop / Similar Prompt Repeat",
  evaluate(events) {
    const WINDOW_MS = 60_000; // 60-second window for burst detection
    const MIN_BURST_SIZE = 3;

    // Group events by prompt_hash (skip events without a hash)
    const byHash: Record<string, LLMEvent[]> = {};
    for (const e of events) {
      if (!e.prompt_hash) continue;
      if (!byHash[e.prompt_hash]) byHash[e.prompt_hash] = [];
      byHash[e.prompt_hash].push(e);
    }

    // Find the worst temporal burst across all hash groups
    let worstBurst: {
      count: number;
      spanMs: number;
      totalInputTokens: number;
    } | null = null;
    let totalBurstGroups = 0;

    for (const group of Object.values(byHash)) {
      if (group.length < MIN_BURST_SIZE) continue;

      group.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      // Sliding window to find the largest burst within WINDOW_MS
      let maxBurstSize = 0;
      let maxBurstStart = 0;
      let maxBurstEnd = 0;
      let start = 0;

      for (let end = 0; end < group.length; end++) {
        const endTime = new Date(group[end].timestamp).getTime();
        while (
          endTime - new Date(group[start].timestamp).getTime() >=
          WINDOW_MS
        ) {
          start++;
        }
        const burstSize = end - start + 1;
        if (burstSize > maxBurstSize) {
          maxBurstSize = burstSize;
          maxBurstStart = start;
          maxBurstEnd = end;
        }
      }

      if (maxBurstSize >= MIN_BURST_SIZE) {
        totalBurstGroups++;
        const tokens = group
          .slice(maxBurstStart, maxBurstEnd + 1)
          .reduce((s, e) => s + e.input_tokens, 0);
        const span =
          new Date(group[maxBurstEnd].timestamp).getTime() -
          new Date(group[maxBurstStart].timestamp).getTime();

        if (!worstBurst || maxBurstSize > worstBurst.count) {
          worstBurst = {
            count: maxBurstSize,
            spanMs: span,
            totalInputTokens: tokens,
          };
        }
      }
    }

    if (!worstBurst) return [];

    const avgTokens = Math.round(worstBurst.totalInputTokens / worstBurst.count);
    const wastedTokens = avgTokens * (worstBurst.count - 1);

    return [
      {
        rule: this.id,
        title: "Retry loop detected",
        impact: `${worstBurst.count} near-identical prompts fired within ${Math.round(worstBurst.spanMs / 1000)}s — ~${wastedTokens.toLocaleString()} redundant tokens across ${totalBurstGroups} detected burst${totalBurstGroups > 1 ? "s" : ""}.`,
        action:
          "Add response caching, exponential backoff, or a circuit-breaker to avoid redundant retries.",
        confidence: Math.min(1, worstBurst.count / 10),
      },
    ];
  },
};

const tooManyToolCalls: SuggestionRule = {
  id: "too-many-tool-calls",
  name: "Too Many Tool Calls Per Response",
  evaluate(events) {
    const THRESHOLD = 5;
    const offending = events.filter((e) => e.tool_call_count > THRESHOLD);
    if (offending.length === 0) return [];

    const totalToolCalls = offending.reduce((s, e) => s + e.tool_call_count, 0);
    const avgToolCalls = Math.round(totalToolCalls / offending.length);
    const maxToolCalls = Math.max(...offending.map((e) => e.tool_call_count));

    return [
      {
        rule: this.id,
        title: "Too many tool calls per response",
        impact: `${offending.length} response${offending.length > 1 ? "s" : ""} had >${THRESHOLD} tool calls (avg ${avgToolCalls}, max ${maxToolCalls}) — each tool call adds latency and token overhead from serialized results.`,
        action:
          "Batch related operations into fewer tools, reduce tool definition granularity, or split complex tasks across multiple turns to lower per-response tool call count.",
        confidence: Math.min(1, offending.length / 10),
      },
    ];
  },
};

const excessiveContextGrowth: SuggestionRule = {
  id: "excessive-context-growth",
  name: "Excessive Context Passed Between Tool Cycles",
  evaluate(events) {
    if (events.length < 2) return [];

    const MIN_INPUT_TOKENS = 500;
    const GROWTH_THRESHOLD = 0.5; // 50%

    const sorted = [...events]
      .filter((e) => e.input_tokens >= MIN_INPUT_TOKENS)
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

    if (sorted.length < 2) return [];

    let spikes = 0;
    let maxGrowthPct = 0;
    let totalGrowthTokens = 0;

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].input_tokens;
      const curr = sorted[i].input_tokens;
      const growth = (curr - prev) / prev;

      if (growth > GROWTH_THRESHOLD) {
        spikes++;
        totalGrowthTokens += curr - prev;
        if (growth > maxGrowthPct) maxGrowthPct = growth;
      }
    }

    if (spikes === 0) return [];

    return [
      {
        rule: this.id,
        title: "Context size growing rapidly between calls",
        impact: `${spikes} consecutive call pair${spikes > 1 ? "s" : ""} showed >${Math.round(GROWTH_THRESHOLD * 100)}% context growth (worst ${Math.round(maxGrowthPct * 100)}%, ~${totalGrowthTokens.toLocaleString()} added tokens) — suggests tool results are accumulating in context without pruning.`,
        action:
          "Summarize or truncate tool results before appending to context, use sliding-window context management, or drop earlier tool outputs once consumed.",
        confidence: Math.min(1, spikes / 5),
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
  highRetryLoop,
  tooManyToolCalls,
  excessiveContextGrowth,
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
