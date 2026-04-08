import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  initStore,
  insertEvent,
  estimateTokenCount,
  extractSystemPromptText,
  buildSummary,
} from "../src/index.js";
import type { LLMEvent } from "../src/index.js";
import Database from "better-sqlite3";
import { initRulesSchema, checkOverlongSystemPrompt, queryViolations } from "../src/rules.js";

function makeSummaryEvent(overrides: Partial<LLMEvent> & { id: string }): LLMEvent {
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
    tool_call_count: 0,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<LLMEvent> = {}): LLMEvent {
  return {
    id: `test-rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 500,
    output_tokens: 100,
    total_tokens: 600,
    estimated_cost: 0.003,
    latency_ms: 400,
    prompt_hash: "abcd1234",
    app_tag: null,
    env: "test",
    tool_call_count: 0,
    ...overrides,
  };
}

describe("TokTrace E3: buildSummary rules", () => {
  it("flags calls with large prompt and low output ratio", () => {
    const events = [
      makeSummaryEvent({
        id: "rule-001",
        input_tokens: 5000,
        output_tokens: 200, // 4% of input — below 10% threshold
        total_tokens: 5200,
      }),
      makeSummaryEvent({
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
      makeSummaryEvent({
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
      makeSummaryEvent({
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
      makeSummaryEvent({
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
      makeSummaryEvent({
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

describe("estimateTokenCount", () => {
  it("returns ~1 token per 4 characters", () => {
    assert.equal(estimateTokenCount("abcd"), 1);
    assert.equal(estimateTokenCount("abcde"), 2);
    assert.equal(estimateTokenCount("a".repeat(4000)), 1000);
  });

  it("returns 0 for empty string", () => {
    assert.equal(estimateTokenCount(""), 0);
  });
});

describe("extractSystemPromptText", () => {
  it("extracts OpenAI system message", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    assert.equal(extractSystemPromptText(messages, undefined), "You are helpful.");
  });

  it("extracts OpenAI developer message", () => {
    const messages = [
      { role: "developer", content: "Internal instructions." },
      { role: "user", content: "Hello" },
    ];
    assert.equal(extractSystemPromptText(messages, undefined), "Internal instructions.");
  });

  it("concatenates multiple system messages", () => {
    const messages = [
      { role: "system", content: "Part 1." },
      { role: "system", content: "Part 2." },
      { role: "user", content: "Hello" },
    ];
    assert.equal(extractSystemPromptText(messages, undefined), "Part 1.\nPart 2.");
  });

  it("handles OpenAI content array format", () => {
    const messages = [
      {
        role: "system",
        content: [
          { type: "text", text: "Block A. " },
          { type: "text", text: "Block B." },
        ],
      },
    ];
    assert.equal(extractSystemPromptText(messages, undefined), "Block A. Block B.");
  });

  it("extracts Anthropic string system prompt", () => {
    const body = { system: "You are a coding assistant.", messages: [] };
    assert.equal(
      extractSystemPromptText(undefined, body),
      "You are a coding assistant."
    );
  });

  it("extracts Anthropic content-block system prompt", () => {
    const body = {
      system: [
        { type: "text", text: "Block 1." },
        { type: "text", text: "Block 2." },
      ],
      messages: [],
    };
    assert.equal(
      extractSystemPromptText(undefined, body),
      "Block 1.\nBlock 2."
    );
  });

  it("prefers Anthropic body.system over messages", () => {
    const messages = [{ role: "system", content: "From messages" }];
    const body = { system: "From body", messages };
    assert.equal(extractSystemPromptText(messages, body), "From body");
  });

  it("returns null when no system prompt", () => {
    const messages = [{ role: "user", content: "Hello" }];
    assert.equal(extractSystemPromptText(messages, undefined), null);
  });

  it("returns null for empty inputs", () => {
    assert.equal(extractSystemPromptText(undefined, undefined), null);
    assert.equal(extractSystemPromptText([], undefined), null);
  });
});

describe("checkOverlongSystemPrompt", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.default;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "toktrace-rules-test-"));
    dbPath = join(tmpDir, "rules-test.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    initRulesSchema(db);
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when system prompt is under threshold", () => {
    const event = makeEvent();
    const messages = [
      { role: "system", content: "Short prompt." },
      { role: "user", content: "Hello" },
    ];
    const result = checkOverlongSystemPrompt(db, event, messages, undefined);
    assert.equal(result, null);
  });

  it("flags system prompt over 1000 tokens", () => {
    const event = makeEvent();
    // 1001 tokens = ~4004 chars
    const longPrompt = "x".repeat(4004);
    const messages = [
      { role: "system", content: longPrompt },
      { role: "user", content: "Hello" },
    ];
    const result = checkOverlongSystemPrompt(db, event, messages, undefined);
    assert.ok(result, "should return a violation");
    assert.equal(result.rule, "overlong_system_prompt");
    assert.equal(result.level, "info");
    assert.ok(result.message.includes("1001"));
    assert.ok(result.message.includes("trimming or summarizing"));
  });

  it("uses warning level for prompts over 2x threshold", () => {
    const event = makeEvent();
    // 2001+ tokens = ~8004+ chars
    const veryLongPrompt = "y".repeat(8004);
    const messages = [
      { role: "system", content: veryLongPrompt },
    ];
    const result = checkOverlongSystemPrompt(db, event, messages, undefined);
    assert.ok(result);
    assert.equal(result.level, "warning");
  });

  it("respects custom threshold from config", () => {
    const event = makeEvent();
    // 501 tokens = ~2004 chars, under default 1000 but over custom 500
    const messages = [
      { role: "system", content: "z".repeat(2004) },
    ];

    // Should pass with default threshold
    const defaultResult = checkOverlongSystemPrompt(db, event, messages, undefined);
    assert.equal(defaultResult, null);

    // Should flag with lower threshold
    const event2 = makeEvent();
    const customResult = checkOverlongSystemPrompt(
      db,
      event2,
      messages,
      undefined,
      { overlong_system_prompt_tokens: 500 }
    );
    assert.ok(customResult, "should flag with custom threshold");
    assert.equal(customResult.rule, "overlong_system_prompt");
  });

  it("stores violation in database", () => {
    const event = makeEvent({ id: "violation-persist-test" });
    const messages = [
      { role: "system", content: "a".repeat(5000) },
    ];
    checkOverlongSystemPrompt(db, event, messages, undefined);

    const violations = queryViolations(db, { eventId: "violation-persist-test" });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "overlong_system_prompt");
  });
});

describe("insertEvent with rule checking", () => {
  let tmpDir: string;
  let dbPath: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "toktrace-insert-rules-"));
    dbPath = join(tmpDir, "events.db");
    initStore(dbPath);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects overlong system prompt via insertEvent metadata", () => {
    const event = makeEvent({ id: "insert-rule-test-1" });
    const messages = [
      { role: "system", content: "w".repeat(5000) },
      { role: "user", content: "Hello" },
    ];

    insertEvent(event, dbPath, { messages, body: { messages } });

    // Verify the violation was stored
    const db = new Database(dbPath);
    const rows = db
      .prepare("SELECT * FROM rule_violations WHERE event_id = ?")
      .all("insert-rule-test-1") as Array<Record<string, unknown>>;
    db.close();

    assert.equal(rows.length, 1);
    assert.equal(rows[0].rule, "overlong_system_prompt");
  });

  it("does not create violations for short system prompts", () => {
    const event = makeEvent({ id: "insert-rule-test-2" });
    const messages = [
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Hello" },
    ];

    insertEvent(event, dbPath, { messages, body: { messages } });

    const db = new Database(dbPath);
    const rows = db
      .prepare("SELECT * FROM rule_violations WHERE event_id = ?")
      .all("insert-rule-test-2") as Array<Record<string, unknown>>;
    db.close();

    assert.equal(rows.length, 0);
  });

  it("works without metadata (backward compatible)", () => {
    const event = makeEvent({ id: "insert-no-meta" });
    const alerts = insertEvent(event, dbPath);
    assert.ok(Array.isArray(alerts));
  });
});
