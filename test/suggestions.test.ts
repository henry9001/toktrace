import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LLMEvent } from "../src/types.js";
import { runRules } from "../src/suggestions.js";
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
    tool_calls: null,
    context_size_tokens: 100,
    tool_call_count: 0,
    ...overrides,
  };
}

describe("SuggestionCard schema", () => {
  it("cards have required fields including evidence", () => {
    const events = Array.from({ length: 20 }, () => makeEvent({ total_tokens: 10_000, input_tokens: 8_000, output_tokens: 2_000 }));
    const cards = runRules(events);

    for (const card of cards) {
      assert.ok(card.rule.length > 0);
      assert.ok(card.title.length > 0);
      assert.ok(card.evidence.length > 0);
      assert.ok(card.impact.length > 0);
      assert.ok(card.action.length > 0);
      assert.ok(card.confidence >= 0 && card.confidence <= 1);
    }
  });
});

describe("runRules", () => {
  it("returns empty array for no events", () => {
    assert.deepStrictEqual(runRules([]), []);
  });

  it("accepts custom rules", () => {
    const custom: SuggestionRule = {
      id: "always-fire",
      name: "Always Fire",
      evaluate: () => [{
        rule: "always-fire",
        title: "Test",
        evidence: "test evidence",
        impact: "None",
        action: "Nothing",
        confidence: 1,
      }],
    };
    const cards = runRules([], [custom]);
    assert.equal(cards.length, 1);
  });

  it("repeated-tool-params fires on near-identical tool arguments in time window", () => {
    const now = Date.now();
    const toolCalls = JSON.stringify([{ name: "search_docs", arguments: { query: "billing api", team: "platform" } }]);
    const events = Array.from({ length: 4 }, (_, i) => makeEvent({
      timestamp: new Date(now + i * 15_000).toISOString(),
      tool_calls: toolCalls,
    }));

    const cards = runRules(events);
    assert.ok(cards.find((c) => c.rule === "repeated-tool-params"));
  });

  it("overlong-context fires on huge input payloads", () => {
    const events = [makeEvent({ input_tokens: 10_000 })];
    const cards = runRules(events);
    assert.ok(cards.find((c) => c.rule === "overlong-context"));
  });
});
