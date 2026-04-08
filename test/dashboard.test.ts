import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";

import { createApp, initStore, insertEvent } from "../src/index.js";
import type { LLMEvent } from "../src/index.js";

describe("TokTrace E2 dashboard HTTP server", () => {
  let tmpDir: string;
  let dbPath: string;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "toktrace-dash-test-"));
    dbPath = join(tmpDir, "events.db");
    initStore(dbPath);

    // Seed test events
    const event: LLMEvent = {
      id: "dash-evt-001",
      timestamp: new Date().toISOString(),
      model: "gpt-4o-mini",
      provider: "openai",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      estimated_cost: 0.000042,
      latency_ms: 250,
      prompt_hash: null,
      app_tag: null,
      env: "test",
      tool_calls: null,
      context_size_tokens: 100,
      tool_call_count: 0,
    };
    insertEvent(event, dbPath);

    const app = createApp(dbPath);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(() => {
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET / serves the SPA HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("html"), `expected html content-type, got ${ct}`);
    const body = await res.text();
    assert.ok(body.includes("TokTrace"), "HTML should contain TokTrace title");
  });

  it("GET /api/events returns events from SQLite", async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    assert.equal(res.status, 200);
    const events = await res.json() as LLMEvent[];
    assert.ok(Array.isArray(events), "response should be an array");
    assert.ok(events.length >= 1, "should have at least 1 event");
    assert.equal(events[0].id, "dash-evt-001");
    assert.equal(events[0].model, "gpt-4o-mini");
  });

  it("GET /api/events respects limit query param", async () => {
    // Insert a second event
    insertEvent({
      id: "dash-evt-002",
      timestamp: new Date().toISOString(),
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      input_tokens: 200,
      output_tokens: 100,
      total_tokens: 300,
      estimated_cost: 0.001,
      latency_ms: 500,
      prompt_hash: null,
      app_tag: null,
      env: "test",
      tool_calls: null,
      context_size_tokens: 200,
      tool_call_count: 0,
    }, dbPath);

    const res = await fetch(`${baseUrl}/api/events?limit=1`);
    assert.equal(res.status, 200);
    const events = await res.json() as LLMEvent[];
    assert.equal(events.length, 1, "limit=1 should return exactly 1 event");
  });

  it("GET /api/snapshots returns an array", async () => {
    const res = await fetch(`${baseUrl}/api/snapshots`);
    assert.equal(res.status, 200);
    const snapshots = await res.json();
    assert.ok(Array.isArray(snapshots), "response should be an array");
  });

  it("GET /api/budget-status returns budget info", async () => {
    const res = await fetch(`${baseUrl}/api/budget-status`);
    assert.equal(res.status, 200);
    const data = await res.json() as { configured: boolean };
    assert.equal(typeof data.configured, "boolean");
  });

  it("unknown route returns 404", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    assert.equal(res.status, 404);
  });
});
