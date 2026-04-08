import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LLMEvent, SuggestionCard } from "../src/types.js";
import { runRules, builtinRules } from "../src/suggestions.js";
import type { SuggestionRule } from "../src/suggestions.js";

function makeEvent(overrides: Partial<LLMEvent> = {}): LLMEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    model: "gpt-4o-mini",
    provider: "openai",
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    estimated_cost: 0.0001,
    latency_ms: 300,
    prompt_hash: null,
    app_tag: null,
    env: "test",
    tool_call_count: 0,
    ...overrides,
  };
}

describe("SuggestionCard schema", () => {
  it("cards have required fields: rule, title, impact, action, confidence", () => {
    const events = Array.from({ length: 20 }, () =>
      makeEvent({ total_tokens: 10_000, input_tokens: 8_000, output_tokens: 2_000 }),
    );
    const cards = runRules(events);

    for (const card of cards) {
      assert.ok(typeof card.rule === "string" && card.rule.length > 0, "rule must be a non-empty string");
      assert.ok(typeof card.title === "string" && card.title.length > 0, "title must be a non-empty string");
      assert.ok(typeof card.impact === "string" && card.impact.length > 0, "impact must be a non-empty string");
      assert.ok(typeof card.action === "string" && card.action.length > 0, "action must be a non-empty string");
      assert.ok(typeof card.confidence === "number", "confidence must be a number");
      assert.ok(card.confidence >= 0 && card.confidence <= 1, "confidence must be between 0 and 1");
    }
  });
});

describe("runRules", () => {
  it("returns empty array for no events", () => {
    const cards = runRules([]);
    assert.deepStrictEqual(cards, []);
  });

  it("returns empty array when no rules trigger", () => {
    const events = [makeEvent({ total_tokens: 50, latency_ms: 100 })];
    const cards = runRules(events);
    assert.deepStrictEqual(cards, []);
  });

  it("accepts custom rules", () => {
    const custom: SuggestionRule = {
      id: "always-fire",
      name: "Always Fire",
      evaluate: () => [
        {
          rule: "always-fire",
          title: "Test",
          impact: "None",
          action: "Nothing",
          confidence: 1,
        },
      ],
    };
    const cards = runRules([], [custom]);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].rule, "always-fire");
  });

  it("collects cards from multiple rules", () => {
    const ruleA: SuggestionRule = {
      id: "a",
      name: "A",
      evaluate: () => [{ rule: "a", title: "A", impact: "A", action: "A", confidence: 0.5 }],
    };
    const ruleB: SuggestionRule = {
      id: "b",
      name: "B",
      evaluate: () => [{ rule: "b", title: "B", impact: "B", action: "B", confidence: 0.8 }],
    };
    const cards = runRules([], [ruleA, ruleB]);
    assert.equal(cards.length, 2);
    assert.equal(cards[0].rule, "a");
    assert.equal(cards[1].rule, "b");
  });
});

