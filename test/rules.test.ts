import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSummary } from "../src/index.js";
import type { LLMEvent } from "../src/index.js";

function makeEvent(overrides: Partial<LLMEvent> & { id: string }): LLMEvent {
  return {
    timestamp: new Date().toISOString(),
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    estimated_cost: 0.00075,
    latency_ms: 400,
    prompt_hash: null,
    app_tag: null,
    env: "test",
    ...overrides,
  };
}

describe("TokTrace E3: buildSummary rules", () => {
  it("flags calls with large prompt and low output ratio", () => {
    const events = [
      makeEvent({
        id: "rule-001",
        input_tokens: 5000,
        output_tokens: 200, // 4% of input — below 10% threshold
        total_tokens: 5200,
      }),
      makeEvent({
        id: "rule-002",
        input_tokens: 3000,
        output_tokens: 100, // 3.3% of input — below 10% threshold
        total_tokens: 3100,
      }),
    ];

    const summary = buildSummary(events);
    const match = summary.suggestions.find((s) => s.includes("output ratio"));
    assert.ok(match, "should include low output ratio suggestion");
    assert.ok(match.includes("2 call(s)"), "should count both flagged calls");
    assert.ok(match.includes("prompt compression or caching"), "should suggest compression or caching");
  });

  it("does not flag calls with normal output ratio", () => {
    const events = [
      makeEvent({
        id: "rule-003",
        input_tokens: 3000,
        output_tokens: 500, // 16.7% — above threshold
        total_tokens: 3500,
      }),
    ];

    const summary = buildSummary(events);
    const match = summary.suggestions.find((s) => s.includes("output ratio"));
    assert.equal(match, undefined, "should not flag normal ratio calls");
  });

  it("does not flag small prompts even with low ratio", () => {
    const events = [
      makeEvent({
        id: "rule-004",
        input_tokens: 500, // below 2000 threshold
        output_tokens: 10, // 2% — low ratio but small prompt
        total_tokens: 510,
      }),
    ];

    const summary = buildSummary(events);
    const match = summary.suggestions.find((s) => s.includes("output ratio"));
    assert.equal(match, undefined, "should not flag small prompts");
  });

  it("flags exactly at the boundary (input=2001, output < 10%)", () => {
    const events = [
      makeEvent({
        id: "rule-005",
        input_tokens: 2001,
        output_tokens: 199, // 9.95% — just below 10%
        total_tokens: 2200,
      }),
    ];

    const summary = buildSummary(events);
    const match = summary.suggestions.find((s) => s.includes("output ratio"));
    assert.ok(match, "should flag call just above 2000 input with <10% output");
    assert.ok(match.includes("1 call(s)"), "should count one flagged call");
  });

  it("does not flag at exact 10% output ratio", () => {
    const events = [
      makeEvent({
        id: "rule-006",
        input_tokens: 3000,
        output_tokens: 300, // exactly 10%
        total_tokens: 3300,
      }),
    ];

    const summary = buildSummary(events);
    const match = summary.suggestions.find((s) => s.includes("output ratio"));
    assert.equal(match, undefined, "should not flag exactly 10% ratio");
  });
});
