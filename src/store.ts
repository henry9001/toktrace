import Database from "better-sqlite3";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LLMEvent, Snapshot, SnapshotSummary } from "./types.js";

function defaultDbPath(): string {
  const dir = join(homedir(), ".toktrace");
  mkdirSync(dir, { recursive: true });
  return join(dir, "events.db");
}

function openDb(dbPath?: string): Database.Database {
  const path = dbPath ?? defaultDbPath();
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      prompt_hash TEXT,
      app_tag TEXT,
      env TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_provider ON events(provider);
    CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);

    CREATE TABLE IF NOT EXISTS snapshots (
      snapshot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      window_start TEXT,
      window_end TEXT,
      event_ids TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_name ON snapshots(name);
    CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at ON snapshots(captured_at);
  `);
}

export function insertEvent(event: LLMEvent, dbPath?: string): void {
  const db = openDb(dbPath);
  db.prepare(`
    INSERT OR REPLACE INTO events
      (id, timestamp, model, provider, input_tokens, output_tokens, total_tokens,
       estimated_cost, latency_ms, prompt_hash, app_tag, env)
    VALUES
      (@id, @timestamp, @model, @provider, @input_tokens, @output_tokens, @total_tokens,
       @estimated_cost, @latency_ms, @prompt_hash, @app_tag, @env)
  `).run(event);
  db.close();
}

export function queryEvents(
  opts: { since?: string; until?: string; limit?: number } = {},
  dbPath?: string
): LLMEvent[] {
  const db = openDb(dbPath);
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (opts.since) {
    conditions.push("timestamp >= @since");
    params.since = opts.since;
  }
  if (opts.until) {
    conditions.push("timestamp <= @until");
    params.until = opts.until;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit != null ? `LIMIT ${opts.limit}` : "";

  const rows = db.prepare(`SELECT * FROM events ${where} ORDER BY timestamp ASC ${limit}`).all(params) as LLMEvent[];
  db.close();
  return rows;
}

export function insertSnapshot(snapshot: Snapshot, dbPath?: string): void {
  const db = openDb(dbPath);
  db.prepare(`
    INSERT OR REPLACE INTO snapshots
      (snapshot_id, name, captured_at, window_start, window_end, event_ids, summary)
    VALUES
      (@snapshot_id, @name, @captured_at, @window_start, @window_end, @event_ids, @summary)
  `).run({
    snapshot_id: snapshot.snapshot_id,
    name: snapshot.name,
    captured_at: snapshot.captured_at,
    window_start: snapshot.window_start,
    window_end: snapshot.window_end,
    event_ids: JSON.stringify(snapshot.event_ids),
    summary: JSON.stringify(snapshot.summary),
  });
  db.close();
}

export function getSnapshot(snapshotId: string, dbPath?: string): Snapshot | null {
  const db = openDb(dbPath);
  const row = db.prepare("SELECT * FROM snapshots WHERE snapshot_id = ?").get(snapshotId) as Record<string, unknown> | undefined;
  db.close();
  if (!row) return null;
  return deserializeSnapshot(row);
}

export function getSnapshotByName(name: string, dbPath?: string): Snapshot | null {
  const db = openDb(dbPath);
  const row = db.prepare("SELECT * FROM snapshots WHERE name = ? ORDER BY captured_at DESC LIMIT 1").get(name) as Record<string, unknown> | undefined;
  db.close();
  if (!row) return null;
  return deserializeSnapshot(row);
}

export function listSnapshots(dbPath?: string): Snapshot[] {
  const db = openDb(dbPath);
  const rows = db.prepare("SELECT * FROM snapshots ORDER BY captured_at DESC").all() as Record<string, unknown>[];
  db.close();
  return rows.map(deserializeSnapshot);
}

function deserializeSnapshot(row: Record<string, unknown>): Snapshot {
  return {
    snapshot_id: row.snapshot_id as string,
    name: row.name as string,
    captured_at: row.captured_at as string,
    window_start: row.window_start as string | null,
    window_end: row.window_end as string | null,
    event_ids: JSON.parse(row.event_ids as string) as string[],
    summary: JSON.parse(row.summary as string) as SnapshotSummary,
  };
}

export function buildSummary(events: LLMEvent[]): SnapshotSummary {
  const totals = events.reduce(
    (acc, e) => {
      acc.total_input_tokens += e.input_tokens;
      acc.total_output_tokens += e.output_tokens;
      acc.total_tokens += e.total_tokens;
      acc.total_estimated_cost += e.estimated_cost;
      return acc;
    },
    { total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0, total_estimated_cost: 0 }
  );

  const byModel: Record<string, { total_cost: number; event_count: number }> = {};
  for (const e of events) {
    if (!byModel[e.model]) byModel[e.model] = { total_cost: 0, event_count: 0 };
    byModel[e.model].total_cost += e.estimated_cost;
    byModel[e.model].event_count += 1;
  }
  const top_spenders = Object.entries(byModel)
    .map(([model, stats]) => ({ model, ...stats }))
    .sort((a, b) => b.total_cost - a.total_cost)
    .slice(0, 5);

  const suggestions: string[] = [];
  if (totals.total_tokens > 100_000) {
    suggestions.push("High token usage detected — consider reviewing prompt length.");
  }
  if (top_spenders[0]?.total_cost > 0.1) {
    suggestions.push(`Top spender: ${top_spenders[0].model} — consider a cheaper model for low-stakes tasks.`);
  }

  return {
    ...totals,
    event_count: events.length,
    top_spenders,
    suggestions,
  };
}
