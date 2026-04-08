import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initStore, insertEvent, queryTrend } from "../src/index.js";
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

describe("TokTrace E2: Token trend chart", () => {
  let tmpDir: string;
  let dbPath: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "toktrace-trend-"));
    dbPath = join(tmpDir, "events.db");
    initStore(dbPath);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("queryTrend returns 7 days of zeros when no events exist", () => {
    const trend = queryTrend({}, dbPath);
    assert.equal(trend.length, 7, "should return 7 data points");
    for (const point of trend) {
      assert.equal(point.total_tokens, 0);
      assert.equal(point.input_tokens, 0);
      assert.equal(point.output_tokens, 0);
      assert.equal(point.estimated_cost, 0);
      assert.equal(point.event_count, 0);
      assert.match(point.date, /^\d{4}-\d{2}-\d{2}$/, "date format YYYY-MM-DD");
    }
  });

  it("queryTrend groups events by date and fills gaps", () => {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Insert events for today
    insertEvent(
      makeEvent({
        id: "trend-001",
        timestamp: now.toISOString(),
        input_tokens: 200,
        output_tokens: 100,
        total_tokens: 300,
        estimated_cost: 0.0015,
      }),
      dbPath
    );

    insertEvent(
      makeEvent({
        id: "trend-002",
        timestamp: now.toISOString(),
        input_tokens: 400,
        output_tokens: 200,
        total_tokens: 600,
        estimated_cost: 0.003,
      }),
      dbPath
    );

    const trend = queryTrend({}, dbPath);
    assert.equal(trend.length, 7, "should return 7 data points");

    // Today should have aggregated values
    const todayPoint = trend.find((p) => p.date === todayStr);
    assert.ok(todayPoint, "today should be in the trend");
    assert.equal(todayPoint.total_tokens, 900, "300 + 600 total tokens");
    assert.equal(todayPoint.input_tokens, 600, "200 + 400 input tokens");
    assert.equal(todayPoint.output_tokens, 300, "100 + 200 output tokens");
    assert.equal(todayPoint.event_count, 2, "2 events today");

    // Other days should be zero
    const otherDays = trend.filter((p) => p.date !== todayStr);
    for (const point of otherDays) {
      assert.equal(point.total_tokens, 0, `${point.date} should be zero`);
    }
  });

  it("queryTrend respects custom day count", () => {
    const trend3 = queryTrend({ days: 3 }, dbPath);
    assert.equal(trend3.length, 3, "should return 3 data points");

    const trend14 = queryTrend({ days: 14 }, dbPath);
    assert.equal(trend14.length, 14, "should return 14 data points");
  });

  it("queryTrend dates are sorted ascending", () => {
    const trend = queryTrend({}, dbPath);
    for (let i = 1; i < trend.length; i++) {
      assert.ok(trend[i].date > trend[i - 1].date, "dates should be ascending");
    }
  });

  it("queryTrend excludes events older than the window", () => {
    // Insert an old event (30 days ago)
    const oldDate = new Date();
    oldDate.setUTCDate(oldDate.getUTCDate() - 30);

    insertEvent(
      makeEvent({
        id: "trend-old-001",
        timestamp: oldDate.toISOString(),
        total_tokens: 9999,
        estimated_cost: 99.0,
      }),
      dbPath
    );

    const trend = queryTrend({ days: 7 }, dbPath);
    const totalTokens = trend.reduce((sum, p) => sum + p.total_tokens, 0);
    assert.ok(totalTokens < 9999, "old event should not appear in 7-day trend");
  });
});
