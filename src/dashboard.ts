import { createServer } from "node:http";
import { URL } from "node:url";
import { listSnapshots } from "./store.js";
import { compareSnapshots } from "./compare.js";
import { loadConfig } from "./config.js";
import { openBudgetDb, getPeriodTotals } from "./budget.js";

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TokTrace — Snapshot Comparison</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; padding: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
  .selector { display: flex; gap: 1rem; align-items: end; margin-bottom: 2rem; flex-wrap: wrap; }
  .selector label { display: flex; flex-direction: column; gap: .3rem; font-size: .85rem; font-weight: 600; }
  .selector select { padding: .5rem; border: 1px solid #ccc; border-radius: 4px; font-size: .9rem; min-width: 220px; }
  .selector button { padding: .5rem 1.2rem; background: #2563eb; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: .9rem; }
  .selector button:disabled { background: #94a3b8; cursor: not-allowed; }
  .selector button:hover:not(:disabled) { background: #1d4ed8; }
  .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); padding: 1.5rem; margin-bottom: 1.5rem; }
  .card h2 { font-size: 1.1rem; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #eee; }
  th { font-weight: 600; color: #666; font-size: .8rem; text-transform: uppercase; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: #dc2626; }
  .neg { color: #16a34a; }
  .zero { color: #666; }
  .empty { color: #999; font-style: italic; padding: 2rem; text-align: center; }
  .suggestions { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .suggestions ul { list-style: disc; padding-left: 1.2rem; }
  .suggestions li { margin-bottom: .3rem; font-size: .9rem; }
  .suggestions h3 { font-size: .9rem; font-weight: 600; margin-bottom: .5rem; }
  .budget-widget { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 2rem; }
  .budget-card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); padding: 1.2rem; }
  .budget-card h3 { font-size: .85rem; font-weight: 600; text-transform: uppercase; color: #666; margin-bottom: .75rem; }
  .budget-bar-wrap { margin-bottom: .75rem; }
  .budget-bar-label { display: flex; justify-content: space-between; font-size: .8rem; margin-bottom: .3rem; }
  .budget-bar { height: 12px; background: #e5e7eb; border-radius: 6px; overflow: hidden; }
  .budget-bar-fill { height: 100%; border-radius: 6px; transition: width .3s ease; }
  .budget-bar-fill.green { background: #16a34a; }
  .budget-bar-fill.yellow { background: #ca8a04; }
  .budget-bar-fill.red { background: #dc2626; }
  .budget-no-config { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); padding: 1.5rem; margin-bottom: 2rem; color: #666; font-size: .9rem; }
  .budget-no-config code { background: #f1f5f9; padding: .2rem .5rem; border-radius: 4px; font-size: .85rem; }
</style>
</head>
<body>
<h1>TokTrace &mdash; Snapshot Comparison</h1>

<div id="budget-container"></div>

<div class="selector">
  <label>Before (A)
    <select id="sel-a"><option value="">Loading&hellip;</option></select>
  </label>
  <label>After (B)
    <select id="sel-b"><option value="">Loading&hellip;</option></select>
  </label>
  <button id="btn-compare" disabled>Compare</button>
</div>

<div id="results"></div>

<script>
const selA = document.getElementById("sel-a");
const selB = document.getElementById("sel-b");
const btn = document.getElementById("btn-compare");
const results = document.getElementById("results");

async function loadSnapshots() {
  const res = await fetch("/api/snapshots");
  const list = await res.json();
  const opts = list.map(s => '<option value="' + s.snapshot_id + '">' + s.name + ' (' + s.captured_at.slice(0, 10) + ')</option>');
  const placeholder = '<option value="">— select —</option>';
  selA.innerHTML = placeholder + opts.join("");
  selB.innerHTML = placeholder + opts.join("");
  updateBtn();
}

function updateBtn() {
  btn.disabled = !selA.value || !selB.value || selA.value === selB.value;
}
selA.addEventListener("change", updateBtn);
selB.addEventListener("change", updateBtn);

function fmtNum(n, decimals) {
  if (decimals != null) return n.toLocaleString(undefined, {minimumFractionDigits: decimals, maximumFractionDigits: decimals});
  return n.toLocaleString();
}

function fmtDelta(d, prefix, decimals) {
  prefix = prefix || "";
  const abs = decimals != null ? prefix + Math.abs(d.absolute).toLocaleString(undefined, {minimumFractionDigits: decimals, maximumFractionDigits: decimals}) : prefix + Math.abs(d.absolute).toLocaleString();
  const sign = d.absolute > 0 ? "+" : d.absolute < 0 ? "\\u2212" : "";
  const pct = d.percent != null ? " (" + (d.percent > 0 ? "+" : d.percent < 0 ? "\\u2212" : "") + Math.abs(d.percent).toFixed(1) + "%)" : "";
  const cls = d.absolute > 0 ? "pos" : d.absolute < 0 ? "neg" : "zero";
  return '<span class="' + cls + '">' + sign + abs + pct + '</span>';
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  btn.textContent = "Loading\\u2026";
  try {
    const res = await fetch("/api/snapshots/compare?a=" + encodeURIComponent(selA.value) + "&b=" + encodeURIComponent(selB.value));
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Compare failed"); }
    const c = await res.json();
    renderComparison(c);
  } catch (err) {
    results.innerHTML = '<div class="card"><p class="empty">Error: ' + err.message + '</p></div>';
  } finally {
    btn.textContent = "Compare";
    updateBtn();
  }
});

function renderComparison(c) {
  const d = c.delta;
  let html = '<div class="card"><h2>Summary Comparison</h2><table>';
  html += '<tr><th>Metric</th><th class="num">Before (A)</th><th class="num">After (B)</th><th class="num">Delta</th></tr>';
  html += row("Total tokens", d.total_tokens, "", 0);
  html += row("Input tokens", d.total_input_tokens, "", 0);
  html += row("Output tokens", d.total_output_tokens, "", 0);
  html += row("Est. cost", d.total_estimated_cost, "$", 6);
  html += row("Events", d.event_count, "", 0);
  html += '</table></div>';

  if (c.top_spenders.length > 0) {
    html += '<div class="card"><h2>Top Spenders</h2><table>';
    html += '<tr><th>Model</th><th class="num">Before cost</th><th class="num">After cost</th><th class="num">Delta</th></tr>';
    for (const s of c.top_spenders) {
      const cls = s.absolute > 0 ? "pos" : s.absolute < 0 ? "neg" : "zero";
      const sign = s.absolute > 0 ? "+" : s.absolute < 0 ? "\\u2212" : "";
      const pct = s.percent != null ? " (" + (s.percent > 0 ? "+" : s.percent < 0 ? "\\u2212" : "") + Math.abs(s.percent).toFixed(1) + "%)" : "";
      html += '<tr><td>' + s.model + '</td><td class="num">$' + fmtNum(s.before_cost, 6) + '</td><td class="num">$' + fmtNum(s.after_cost, 6) + '</td><td class="num"><span class="' + cls + '">' + sign + '$' + fmtNum(Math.abs(s.absolute), 6) + pct + '</span></td></tr>';
    }
    html += '</table></div>';
  }

  if (c.suggestions_a.length > 0 || c.suggestions_b.length > 0) {
    html += '<div class="card"><h2>Suggestions</h2><div class="suggestions">';
    html += '<div><h3>Before (A)</h3>';
    if (c.suggestions_a.length > 0) { html += '<ul>' + c.suggestions_a.map(s => '<li>' + s + '</li>').join("") + '</ul>'; }
    else { html += '<p class="empty">None</p>'; }
    html += '</div><div><h3>After (B)</h3>';
    if (c.suggestions_b.length > 0) { html += '<ul>' + c.suggestions_b.map(s => '<li>' + s + '</li>').join("") + '</ul>'; }
    else { html += '<p class="empty">None</p>'; }
    html += '</div></div></div>';
  }

  results.innerHTML = html;
}

function row(label, d, prefix, decimals) {
  return '<tr><td>' + label + '</td><td class="num">' + prefix + fmtNum(d.before, decimals) + '</td><td class="num">' + prefix + fmtNum(d.after, decimals) + '</td><td class="num">' + fmtDelta(d, prefix, decimals) + '</td></tr>';
}

async function loadBudget() {
  const container = document.getElementById("budget-container");
  try {
    const res = await fetch("/api/budget-status");
    const data = await res.json();
    if (!data.configured) {
      container.innerHTML = '<div class="budget-no-config">No budget configured. Set a budget: <code>toktrace budget set --daily-cost 5.00</code></div>';
      return;
    }
    let html = '<div class="budget-widget">';
    html += renderBudgetCard("Daily", data.daily);
    html += renderBudgetCard("Weekly", data.weekly);
    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '';
  }
}

function renderBudgetCard(label, period) {
  if (!period) return '';
  const hasCost = period.cost_limit != null;
  const hasTokens = period.token_limit != null;
  if (!hasCost && !hasTokens) return '';
  let html = '<div class="budget-card"><h3>' + label + ' Budget</h3>';
  if (hasCost) {
    const pct = period.cost_limit > 0 ? Math.min((period.cost_used / period.cost_limit) * 100, 100) : 0;
    const color = pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";
    html += '<div class="budget-bar-wrap">';
    html += '<div class="budget-bar-label"><span>Cost</span><span>$' + period.cost_used.toFixed(2) + ' / $' + period.cost_limit.toFixed(2) + '</span></div>';
    html += '<div class="budget-bar"><div class="budget-bar-fill ' + color + '" style="width:' + pct.toFixed(1) + '%"></div></div>';
    html += '</div>';
  }
  if (hasTokens) {
    const pct = period.token_limit > 0 ? Math.min((period.tokens_used / period.token_limit) * 100, 100) : 0;
    const color = pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";
    html += '<div class="budget-bar-wrap">';
    html += '<div class="budget-bar-label"><span>Tokens</span><span>' + period.tokens_used.toLocaleString() + ' / ' + period.token_limit.toLocaleString() + '</span></div>';
    html += '<div class="budget-bar"><div class="budget-bar-fill ' + color + '" style="width:' + pct.toFixed(1) + '%"></div></div>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

loadBudget();
loadSnapshots();
</script>
</body>
</html>`;

export interface DashboardOptions {
  port?: number;
  dbPath?: string;
}

export function startDashboard(opts: DashboardOptions = {}): void {
  const port = opts.port ?? 3000;
  const dbPath = opts.dbPath;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (url.pathname === "/api/snapshots" && req.method === "GET") {
      try {
        const snapshots = listSnapshots(dbPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(snapshots));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (url.pathname === "/api/budget-status" && req.method === "GET") {
      try {
        const config = loadConfig();
        const budget = config.budget;
        if (!budget || (!budget.daily_cost_limit && !budget.weekly_cost_limit && !budget.daily_token_limit && !budget.weekly_token_limit)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ configured: false }));
          return;
        }

        const db = openBudgetDb(dbPath);
        const dailyTotals = getPeriodTotals(db, "daily");
        const weeklyTotals = getPeriodTotals(db, "weekly");
        db.close();

        const result: Record<string, unknown> = { configured: true };

        if (budget.daily_cost_limit != null || budget.daily_token_limit != null) {
          result.daily = {
            cost_used: dailyTotals?.cost_usd ?? 0,
            cost_limit: budget.daily_cost_limit ?? null,
            tokens_used: dailyTotals?.tokens ?? 0,
            token_limit: budget.daily_token_limit ?? null,
          };
        }

        if (budget.weekly_cost_limit != null || budget.weekly_token_limit != null) {
          result.weekly = {
            cost_used: weeklyTotals?.cost_usd ?? 0,
            cost_limit: budget.weekly_cost_limit ?? null,
            tokens_used: weeklyTotals?.tokens ?? 0,
            token_limit: budget.weekly_token_limit ?? null,
          };
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (url.pathname === "/api/snapshots/compare" && req.method === "GET") {
      const a = url.searchParams.get("a");
      const b = url.searchParams.get("b");
      if (!a || !b) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Both query params 'a' and 'b' are required" }));
        return;
      }
      try {
        const result = compareSnapshots(a, b, dbPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    console.log(`TokTrace dashboard running at http://localhost:${port}`);
    console.log("Press Ctrl+C to stop.");
  });
}
