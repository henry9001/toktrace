import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PeriodType = "daily" | "weekly";

export interface PeriodTotals {
  period_type: PeriodType;
  period_start: number;
  tokens: number;
  cost_usd: number;
}

/** Returns the Unix timestamp (seconds) for UTC midnight today. */
export function getDailyPeriodStart(now: Date = new Date()): number {
  return Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
  );
}

/** Returns the Unix timestamp (seconds) for UTC midnight of the most recent Monday. */
export function getWeeklyPeriodStart(now: Date = new Date()): number {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return Math.floor(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - daysSinceMonday
    ) / 1000
  );
}

export function periodStart(type: PeriodType, now?: Date): number {
  return type === "daily" ? getDailyPeriodStart(now) : getWeeklyPeriodStart(now);
}

/** Create the budget_periods table if it does not yet exist. */
export function initBudgetSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS budget_periods (
      period_type  TEXT    NOT NULL,
      period_start INTEGER NOT NULL,
      tokens       INTEGER NOT NULL DEFAULT 0,
      cost_usd     REAL    NOT NULL DEFAULT 0.0,
      PRIMARY KEY (period_type, period_start)
    )
  `);
}

/**
 * Open (or create) the toktrace SQLite database and ensure the
 * budget_periods table exists.
 */
export function openBudgetDb(dbPath?: string): Database.Database {
  const path = dbPath ?? join(homedir(), ".toktrace", "events.db");
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(path);
  initBudgetSchema(db);
  return db;
}

/** Return the current-period totals row, or undefined if none recorded yet. */
export function getPeriodTotals(
  db: Database.Database,
  periodType: PeriodType,
  now?: Date
): PeriodTotals | undefined {
  const start = periodStart(periodType, now);
  return db
    .prepare<[string, number], PeriodTotals>(
      "SELECT period_type, period_start, tokens, cost_usd FROM budget_periods WHERE period_type = ? AND period_start = ?"
    )
    .get(periodType, start);
}

/**
 * Upsert the running totals for the current period.
 * This overwrites the existing row (caller is responsible for accumulation).
 */
export function upsertPeriodTotals(
  db: Database.Database,
  periodType: PeriodType,
  tokens: number,
  costUsd: number,
  now?: Date
): void {
  const start = periodStart(periodType, now);
  db.prepare(
    `INSERT INTO budget_periods (period_type, period_start, tokens, cost_usd)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (period_type, period_start) DO UPDATE SET
       tokens   = excluded.tokens,
       cost_usd = excluded.cost_usd`
  ).run(periodType, start, tokens, costUsd);
}