describe("built-in rules", () => {
  it("high-token-usage fires when total tokens exceed 100k", () => {
    const events = Array.from({ length: 200 }, () =>
      makeEvent({ total_tokens: 1_000 }),
    );
    const cards = runRules(events);
    const htCard = cards.find((c) => c.rule === "high-token-usage");
    assert.ok(htCard, "high-token-usage rule should fire");
    assert.ok(htCard.confidence > 0 && htCard.confidence <= 1);
  });

  it("high-token-usage does not fire below threshold", () => {
    const events = [makeEvent({ total_tokens: 500 })];
    const cards = runRules(events);
    assert.ok(!cards.find((c) => c.rule === "high-token-usage"));
  });

  it("high-latency fires when average latency exceeds 5s", () => {
    const events = Array.from({ length: 10 }, () =>
      makeEvent({ latency_ms: 8_000 }),
    );
    const cards = runRules(events);
    const hlCard = cards.find((c) => c.rule === "high-latency");
    assert.ok(hlCard, "high-latency rule should fire");
  });

  it("high-latency does not fire with few events", () => {
    const events = [makeEvent({ latency_ms: 10_000 })];
    const cards = runRules(events);
    assert.ok(!cards.find((c) => c.rule === "high-latency"));
  });

  it("output-heavy fires when output/input ratio exceeds 3x", () => {
    const events = Array.from({ length: 10 }, () =>
      makeEvent({ input_tokens: 100, output_tokens: 500 }),
    );
    const cards = runRules(events);
    const ohCard = cards.find((c) => c.rule === "output-heavy");
    assert.ok(ohCard, "output-heavy rule should fire");
  });

  it("output-heavy does not fire with balanced usage", () => {
    const events = Array.from({ length: 10 }, () =>
      makeEvent({ input_tokens: 100, output_tokens: 100 }),
    );
    const cards = runRules(events);
    assert.ok(!cards.find((c) => c.rule === "output-heavy"));
  });

  it("repeated-static-context fires when same prompt_hash appears >5 times with >200 avg input tokens", () => {
    const events = Array.from({ length: 8 }, () =>
      makeEvent({ prompt_hash: "abc123", input_tokens: 500 }),
    );
    const cards = runRules(events);
    const rscCard = cards.find((c) => c.rule === "repeated-static-context");
    assert.ok(rscCard, "repeated-static-context rule should fire");
    assert.ok(rscCard.impact.includes("500"), "should mention token count");
    assert.ok(rscCard.impact.includes("8"), "should mention repeat count");
    assert.ok(rscCard.confidence > 0 && rscCard.confidence <= 1);
  });

  it("repeated-static-context does not fire with fewer than 6 repeated prompts", () => {
    const events = Array.from({ length: 5 }, () =>
      makeEvent({ prompt_hash: "abc123", input_tokens: 500 }),
    );
    const cards = runRules(events);
    assert.ok(!cards.find((c) => c.rule === "repeated-static-context"));
  });

  it("repeated-static-context does not fire when avg input tokens <= 200", () => {
    const events = Array.from({ length: 10 }, () =>
      makeEvent({ prompt_hash: "abc123", input_tokens: 100 }),
    );
    const cards = runRules(events);
    assert.ok(!cards.find((c) => c.rule === "repeated-static-context"));
  });

  it("repeated-static-context ignores events without prompt_hash", () => {
    const events = Array.from({ length: 10 }, () =>
      makeEvent({ prompt_hash: null, input_tokens: 500 }),
    );
    const cards = runRules(events);
    assert.ok(!cards.find((c) => c.rule === "repeated-static-context"));
  });

  it("repeated-static-context picks the most repeated pattern", () => {
    const frequent = Array.from({ length: 12 }, () =>
      makeEvent({ prompt_hash: "frequent", input_tokens: 300 }),
    );
    const less = Array.from({ length: 7 }, () =>
      makeEvent({ prompt_hash: "less-frequent", input_tokens: 400 }),
    );
    const cards = runRules([...frequent, ...less]);
    const rscCard = cards.find((c) => c.rule === "repeated-static-context");
    assert.ok(rscCard, "rule should fire");
    assert.ok(rscCard.impact.includes("12"), "should report the most repeated pattern count");
  });

  it("high-retry-loop fires when 3+ identical prompts occur within 60s", () => {
    const now = Date.now();
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        prompt_hash: "retry-hash",
        input_tokens: 400,
        timestamp: new Date(now + i * 5_000).toISOString(), // 5s apart
      }),
    );
    const cards = runRules(events);
    const hrlCard = cards.find((c) => c.rule === "high-retry-loop");
    assert.ok(hrlCard, "high-retry-loop rule should fire");
    assert.ok(hrlCard.impact.includes("5"), "should mention burst count");
    assert.ok(hrlCard.confidence > 0 && hrlCard.confidence <= 1);
  });

  it("high-retry-loop does not fire with fewer than 3 identical prompts in window", () => {
    const now = Date.now();
    const events = Array.from({ length: 2 }, (_, i) =>
      makeEvent({
        prompt_hash: "retry-hash",
        input_tokens: 400,
        timestamp: new Date(now + i * 5_000).toISOString(),
      }),
    );
    const cards = runRules(events);
    assert.ok(!cards.find((c) => c.rule === "high-retry-loop"));
  });

  it("high-retry-loop does not fire when prompts are spread beyond 60s window", () => {
    const now = Date.now();
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        prompt_hash: "spread-hash",
        input_tokens: 400,
        timestamp: new Date(now + i * 30_000).toISOString(), // 30s apart = 120s total span
      }),
    );
    const cards = runRules(events);
    assert.ok(!cards.find((c) => c.rule === "high-retry-loop"));
  });

  it("high-retry-loop does not fire when prompt_hash is null", () => {
    const now = Date.now();
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        prompt_hash: null,
        input_tokens: 400,
        timestamp: new Date(now + i * 5_000).toISOString(),
      }),
    );
    const cards = runRules(events);
    assert.ok(!cards.find((c) => c.rule === "high-retry-loop"));
  });

  it("high-retry-loop picks the worst burst across hash groups", () => {
    const now = Date.now();
    const small = Array.from({ length: 3 }, (_, i) =>
      makeEvent({
        prompt_hash: "small-burst",
        input_tokens: 200,
        timestamp: new Date(now + i * 2_000).toISOString(),
      }),
    );
    const large = Array.from({ length: 7 }, (_, i) =>
      makeEvent({
        prompt_hash: "large-burst",
        input_tokens: 300,
        timestamp: new Date(now + i * 3_000).toISOString(),
      }),
    );
    const cards = runRules([...small, ...large]);
    const hrlCard = cards.find((c) => c.rule === "high-retry-loop");
    assert.ok(hrlCard, "rule should fire");
    assert.ok(hrlCard.impact.includes("7"), "should report the larger burst");
  });

  it("high-retry-loop reports wasted tokens correctly", () => {
    const now = Date.now();
    const events = Array.from({ length: 4 }, (_, i) =>
      makeEvent({
        prompt_hash: "waste-hash",
        input_tokens: 1000,
        timestamp: new Date(now + i * 1_000).toISOString(),
      }),
    );
    const cards = runRules(events);
    const hrlCard = cards.find((c) => c.rule === "high-retry-loop");
    assert.ok(hrlCard, "rule should fire");
    // 4 calls * 1000 tokens avg = 3000 wasted (count-1 redundant)
    assert.ok(hrlCard.impact.includes("3,000") || hrlCard.impact.includes("3000"), "should report ~3000 wasted tokens");
  });

  it("too-many-tool-calls fires when events have >5 tool calls", () => {
    const events = Array.from({ length: 3 }, () =>
      makeEvent({ tool_call_count: 8 }),
    );
    const cards = runRules(events);
    const tmtcCard = cards.find((c) => c.rule === "too-many-tool-calls");
    assert.ok(tmtcCard, "too-many-tool-calls rule should fire");
    assert.ok(tmtcCard.impact.includes("3"), "should mention offending response count");
    assert.ok(tmtcCard.impact.includes("8"), "should mention avg/max tool calls");
    assert.ok(tmtcCard.confidence > 0 && tmtcCard.confidence <= 1);
  });

  it("too-many-tool-calls does not fire when tool_call_count <= 5", () => {
    const events = Array.from({ length: 10 }, () =>
      makeEvent({ tool_call_count: 5 }),
    );
    const cards = runRules(events);
    assert.ok(!cards.find((c) => c.rule === "too-many-tool-calls"));
  });

  it("too-many-tool-calls does not fire with zero tool calls", () => {
    const events = Array.from({ length: 10 }, () =>
      makeEvent({ tool_call_count: 0 }),
    );
    const cards = runRules(events);
    assert.ok(!cards.find((c) => c.rule === "too-many-tool-calls"));
  });

  it("too-many-tool-calls reports correct max when mixed events", () => {
    const events = [
      makeEvent({ tool_call_count: 3 }),
      makeEvent({ tool_call_count: 12 }),
      makeEvent({ tool_call_count: 7 }),
      makeEvent({ tool_call_count: 2 }),
    ];
    const cards = runRules(events);
    const tmtcCard = cards.find((c) => c.rule === "too-many-tool-calls");
    assert.ok(tmtcCard, "rule should fire for events exceeding threshold");
    assert.ok(tmtcCard.impact.includes("2 response"), "should count only offending events");
    assert.ok(tmtcCard.impact.includes("max 12"), "should report max tool calls");
  });

  it("all builtin rules have unique IDs", () => {
    const ids = builtinRules.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "rule IDs must be unique");
  });
});
