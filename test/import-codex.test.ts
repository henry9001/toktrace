import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { importCodex } from "../src/importers/codex.ts";
import { initStore, queryEvents } from "../src/store.ts";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("importCodex", () => {
  let sandbox: string;
  let dbPath: string;
  let root: string;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "toktrace-codex-"));
    dbPath = join(sandbox, "events.db");
    initStore(dbPath);

    root = join(sandbox, "sessions", "2026", "04", "23");
    mkdirSync(root, { recursive: true });

    // Realistic-shape rollout: session_meta, turn_context w/ model, then two
    // token_count events for two turns, plus noise types to confirm filtering.
    const rollout = [
      line({
        timestamp: "2026-04-23T05:00:00.000Z",
        type: "session_meta",
        payload: { id: "sess-abc", cwd: "/home/user/myproject", model_provider: "openai", source: "exec" },
      }),
      line({ timestamp: "2026-04-23T05:00:00.100Z", type: "event_msg", payload: { type: "task_started" } }),
      line({
        timestamp: "2026-04-23T05:00:00.200Z",
        type: "turn_context",
        payload: { turn_id: "t1", model: "gpt-5", approval_policy: "ask" },
      }),
      line({ timestamp: "2026-04-23T05:00:00.300Z", type: "response_item", payload: { type: "message", role: "user" } }),
      line({
        timestamp: "2026-04-23T05:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 200,
              output_tokens: 150,
              reasoning_output_tokens: 50,
              total_tokens: 900,
            },
            total_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 200,
              output_tokens: 150,
              reasoning_output_tokens: 50,
              total_tokens: 900,
            },
            model_context_window: 200_000,
          },
        },
      }),
      // Second turn uses a different model (simulates review mode)
      line({
        timestamp: "2026-04-23T05:00:02.000Z",
        type: "turn_context",
        payload: { turn_id: "t2", model: "gpt-5-mini" },
      }),
      line({
        timestamp: "2026-04-23T05:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 150,
            },
          },
        },
      }),
      // Empty token_count — should be silently skipped
      line({
        timestamp: "2026-04-23T05:00:04.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 } },
        },
      }),
      line({ timestamp: "2026-04-23T05:00:05.000Z", type: "event_msg", payload: { type: "task_complete" } }),
      "{not json",
    ].join("\n");

    writeFileSync(join(root, "rollout-2026-04-23T05-00-00-sess-abc.jsonl"), rollout);
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("imports two token_count events with per-turn models and skips noise", () => {
    const r = importCodex({ root: join(sandbox, "sessions"), dbPath });
    assert.equal(r.files_scanned, 1);
    assert.equal(r.events_imported, 2);
    // 1 malformed JSON line — empty-usage token_counts are silent skips, not counted
    assert.equal(r.events_skipped, 1);
    assert.deepEqual(r.errors, []);
  });

  it("tags env=codex and app_tag from cwd basename", () => {
    const events = queryEvents({}, dbPath);
    assert.equal(events.length, 2);
    for (const e of events) {
      assert.equal(e.env, "codex");
      assert.equal(e.app_tag, "myproject");
      assert.equal(e.provider, "openai");
    }
  });

  it("uses the turn_context that precedes each token_count", () => {
    const events = queryEvents({}, dbPath).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    assert.equal(events[0].model, "gpt-5");
    assert.equal(events[1].model, "gpt-5-mini");
  });

  it("inspect mode reports subtypes without writing", () => {
    const inspectDb = join(sandbox, "inspect.db");
    initStore(inspectDb);
    const r = importCodex({ root: join(sandbox, "sessions"), dbPath: inspectDb, inspect: true });
    assert.equal(r.events_imported, 0);
    assert.ok(r.subtypes_seen);
    assert.equal(r.subtypes_seen!.token_count, 3);
    assert.equal(r.subtypes_seen!.task_started, 1);
    assert.equal(r.subtypes_seen!.task_complete, 1);
    assert.equal(queryEvents({}, inspectDb).length, 0, "inspect mode must not write");
  });

  it("is idempotent across re-runs", () => {
    const before = queryEvents({}, dbPath).length;
    importCodex({ root: join(sandbox, "sessions"), dbPath });
    const after = queryEvents({}, dbPath).length;
    assert.equal(before, after);
  });
});
