import { execFile } from "node:child_process";
import { platform } from "node:os";
import type Database from "better-sqlite3";
import type { BudgetAlert } from "./types.js";
import { loadConfig } from "./config.js";
import type { AlertsConfig } from "./config.js";
import { getUndeliveredAlerts, markAlertDelivered } from "./budget.js";

/**
 * Format a BudgetAlert into a human-readable message.
 *
 * Example: "TokTrace: Daily cost limit 80% reached ($1.60 / $2.00)"
 */
export function formatAlertMessage(alert: BudgetAlert): string {
  const periodLabel = alert.period_type === "daily" ? "Daily" : "Weekly";
  const metricLabel = alert.metric === "cost_usd" ? "cost limit" : "token limit";
  const pct = alert.threshold_pct;

  if (alert.metric === "cost_usd") {
    const current = `$${alert.current_value.toFixed(2)}`;
    const limit = `$${alert.limit_value.toFixed(2)}`;
    return `TokTrace: ${periodLabel} ${metricLabel} ${pct}% reached (${current} / ${limit})`;
  }

  const current = alert.current_value.toLocaleString();
  const limit = alert.limit_value.toLocaleString();
  return `TokTrace: ${periodLabel} ${metricLabel} ${pct}% reached (${current} / ${limit})`;
}

/**
 * Send a desktop notification. Best-effort — failures are silently ignored.
 *
 * - Linux: notify-send
 * - macOS: osascript
 */
export function sendDesktopNotification(title: string, body: string): void {
  const os = platform();
  try {
    if (os === "linux") {
      execFile("notify-send", [title, body], { timeout: 5000 }, () => {});
    } else if (os === "darwin") {
      execFile(
        "osascript",
        ["-e", `display notification "${body}" with title "${title}"`],
        { timeout: 5000 },
        () => {}
      );
    }
    // Windows and other platforms: no-op (best-effort)
  } catch {
    // Desktop notification is best-effort
  }
}

/**
 * Print a CLI warning to stderr.
 */
export function printCliWarning(message: string, level: string): void {
  const prefix = level === "alert" ? "\x1b[31m[ALERT]\x1b[0m" : "\x1b[33m[WARNING]\x1b[0m";
  process.stderr.write(`${prefix} ${message}\n`);
}

/**
 * Deliver a single alert through configured channels.
 */
export function deliverAlert(alert: BudgetAlert, alertsConfig?: AlertsConfig): void {
  const config = alertsConfig ?? loadConfig().alerts ?? {};
  const desktopEnabled = config.desktop !== false;
  const cliEnabled = config.cli !== false;
  const message = formatAlertMessage(alert);

  if (desktopEnabled) {
    sendDesktopNotification("TokTrace Budget Alert", message);
  }

  if (cliEnabled) {
    printCliWarning(message, alert.level);
  }
}

/**
 * Deliver all undelivered alerts and mark them as delivered.
 *
 * Call this after budgetCheck() to send notifications for any newly
 * fired alerts. Already-delivered alerts are skipped.
 *
 * Returns the alerts that were delivered.
 */
export function deliverPendingAlerts(
  db: Database.Database,
  alertsConfig?: AlertsConfig
): BudgetAlert[] {
  const pending = getUndeliveredAlerts(db);
  if (pending.length === 0) return [];

  const config = alertsConfig ?? loadConfig().alerts;
  for (const alert of pending) {
    deliverAlert(alert, config);
    markAlertDelivered(db, alert.id);
  }
  return pending;
}
