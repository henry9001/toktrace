import Database from "better-sqlite3";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BudgetAlert, LLMEvent, Snapshot, SnapshotSummary } from "./types.js";
import { budgetCheck, initBudgetSchema } from "./budget.js";

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
      ts TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      endpoint TEXT,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
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
  initBudgetSchema(db);
}

function serializeEvent(event: LLMEvent): Record<string, unknown> {
  return {
    id: event.id,
    ts: event.ts,
    model: event.model,
    provider: event.provider,
    prompt_tokens: event.prompt_tokens,
    completion_tokens: event.completion_tokens,
    cost_usd: event.cost_usd,
    duration_ms: event.duration_ms,
    endpoint: event.endpoint,
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
  };
}

function deserializeEvent(row: Record<string, unknown>): LLMEvent {
  return {
    id: row.id as string,
    ts: row.ts as string,
    model: row.model as string,
    provider: row.provider as string,
    prompt_tokens: row.prompt_tokens as number,
    completion_tokens: row.completion_tokens as number,
    cost_usd: row.cost_usd as number,
    duration_ms: row.duration_ms as number,
    endpoint: (row.endpoint as string) ?? null,
    metadata: row.metadata ? JSON.parse(row.metadata as string) as Record<string, unknown> : null,
  };
}

export class LocalStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = openDb(dbPath);
  }

  insertEvent(event: LLMEvent): BudgetAlert[] {
    this.db.prepare(`
      INSERT OR REPLACE INTO events
        (id, ts, model, provider, prompt_tokens, completion_tokens,
         cost_usd, duration_ms, endpoint, metadata)
      VALUES
        (@id, @ts, @model, @provider, @prompt_tokens, @completion_tokens,
         @cost_usd, @duration_ms, @endpoint, @metadata)
    `).run(serializeEvent(event));
    return budgetCheck(this.db, event);
  }

  getEvent(id: string): LLMEvent | null {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return deserializeEvent(row);
  }

  queryEvents(opts: { since?: string; until?: string; limit?: number } = {}): LLMEvent[] {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};

    if (opts.since) {
      conditions.push("ts >= @since");
      params.since = opts.since;
    }
    if (opts.until) {
      conditions.push("ts <= @until");
      params.until = opts.until;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit != null ? `LIMIT ${opts.limit}` : "";

    const rows = this.db.prepare(`SELECT * FROM events ${where} ORDER BY ts ASC ${limit}`).all(params) as Record<string, unknown>[];
    return rows.map(deserializeEvent);
  }

  deleteEvent(id: string): boolean {
    const result = this.db.prepare("DELETE FROM events WHERE id = ?").run(id);
    return result.changes > 0;
  }

  insertSnapshot(snapshot: Snapshot): void {
    this.db.prepare(`
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
  }

  getSnapshot(snapshotId: string): Snapshot | null {
    const row = this.db.prepare("SELECT * FROM snapshots WHERE snapshot_id = ?").get(snapshotId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return deserializeSnapshot(row);
  }

  getSnapshotByName(name: string): Snapshot | null {
    const row = this.db.prepare("SELECT * FROM snapshots WHERE name = ? ORDER BY captured_at DESC LIMIT 1").get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return deserializeSnapshot(row);
  }

  listSnapshots(): Snapshot[] {
    const rows = this.db.prepare("SELECT * FROM snapshots ORDER BY captured_at DESC").all() as Record<string, unknown>[];
    return rows.map(deserializeSnapshot);
  }

  close(): void {
    this.db.close();
  }
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

// Standalone functions for backward compatibility — delegate to LocalStore
export function insertEvent(event: LLMEvent, dbPath?: string): BudgetAlert[] {
  const store = new LocalStore(dbPath);
  try {
    return store.insertEvent(event);
  } finally {
    store.close();
  }
}

export function queryEvents(
  opts: { since?: string; until?: string; limit?: number } = {},
  dbPath?: string
): LLMEvent[] {
  const store = new LocalStore(dbPath);
  try {
    return store.queryEvents(opts);
  } finally {
    store.close();
  }
}

export function insertSnapshot(snapshot: Snapshot, dbPath?: string): void {
  const store = new LocalStore(dbPath);
  try {
    store.insertSnapshot(snapshot);
  } finally {
    store.close();
  }
}

export function getSnapshot(snapshotId: string, dbPath?: string): Snapshot | null {
  const store = new LocalStore(dbPath);
  try {
    return store.getSnapshot(snapshotId);
  } finally {
    store.close();
  }
}

export function getSnapshotByName(name: string, dbPath?: string): Snapshot | null {
  const store = new LocalStore(dbPath);
  try {
    return store.getSnapshotByName(name);
  } finally {
    store.close();
  }
}

export function listSnapshots(dbPath?: string): Snapshot[] {
  const store = new LocalStore(dbPath);
  try {
    return store.listSnapshots();
  } finally {
    store.close();
  }
}

export function buildSummary(events: LLMEvent[]): SnapshotSummary {
  const totals = events.reduce(
    (acc, e) => {
      acc.total_prompt_tokens += e.prompt_tokens;
      acc.total_completion_tokens += e.completion_tokens;
      acc.total_tokens += e.prompt_tokens + e.completion_tokens;
      acc.total_cost_usd += e.cost_usd;
      return acc;
    },
    { total_prompt_tokens: 0, total_completion_tokens: 0, total_tokens: 0, total_cost_usd: 0 }
  );

  const byModel: Record<string, { total_cost: number; event_count: number }> = {};
  for (const e of events) {
    if (!byModel[e.model]) byModel[e.model] = { total_cost: 0, event_count: 0 };
    byModel[e.model].total_cost += e.cost_usd;
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
