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

function normalizeToolParams(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  if (Array.isArray(raw)) return raw.map(normalizeToolParams).join("|");
  return Object.entries(raw as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v)}`)
    .join("|");
}

function parseToolCalls(value: string | null): Array<{ name: string; paramsKey: string }> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((call) => {
        const name = typeof call?.name === "string" ? call.name : "unknown";
        const paramsKey = normalizeToolParams(call?.arguments ?? call?.params ?? call?.input ?? null);
        return { name, paramsKey };
      })
      .filter((c) => c.paramsKey.length > 0);
  } catch {
    return [];
  }
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
        evidence: `Analyzed ${events.length} events with ${total.toLocaleString()} total tokens.`,
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
        evidence: `${topModel} accounts for $${topStats.cost.toFixed(4)} across ${topStats.count} calls.`,
        impact: `Switching similar low-stakes traffic could save ~$${savings.toFixed(4)} in the current window.`,
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
        evidence: `Average latency is ${Math.round(avgLatency)}ms across ${events.length} calls.`,
        impact: "Slow responses often signal oversized prompts, tool fan-out, or expensive model choices.",
        action: "Consider shorter prompts, streaming responses, or switching to a faster model for latency-sensitive paths.",
        confidence: Math.min(1, avgLatency / 15_000),
      },
    ];
  },
};

const repeatedStaticContext: SuggestionRule = {
  id: "repeated-static-context",
  name: "Repeated Static Context Chunk",
  evaluate(events) {
    const byHash: Record<string, { count: number; totalInputTokens: number }> = {};
    for (const e of events) {
      if (!e.prompt_hash) continue;
      if (!byHash[e.prompt_hash]) byHash[e.prompt_hash] = { count: 0, totalInputTokens: 0 };
      byHash[e.prompt_hash].count += 1;
      byHash[e.prompt_hash].totalInputTokens += e.input_tokens;
    }

    const candidates = Object.entries(byHash).filter(([, stats]) => {
      const avgInput = stats.totalInputTokens / stats.count;
      return stats.count > 5 && avgInput > 200;
    });

    if (candidates.length === 0) return [];
    candidates.sort((a, b) => b[1].count - a[1].count);

    const [hash, top] = candidates[0];
    const avgTokens = Math.round(top.totalInputTokens / top.count);
    const wastedTokens = avgTokens * (top.count - 1);

    return [
      {
        rule: this.id,
        title: "Repeated static context detected",
        evidence: `prompt_hash=${hash.slice(0, 12)} repeated ${top.count}x (avg ${avgTokens.toLocaleString()} input tokens).`,
        impact: `~${wastedTokens.toLocaleString()} redundant input tokens were likely re-sent in this window.`,
        action: "Extract repeated content into a cached system prompt or move static context into reusable prefixes.",
        confidence: Math.min(1, top.count / 20),
      },
    ];
  },
};

const repeatedToolParams: SuggestionRule = {
  id: "repeated-tool-params",
  name: "Repeated Near-Identical Tool Params",
  evaluate(events) {
    const WINDOW_MS = 2 * 60_000;
    const MIN_REPEAT = 3;
    const bySignature: Record<string, number[]> = {};

    for (const event of events) {
      const t = new Date(event.timestamp).getTime();
      for (const call of parseToolCalls(event.tool_calls)) {
        const key = `${call.name}::${call.paramsKey}`;
        if (!bySignature[key]) bySignature[key] = [];
        bySignature[key].push(t);
      }
    }

    let worst: { signature: string; count: number; spanMs: number } | null = null;

    for (const [signature, times] of Object.entries(bySignature)) {
      times.sort((a, b) => a - b);
      let start = 0;
      for (let end = 0; end < times.length; end++) {
        while (times[end] - times[start] > WINDOW_MS) start++;
        const count = end - start + 1;
        if (count >= MIN_REPEAT) {
          const span = times[end] - times[start];
          if (!worst || count > worst.count) {
            worst = { signature, count, spanMs: span };
          }
        }
      }
    }

    if (!worst) return [];

    return [
      {
        rule: this.id,
        title: "Repeated near-identical tool params detected",
        evidence: `${worst.count} matching tool calls for ${worst.signature.slice(0, 48)} within ${Math.round(worst.spanMs / 1000)}s.`,
        impact: "Repeated tool requests increase latency and token overhead without adding new information.",
        action: "Add idempotency guards, cache tool responses by parameter hash, or debounce re-requests in orchestration logic.",
        confidence: Math.min(1, worst.count / 8),
      },
    ];
  },
};

const overlongContext: SuggestionRule = {
  id: "overlong-context",
  name: "Overlong Prompt/System Context",
  evaluate(events) {
    const threshold = 8_000;
    const offenders = events.filter((e) => e.input_tokens >= threshold);
    if (offenders.length === 0) return [];

    const worst = offenders.reduce((max, e) => Math.max(max, e.input_tokens), 0);
    return [
      {
        rule: this.id,
        title: "Overlong prompt/context detected",
        evidence: `${offenders.length} calls exceeded ${threshold.toLocaleString()} input tokens (max ${worst.toLocaleString()}).`,
        impact: "Large contexts raise cost, latency, and increase chance of repeated static payloads.",
        action: "Trim static instructions, summarize long transcripts, and pass only the most recent/relevant context.",
        confidence: Math.min(1, offenders.length / Math.max(events.length, 1) + 0.2),
      },
    ];
  },
};

/** All built-in rules, in evaluation order. */
export const builtinRules: SuggestionRule[] = [
  highTokenUsage,
  modelDowngrade,
  highLatency,
  repeatedStaticContext,
  repeatedToolParams,
  overlongContext,
];

export function runRules(
  events: LLMEvent[],
  rules?: SuggestionRule[],
): SuggestionCard[] {
  const activeRules = rules ?? builtinRules;
  return activeRules.flatMap((rule) => rule.evaluate(events));
}
