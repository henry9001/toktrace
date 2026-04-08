import Database from "better-sqlite3";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { BudgetAlert, LLMEvent, Snapshot, SnapshotSummary, SuggestionCard, StoredSuggestion, SuggestionStatus } from "./types.js";
import { budgetCheck, initBudgetSchema } from "./budget.js";
import { checkRules, initRulesSchema } from "./rules.js";
import type { RuleViolation } from "./rules.js";

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

    CREATE TABLE IF NOT EXISTS suggestions (
      id TEXT PRIMARY KEY,
      rule TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      impact TEXT NOT NULL,
      action TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_dedup ON suggestions(rule, content_hash);
    CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);
  `);
  initBudgetSchema(db);
  initRulesSchema(db);
}

export function initStore(dbPath?: string): void {
  const db = openDb(dbPath);
  db.close();
}

/** Optional metadata passed from SDK patches to enable rule checks. */
export interface EventMetadata {
  messages?: unknown[];
  body?: Record<string, unknown>;
}

export function insertEvent(
  event: LLMEvent,
  dbPath?: string,
  metadata?: EventMetadata
): BudgetAlert[] {
  const db = openDb(dbPath);
  db.prepare(`
    INSERT OR REPLACE INTO events
      (id, timestamp, model, provider, input_tokens, output_tokens, total_tokens,
       estimated_cost, latency_ms, prompt_hash, app_tag, env)
    VALUES
      (@id, @timestamp, @model, @provider, @input_tokens, @output_tokens, @total_tokens,
       @estimated_cost, @latency_ms, @prompt_hash, @app_tag, @env)
  `).run(event);
  const alerts = budgetCheck(db, event);
  if (metadata) {
    checkRules(db, event, metadata.messages, metadata.body);
  }
  db.close();
  return alerts;
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

export interface AggregateTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  event_count: number;
  by_model: Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
    estimated_cost: number;
    event_count: number;
  }>;
}

export interface AggregateFilter {
  since?: string;
  until?: string;
  model?: string;
  appTag?: string;
}

function buildWhereClause(opts: AggregateFilter): { where: string; params: Record<string, string> } {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (opts.since) {
    conditions.push("timestamp >= @since");
    params.since = opts.since;
  }
  if (opts.until) {
    conditions.push("timestamp <= @until");
    params.until = opts.until;
  }
  if (opts.model) {
    conditions.push("model = @model");
    params.model = opts.model;
  }
  if (opts.appTag) {
    conditions.push("app_tag = @appTag");
    params.appTag = opts.appTag;
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

export function queryAggregate(
  opts: AggregateFilter = {},
  dbPath?: string
): AggregateTotals {
  const db = openDb(dbPath);
  const { where, params } = buildWhereClause(opts);

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0)  AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(total_tokens), 0)  AS total_tokens,
         COALESCE(SUM(estimated_cost), 0) AS estimated_cost,
         COUNT(*) AS event_count
       FROM events ${where}`
    )
    .get(params) as {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    estimated_cost: number;
    event_count: number;
  };

  const byModel = db
    .prepare(
      `SELECT
         model,
         SUM(input_tokens)  AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(estimated_cost) AS estimated_cost,
         COUNT(*) AS event_count
       FROM events ${where}
       GROUP BY model
       ORDER BY SUM(estimated_cost) DESC`
    )
    .all(params) as Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
    estimated_cost: number;
    event_count: number;
  }>;

  db.close();
  return { ...totals, by_model: byModel };
}

export interface TrendPoint {
  date: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  event_count: number;
}

export function queryTrend(
  opts: { days?: number } = {},
  dbPath?: string
): TrendPoint[] {
  const days = opts.days ?? 7;
  const db = openDb(dbPath);

  const now = new Date();
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1))
  ).toISOString();

  const rows = db
    .prepare(
      `SELECT
         DATE(timestamp) AS date,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(estimated_cost), 0) AS estimated_cost,
         COUNT(*) AS event_count
       FROM events
       WHERE timestamp >= @since
       GROUP BY DATE(timestamp)
       ORDER BY date ASC`
    )
    .all({ since }) as TrendPoint[];

  db.close();

  // Fill in missing days with zeros
  const result: TrendPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1 - i))
    );
    const dateStr = d.toISOString().slice(0, 10);
    const existing = rows.find((r) => r.date === dateStr);
    result.push(
      existing ?? {
        date: dateStr,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        estimated_cost: 0,
        event_count: 0,
      }
    );
  }

  return result;
}

