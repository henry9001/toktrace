import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { importClaudeCode } from "../src/importers/claudeCode.ts";
import { initStore, queryEvents } from "../src/store.ts";

function mkEntry(opts: {
  id: string;
  ts?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
  toolUses?: number;
}): string {
  const content: unknown[] = Array.from({ length: opts.toolUses ?? 0 }, () => ({
    type: "tool_use",
    id: "tu_" + opts.id,
    name: "Read",
    input: {},
  }));
  return JSON.stringify({
    timestamp: opts.ts ?? "2026-04-23T01:00:00.000Z",
    message: {
      id: opts.id,
      role: "assistant",
      model: opts.model ?? "claude-opus-4-7",
      content,
      usage: {
        input_tokens: opts.input ?? 10,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        output_tokens: opts.output ?? 20,
      },
    },
  });
}

describe("importClaudeCode", () => {
  let sandbox: string;
  let dbPath: string;
  let root: string;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "toktrace-import-"));
    dbPath = join(sandbox, "events.db");
    initStore(dbPath);

    root = join(sandbox, "projects");
    const projA = join(root, "-home-user-myapp");
    mkdirSync(projA, { recursive: true });
    writeFileSync(
      join(projA, "sess1.jsonl"),
      [
        mkEntry({ id: "msg_aaa", input: 100, output: 50, cacheRead: 10_000, cacheCreate: 2_000, toolUses: 2 }),
        mkEntry({ id: "msg_bbb", input: 5, output: 15, model: "claude-sonnet-4-7" }),
        // Non-assistant entry — silently ignored (not an LLM event at all)
        JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
        // Assistant w/o usage — silently ignored (not a completion)
        JSON.stringify({ message: { id: "msg_no_usage", role: "assistant", model: "claude-opus-4-7" } }),
        // Assistant with usage but missing model — counted as skipped (malformed LLM event)
        JSON.stringify({ message: { id: "msg_bad_model", role: "assistant", usage: { input_tokens: 1, output_tokens: 1 } } }),
        // Malformed JSON — counted as skipped
        "{not json",
      ].join("\n"),
    );
    // Second project
    const projB = join(root, "-home-user-other");
    mkdirSync(projB, { recursive: true });
    writeFileSync(join(projB, "s.jsonl"), mkEntry({ id: "msg_ccc", input: 1, output: 1 }));
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("imports assistant messages and skips noise", () => {
    const result = importClaudeCode({ root, dbPath });
    assert.equal(result.files_scanned, 2);
    assert.equal(result.events_imported, 3, "should import msg_aaa, msg_bbb, msg_ccc");
    assert.equal(result.events_skipped, 2, "bad JSON + assistant-without-usage");
    assert.deepEqual(result.errors, []);
  });

  it("tags app_tag from project dir and env as claude-code", () => {
    const events = queryEvents({}, dbPath);
    assert.equal(events.length, 3);
    const aaa = events.find((e) => e.id === "msg_aaa");
    assert.ok(aaa);
    assert.equal(aaa.env, "claude-code");
    assert.equal(aaa.app_tag, "myapp");
    assert.equal(aaa.tool_call_count, 2);
  });

  it("computes cost with cache multipliers", () => {
    const events = queryEvents({}, dbPath);
    const aaa = events.find((e) => e.id === "msg_aaa")!;
    // input 100 * $15e-6 = 1.5e-3
    // output 50 * $75e-6 = 3.75e-3
    // cache_create 2000 * $15e-6 * 1.25 = 3.75e-2 * 1.25 = ... wait recompute:
    //   2000 * 15e-6 = 3e-2 = 0.03, * 1.25 = 0.0375
    // cache_read 10000 * $15e-6 * 0.1 = 0.15 * 0.1 = 0.015
    // total = 0.0015 + 0.00375 + 0.0375 + 0.015 = 0.05775
    assert.ok(Math.abs(aaa.estimated_cost - 0.05775) < 1e-9, `cost was ${aaa.estimated_cost}`);
  });

  it("context_size_tokens is input + cache_read + cache_creation", () => {
    const events = queryEvents({}, dbPath);
    const aaa = events.find((e) => e.id === "msg_aaa")!;
    assert.equal(aaa.context_size_tokens, 100 + 10_000 + 2_000);
  });

  it("is idempotent on re-run (INSERT OR REPLACE semantics)", () => {
    const before = queryEvents({}, dbPath).length;
    const result = importClaudeCode({ root, dbPath });
    const after = queryEvents({}, dbPath).length;
    assert.equal(before, after, "re-running should not create duplicate rows");
    assert.equal(result.events_imported, 3, "still re-processes the same 3 rows");
  });
});
