import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AlertLevel, BudgetAlert, BudgetMetric, LLMEvent } from "./types.js";
import { loadConfig } from "./config.js";
import type { BudgetConfig } from "./config.js";

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

/** Create the budget_periods and budget_alerts tables if they do not yet exist. */
export function initBudgetSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS budget_periods (
      period_type  TEXT    NOT NULL,
      period_start INTEGER NOT NULL,
      tokens       INTEGER NOT NULL DEFAULT 0,
      cost_usd     REAL    NOT NULL DEFAULT 0.0,
      PRIMARY KEY (period_type, period_start)
    );

    CREATE TABLE IF NOT EXISTS budget_alerts (
      id             TEXT    PRIMARY KEY,
      period_type    TEXT    NOT NULL,
      period_start   INTEGER NOT NULL,
      metric         TEXT    NOT NULL,
      threshold_pct  INTEGER NOT NULL,
      level          TEXT    NOT NULL,
      current_value  REAL    NOT NULL,
      limit_value    REAL    NOT NULL,
      fired_at       TEXT    NOT NULL,
      delivered      INTEGER NOT NULL DEFAULT 0,
      UNIQUE (period_type, period_start, metric, threshold_pct)
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

interface ThresholdDef {
  pct: number;
  level: AlertLevel;
}

const THRESHOLDS: ThresholdDef[] = [
  { pct: 80, level: "warning" },
  { pct: 100, level: "alert" },
];

function hasAlreadyFired(
  db: Database.Database,
  pType: PeriodType,
  pStart: number,
  metric: BudgetMetric,
  pct: number
): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM budget_alerts WHERE period_type = ? AND period_start = ? AND metric = ? AND threshold_pct = ?"
    )
    .get(pType, pStart, metric, pct);
  return row !== undefined;
}

function enqueueAlert(
  db: Database.Database,
  pType: PeriodType,
  pStart: number,
  metric: BudgetMetric,
  threshold: ThresholdDef,
  currentValue: number,
  limitValue: number,
  now: Date
): BudgetAlert {
  const alert: BudgetAlert = {
    id: randomUUID(),
    period_type: pType,
    period_start: pStart,
    metric,
    threshold_pct: threshold.pct,
    level: threshold.level,
    current_value: currentValue,
    limit_value: limitValue,
    fired_at: now.toISOString(),
    delivered: false,
  };
  db.prepare(
    `INSERT OR IGNORE INTO budget_alerts
       (id, period_type, period_start, metric, threshold_pct, level, current_value, limit_value, fired_at, delivered)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    alert.id,
    alert.period_type,
    alert.period_start,
    alert.metric,
    alert.threshold_pct,
    alert.level,
    alert.current_value,
    alert.limit_value,
    alert.fired_at
  );
  return alert;
}

function checkMetric(
  db: Database.Database,
  pType: PeriodType,
  pStart: number,
  metric: BudgetMetric,
  currentValue: number,
  limit: number | undefined,
  now: Date,
  alerts: BudgetAlert[]
): void {
  if (limit == null || limit <= 0) return;
  for (const threshold of THRESHOLDS) {
    const thresholdValue = (limit * threshold.pct) / 100;
    if (currentValue >= thresholdValue) {
      if (!hasAlreadyFired(db, pType, pStart, metric, threshold.pct)) {
        alerts.push(
          enqueueAlert(db, pType, pStart, metric, threshold, currentValue, limit, now)
        );
      }
    }
  }
}

/**
 * Check budget thresholds after an event is recorded.
 *
 * Accumulates the event's tokens and cost into both daily and weekly
 * period totals, then checks each configured limit. If a threshold
 * (80% warning, 100% alert) is crossed for the first time this period,
 * an alert is enqueued in the budget_alerts table.
 *
 * Returns newly enqueued alerts (empty array if none fired).
 */
export function budgetCheck(
  db: Database.Database,
  event: LLMEvent,
  config?: BudgetConfig,
  now?: Date
): BudgetAlert[] {
  const budget = config ?? loadConfig().budget;
  if (!budget) return [];

  const ts = now ?? new Date();
  const alerts: BudgetAlert[] = [];

  const periods: PeriodType[] = ["daily", "weekly"];
  for (const pType of periods) {
    const pStart = periodStart(pType, ts);

    // Accumulate running totals
    const existing = getPeriodTotals(db, pType, ts);
    const newTokens = (existing?.tokens ?? 0) + event.total_tokens;
    const newCost = (existing?.cost_usd ?? 0) + event.estimated_cost;
    upsertPeriodTotals(db, pType, newTokens, newCost, ts);

    // Determine limits for this period type
    const tokenLimit =
      pType === "daily" ? budget.daily_token_limit : budget.weekly_token_limit;
    const costLimit =
      pType === "daily" ? budget.daily_cost_limit : budget.weekly_cost_limit;

    checkMetric(db, pType, pStart, "tokens", newTokens, tokenLimit, ts, alerts);
    checkMetric(db, pType, pStart, "cost_usd", newCost, costLimit, ts, alerts);
  }

  return alerts;
}

/** Return all undelivered alerts, ordered by fired_at. */
export function getUndeliveredAlerts(db: Database.Database): BudgetAlert[] {
  return db
    .prepare(
      "SELECT * FROM budget_alerts WHERE delivered = 0 ORDER BY fired_at ASC"
    )
    .all() as BudgetAlert[];
}

/** Mark an alert as delivered. */
export function markAlertDelivered(
  db: Database.Database,
  alertId: string
): void {
  db.prepare("UPDATE budget_alerts SET delivered = 1 WHERE id = ?").run(alertId);
}
