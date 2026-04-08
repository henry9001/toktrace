import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { init, initStore, insertEvent, queryEvents } from "../src/index.js";
import type { LLMEvent } from "../src/index.js";

describe("TokTrace E1 smoke test", () => {
  let tmpDir: string;
  let dbPath: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "toktrace-test-"));
    dbPath = join(tmpDir, "events.db");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initStore creates the database and schema", () => {
    initStore(dbPath);

    // Database file should now exist
    assert.ok(existsSync(dbPath), "events.db should be created");
  });

  it("init() runs without error (patches skip when SDKs absent)", () => {
    // init() should silently skip patches for SDKs that aren't installed
    assert.doesNotThrow(() => {
      init({ dbPath });
    });
  });

  it("insertEvent writes an event and queryEvents reads it back", () => {
    const event: LLMEvent = {
      id: "test-evt-001",
      timestamp: new Date().toISOString(),
      model: "gpt-4o-mini",
      provider: "openai",
      input_tokens: 150,
      output_tokens: 50,
      total_tokens: 200,
      estimated_cost: 0.000053,
      latency_ms: 320,
      prompt_hash: "abcd1234abcd1234",
      app_tag: null,
      env: "test",
      tool_calls: null,
      context_size_tokens: 150,
      tool_call_count: 0,
    };

    const alerts = insertEvent(event, dbPath);
    assert.ok(Array.isArray(alerts), "insertEvent should return an alerts array");

    const events = queryEvents({}, dbPath);
    assert.equal(events.length, 1, "should have exactly 1 event");
    assert.equal(events[0].id, "test-evt-001");
    assert.equal(events[0].model, "gpt-4o-mini");
    assert.equal(events[0].provider, "openai");
    assert.equal(events[0].input_tokens, 150);
    assert.equal(events[0].output_tokens, 50);
    assert.equal(events[0].total_tokens, 200);
    assert.equal(events[0].env, "test");
  });

  it("full pipeline: init → insert multiple events → query with filters", () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    const event1: LLMEvent = {
      id: "test-evt-002",
      timestamp: earlier.toISOString(),
      model: "gpt-4o",
      provider: "openai",
      input_tokens: 500,
      output_tokens: 200,
      total_tokens: 700,
      estimated_cost: 0.00325,
      latency_ms: 1200,
      prompt_hash: null,
      app_tag: null,
      env: "test",
      tool_calls: null,
      context_size_tokens: 500,
      tool_call_count: 0,
    };

    const event2: LLMEvent = {
      id: "test-evt-003",
      timestamp: now.toISOString(),
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      input_tokens: 300,
      output_tokens: 100,
      total_tokens: 400,
      estimated_cost: 0.0014,
      latency_ms: 800,
      prompt_hash: null,
      app_tag: null,
      env: "test",
      tool_calls: JSON.stringify([{ type: "tool_use", name: "search", id: "tc_1" }]),
      context_size_tokens: 300,
      tool_call_count: 1,
    };

    insertEvent(event1, dbPath);
    insertEvent(event2, dbPath);

    // Query all — should have 3 total (1 from prior test + 2 new)
    const all = queryEvents({}, dbPath);
    assert.equal(all.length, 3, "should have 3 events total");

    // Query with since filter — only events from 'now' onward
    const recent = queryEvents({ since: now.toISOString() }, dbPath);
    assert.ok(recent.length >= 1, "since filter should return at least 1 event");
    assert.ok(
      recent.every((e) => e.timestamp >= now.toISOString()),
      "all returned events should be >= since timestamp"
    );

    // Query with limit
    const limited = queryEvents({ limit: 1 }, dbPath);
    assert.equal(limited.length, 1, "limit should cap results");
  });
});
