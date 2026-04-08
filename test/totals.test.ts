import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initStore, insertEvent, queryAggregate, listDistinctModels, listDistinctRoutes } from "../src/index.js";
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

describe("TokTrace E2: Totals view", () => {
  let tmpDir: string;
  let dbPath: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "toktrace-totals-"));
    dbPath = join(tmpDir, "events.db");
    initStore(dbPath);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("queryAggregate returns zeros when no events exist", () => {
    const agg = queryAggregate({}, dbPath);
    assert.equal(agg.input_tokens, 0);
    assert.equal(agg.output_tokens, 0);
    assert.equal(agg.total_tokens, 0);
    assert.equal(agg.estimated_cost, 0);
    assert.equal(agg.event_count, 0);
    assert.deepEqual(agg.by_model, []);
  });

  it("queryAggregate sums tokens and cost across events", () => {
    const now = new Date();

    insertEvent(
      makeEvent({
        id: "totals-001",
        timestamp: now.toISOString(),
        model: "gpt-4o",
        input_tokens: 200,
        output_tokens: 100,
        total_tokens: 300,
        estimated_cost: 0.0015,
      }),
      dbPath
    );

    insertEvent(
      makeEvent({
        id: "totals-002",
        timestamp: now.toISOString(),
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        input_tokens: 500,
        output_tokens: 200,
        total_tokens: 700,
        estimated_cost: 0.0045,
      }),
      dbPath
    );

    const agg = queryAggregate({}, dbPath);
    assert.equal(agg.input_tokens, 700, "sum of input tokens");
    assert.equal(agg.output_tokens, 300, "sum of output tokens");
    assert.equal(agg.total_tokens, 1000, "sum of total tokens");
    assert.equal(agg.event_count, 2, "two events");
    assert.ok(
      Math.abs(agg.estimated_cost - 0.006) < 1e-9,
      "sum of estimated cost"
    );
  });

  it("queryAggregate groups by model ordered by cost desc", () => {
    const agg = queryAggregate({}, dbPath);
    assert.ok(agg.by_model.length >= 2, "at least 2 models");
    // claude-sonnet-4-6 costs more ($0.0045) than gpt-4o ($0.0015)
    assert.equal(agg.by_model[0].model, "claude-sonnet-4-6");
    assert.equal(agg.by_model[1].model, "gpt-4o");
  });

  it("queryAggregate filters by since timestamp", () => {
    const oldDate = new Date("2020-01-01T00:00:00Z");
    insertEvent(
      makeEvent({
        id: "totals-003",
        timestamp: oldDate.toISOString(),
        input_tokens: 999,
        output_tokens: 999,
        total_tokens: 1998,
        estimated_cost: 99.0,
      }),
      dbPath
    );

    // Query since today — should NOT include the 2020 event
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const agg = queryAggregate({ since: todayStart.toISOString() }, dbPath);
    assert.equal(agg.event_count, 2, "only today's 2 events");
    assert.equal(agg.total_tokens, 1000, "only today's tokens");

    // Query with no filter — should include all 3
    const all = queryAggregate({}, dbPath);
    assert.equal(all.event_count, 3, "all 3 events");
  });

  it("queryAggregate filters by model", () => {
    const agg = queryAggregate({ model: "gpt-4o" }, dbPath);
    assert.equal(agg.event_count, 2, "gpt-4o events (totals-001 + totals-003)");
    assert.equal(agg.by_model.length, 1);
    assert.equal(agg.by_model[0].model, "gpt-4o");
  });

  it("queryAggregate filters by appTag", () => {
    insertEvent(
      makeEvent({
        id: "totals-004",
        model: "gpt-4o",
        app_tag: "/api/chat",
        input_tokens: 50,
        output_tokens: 25,
        total_tokens: 75,
        estimated_cost: 0.001,
      }),
      dbPath
    );

    const agg = queryAggregate({ appTag: "/api/chat" }, dbPath);
    assert.equal(agg.event_count, 1);
    assert.equal(agg.total_tokens, 75);
  });

  it("queryAggregate filters by model + appTag combined", () => {
    insertEvent(
      makeEvent({
        id: "totals-005",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        app_tag: "/api/chat",
        input_tokens: 80,
        output_tokens: 40,
        total_tokens: 120,
        estimated_cost: 0.002,
      }),
      dbPath
    );

    const agg = queryAggregate({ model: "claude-sonnet-4-6", appTag: "/api/chat" }, dbPath);
    assert.equal(agg.event_count, 1, "only the claude event with /api/chat");
    assert.equal(agg.total_tokens, 120);
  });

  it("listDistinctModels returns sorted unique models", () => {
    const models = listDistinctModels(dbPath);
    assert.ok(models.includes("gpt-4o"));
    assert.ok(models.includes("claude-sonnet-4-6"));
    assert.equal(models.length, 2);
  });

  it("listDistinctRoutes returns sorted unique non-null app_tags", () => {
    const routes = listDistinctRoutes(dbPath);
    assert.ok(routes.includes("/api/chat"));
    assert.equal(routes.length, 1, "only one distinct non-null route");
  });
});