export function listDistinctModels(dbPath?: string): string[] {
  const db = openDb(dbPath);
  const rows = db.prepare("SELECT DISTINCT model FROM events ORDER BY model").all() as Array<{ model: string }>;
  db.close();
  return rows.map((r) => r.model);
}

export function listDistinctRoutes(dbPath?: string): string[] {
  const db = openDb(dbPath);
  const rows = db
    .prepare("SELECT DISTINCT app_tag FROM events WHERE app_tag IS NOT NULL AND app_tag != '' ORDER BY app_tag")
    .all() as Array<{ app_tag: string }>;
  db.close();
  return rows.map((r) => r.app_tag);
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

  // Rule: large prompt + low output ratio detector
  const lowOutputRatioCalls = events.filter(
    (e) => e.input_tokens > 2000 && e.output_tokens < e.input_tokens * 0.1
  );
  if (lowOutputRatioCalls.length > 0) {
    suggestions.push(
      `${lowOutputRatioCalls.length} call(s) had large prompts (>2k tokens) with <10% output ratio — consider prompt compression or caching.`
    );
  }

  return {
    ...totals,
    event_count: events.length,
    top_spenders,
    suggestions,
  };
}

// ── Suggestion persistence ──────────────────────────────────────────────

/** Compute a content hash for dedup: rule + title + impact + action. */
export function suggestionContentHash(card: SuggestionCard): string {
  return createHash("sha256")
    .update(`${card.rule}\n${card.title}\n${card.impact}\n${card.action}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Persist suggestion cards to the database, deduplicating by rule + content_hash.
 * Existing rows with the same key are left untouched (preserving their status).
 * Returns the number of newly inserted suggestions.
 */
export function saveSuggestions(cards: SuggestionCard[], dbPath?: string): number {
  if (cards.length === 0) return 0;
  const db = openDb(dbPath);
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO suggestions
      (id, rule, content_hash, title, impact, action, confidence, status, created_at, updated_at)
    VALUES
      (@id, @rule, @content_hash, @title, @impact, @action, @confidence, 'active', @now, @now)
    ON CONFLICT(rule, content_hash) DO UPDATE SET
      confidence = @confidence,
      updated_at = @now
  `);

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const card of cards) {
      const hash = suggestionContentHash(card);
      const id = `sug_${hash}`;
      const info = stmt.run({ id, ...card, content_hash: hash, now });
      if (info.changes > 0) inserted++;
    }
  });
  tx();
  db.close();
  return inserted;
}

/**
 * Retrieve stored suggestions, optionally filtered by status.
 */
export function getSuggestions(
  opts: { status?: SuggestionStatus } = {},
  dbPath?: string,
): StoredSuggestion[] {
  const db = openDb(dbPath);
  const where = opts.status ? "WHERE status = @status" : "";
  const rows = db
    .prepare(`SELECT * FROM suggestions ${where} ORDER BY created_at DESC`)
    .all(opts.status ? { status: opts.status } : {}) as StoredSuggestion[];
  db.close();
  return rows;
}

/**
 * Update a suggestion's status (dismiss or mark as actioned).
 * Returns true if the row was found and updated.
 */
export function updateSuggestionStatus(
  id: string,
  status: SuggestionStatus,
  dbPath?: string,
): boolean {
  const db = openDb(dbPath);
  const now = new Date().toISOString();
  const info = db
    .prepare("UPDATE suggestions SET status = @status, updated_at = @now WHERE id = @id")
    .run({ id, status, now });
  db.close();
  return info.changes > 0;
}

/**
 * Dismiss a suggestion by ID.
 */
export function dismissSuggestion(id: string, dbPath?: string): boolean {
  return updateSuggestionStatus(id, "dismissed", dbPath);
}

/**
 * Mark a suggestion as actioned by ID.
 */
export function actionSuggestion(id: string, dbPath?: string): boolean {
  return updateSuggestionStatus(id, "actioned", dbPath);
}
