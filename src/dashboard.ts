import express from "express";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { queryEvents, listSnapshots, queryAggregate, queryTrend, listDistinctModels, listDistinctRoutes } from "./store.js";
import { compareSnapshots } from "./compare.js";
import { loadConfig } from "./config.js";
import { openBudgetDb, getPeriodTotals } from "./budget.js";
import { getPricingTable } from "./pricing.js";
import { runRules } from "./suggestions.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SPA_DIR = join(__dirname, "dashboard");

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TokTrace — Snapshot Comparison</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
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
  .totals-widget { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 2rem; }
  .totals-card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); padding: 1.5rem; }
  .totals-card h3 { font-size: .85rem; font-weight: 600; text-transform: uppercase; color: #666; margin-bottom: 1rem; }
  .totals-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
  .totals-stat { display: flex; flex-direction: column; }
  .totals-stat .label { font-size: .75rem; color: #999; text-transform: uppercase; }
  .totals-stat .value { font-size: 1.25rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .totals-stat .breakdown { font-size: .75rem; color: #666; margin-top: .15rem; }
  .totals-empty { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); padding: 1.5rem; margin-bottom: 2rem; color: #999; font-size: .9rem; font-style: italic; text-align: center; }
  .trend-card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); padding: 1.5rem; margin-bottom: 2rem; }
  .trend-card h2 { font-size: 1.1rem; margin-bottom: 1rem; }
  .trend-card canvas { width: 100% !important; max-height: 300px; }
  .filter-bar { display: flex; gap: 1rem; align-items: end; margin-bottom: 2rem; flex-wrap: wrap; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); padding: 1rem 1.5rem; }
  .filter-bar label { display: flex; flex-direction: column; gap: .3rem; font-size: .8rem; font-weight: 600; color: #666; text-transform: uppercase; }
  .filter-bar select, .filter-bar input { padding: .4rem .6rem; border: 1px solid #ccc; border-radius: 4px; font-size: .85rem; min-width: 160px; }
  .filter-bar .custom-range { display: none; gap: .5rem; align-items: center; font-size: .85rem; }
  .filter-bar .custom-range.visible { display: flex; }
  .filter-bar .custom-range input[type="date"] { min-width: 130px; }
  .scatter-card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); padding: 1.5rem; margin-bottom: 2rem; }
  .scatter-card h2 { font-size: 1.1rem; margin-bottom: 1rem; }
  .scatter-card canvas { width: 100% !important; max-height: 400px; cursor: crosshair; }
  .scatter-empty { color: #999; font-style: italic; text-align: center; padding: 2rem; }
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 100; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: #fff; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,.2); padding: 1.5rem; max-width: 480px; width: 90%; max-height: 80vh; overflow-y: auto; }
  .modal h3 { font-size: 1rem; margin-bottom: 1rem; }
  .modal table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  .modal td { padding: .35rem .5rem; border-bottom: 1px solid #eee; }
  .modal td:first-child { font-weight: 600; color: #666; white-space: nowrap; width: 40%; }
  .modal .close-btn { display: block; margin-top: 1rem; padding: .4rem 1rem; background: #e5e7eb; border: none; border-radius: 4px; cursor: pointer; font-size: .85rem; }
  .modal .close-btn:hover { background: #d1d5db; }
</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head>
<body>
<h1>TokTrace &mdash; Snapshot Comparison</h1>

<div class="filter-bar">
  <label>Model
    <select id="filter-model"><option value="">All models</option></select>
  </label>
  <label>Route / Endpoint
    <select id="filter-route"><option value="">All routes</option></select>
  </label>
  <label>Time Window
    <select id="filter-time">
      <option value="today">Today</option>
      <option value="7d" selected>Last 7 days</option>
      <option value="30d">Last 30 days</option>
      <option value="custom">Custom range</option>
    </select>
  </label>
  <div id="custom-range" class="custom-range">
    <input type="date" id="filter-from" title="From date">
    <span>&mdash;</span>
    <input type="date" id="filter-to" title="To date">
  </div>
</div>

<div id="totals-container"></div>

<div id="trend-container"></div>

<div id="scatter-container"></div>

<div class="modal-overlay" id="event-modal">
  <div class="modal">
    <h3>Event Details</h3>
    <table id="event-detail-table"></table>
    <button class="close-btn" id="modal-close">Close</button>
  </div>
</div>

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
const filterModel = document.getElementById("filter-model");
const filterRoute = document.getElementById("filter-route");
const filterTime = document.getElementById("filter-time");
const customRange = document.getElementById("custom-range");
const filterFrom = document.getElementById("filter-from");
const filterTo = document.getElementById("filter-to");

function getFilterParams() {
  const params = new URLSearchParams();
  if (filterModel.value) params.set("model", filterModel.value);
  if (filterRoute.value) params.set("route", filterRoute.value);
  const tw = filterTime.value;
  if (tw === "custom") {
    if (filterFrom.value) params.set("since", filterFrom.value + "T00:00:00.000Z");
    if (filterTo.value) params.set("until", filterTo.value + "T23:59:59.999Z");
  }
  // time window presets are handled server-side via the "window" param
  if (tw !== "custom") params.set("window", tw);
  return params;
}

function onFilterChange() {
  customRange.classList.toggle("visible", filterTime.value === "custom");
  loadTotals();
}

filterModel.addEventListener("change", onFilterChange);
filterRoute.addEventListener("change", onFilterChange);
filterTime.addEventListener("change", onFilterChange);
filterFrom.addEventListener("change", onFilterChange);
filterTo.addEventListener("change", onFilterChange);

async function loadFilterOptions() {
  try {
    const [modelsRes, routesRes] = await Promise.all([
      fetch("/api/models"),
      fetch("/api/routes"),
    ]);
    const models = await modelsRes.json();
    const routes = await routesRes.json();
    filterModel.innerHTML = '<option value="">All models</option>' + models.map(function(m) { return '<option value="' + m + '">' + m + '</option>'; }).join("");
    filterRoute.innerHTML = '<option value="">All routes</option>' + routes.map(function(r) { return '<option value="' + r + '">' + r + '</option>'; }).join("");
  } catch (e) { /* filter options unavailable — keep defaults */ }
}

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

async function loadTotals() {
  const container = document.getElementById("totals-container");
  try {
    const fp = getFilterParams();
    const qs = fp.toString();
    const res = await fetch("/api/totals" + (qs ? "?" + qs : ""));
    const data = await res.json();
    if (data.today.event_count === 0 && data.week.event_count === 0) {
      container.innerHTML = '<div class="totals-empty">No events recorded yet.</div>';
      return;
    }
    const periodLabel = data.period_label || "Last 7 Days";
    let html = '<div class="totals-widget">';
    html += renderTotalsCard("Today", data.today);
    if (periodLabel !== "Today") {
      html += renderTotalsCard(periodLabel, data.week);
    }
    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '';
  }
}

function renderTotalsCard(label, t) {
  let html = '<div class="totals-card"><h3>' + label + '</h3>';
  html += '<div class="totals-grid">';
  html += '<div class="totals-stat"><span class="label">Tokens</span>';
  html += '<span class="value">' + t.total_tokens.toLocaleString() + '</span>';
  html += '<span class="breakdown">' + t.input_tokens.toLocaleString() + ' in / ' + t.output_tokens.toLocaleString() + ' out</span></div>';
  html += '<div class="totals-stat"><span class="label">Cost</span>';
  html += '<span class="value">$' + t.estimated_cost.toFixed(4) + '</span>';
  html += '<span class="breakdown">$' + t.input_cost.toFixed(4) + ' in / $' + t.output_cost.toFixed(4) + ' out</span></div>';
  html += '<div class="totals-stat"><span class="label">Events</span>';
  html += '<span class="value">' + t.event_count.toLocaleString() + '</span></div>';
  if (t.top_models && t.top_models.length > 0) {
    html += '<div class="totals-stat"><span class="label">Top Model</span>';
    html += '<span class="value" style="font-size:1rem">' + t.top_models[0].model + '</span>';
    html += '<span class="breakdown">$' + t.top_models[0].estimated_cost.toFixed(4) + ' (' + t.top_models[0].event_count + ' calls)</span></div>';
  }
  html += '</div></div>';
  return html;
}

async function loadTrend() {
  const container = document.getElementById("trend-container");
  try {
    const res = await fetch("/api/trend");
    const data = await res.json();
    if (data.every(function(d) { return d.total_tokens === 0; })) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = '<div class="trend-card"><h2>Token Usage — Last 7 Days</h2><canvas id="trend-chart"></canvas></div>';
    const ctx = document.getElementById("trend-chart").getContext("2d");
    new Chart(ctx, {
      type: "line",
      data: {
        labels: data.map(function(d) { return d.date.slice(5); }),
        datasets: [
          {
            label: "Total Tokens",
            data: data.map(function(d) { return d.total_tokens; }),
            borderColor: "#2563eb",
            backgroundColor: "rgba(37,99,235,0.1)",
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            pointBackgroundColor: "#2563eb",
          },
          {
            label: "Input Tokens",
            data: data.map(function(d) { return d.input_tokens; }),
            borderColor: "#16a34a",
            backgroundColor: "transparent",
            borderDash: [5, 3],
            tension: 0.3,
            pointRadius: 3,
            pointBackgroundColor: "#16a34a",
          },
          {
            label: "Output Tokens",
            data: data.map(function(d) { return d.output_tokens; }),
            borderColor: "#dc2626",
            backgroundColor: "transparent",
            borderDash: [5, 3],
            tension: 0.3,
            pointRadius: 3,
            pointBackgroundColor: "#dc2626",
          }
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                return ctx.dataset.label + ": " + ctx.parsed.y.toLocaleString();
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(v) { return v.toLocaleString(); }
            }
          }
        }
      }
    });
  } catch (err) {
    container.innerHTML = '';
  }
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

let scatterEvents = [];
let scatterChart = null;

async function loadScatter() {
  const container = document.getElementById("scatter-container");
  try {
    const res = await fetch("/api/events/scatter");
    const events = await res.json();
    scatterEvents = events;
    if (events.length === 0) {
      container.innerHTML = '<div class="scatter-card"><h2>Latency vs Token Size</h2><p class="scatter-empty">No events recorded yet.</p></div>';
      return;
    }

    const providerColors = {};
    const palette = ["#2563eb","#dc2626","#16a34a","#ca8a04","#9333ea","#0891b2","#e11d48","#65a30d"];
    let colorIdx = 0;
    for (const e of events) {
      if (!providerColors[e.provider]) {
        providerColors[e.provider] = palette[colorIdx % palette.length];
        colorIdx++;
      }
    }

    const datasets = {};
    for (const e of events) {
      if (!datasets[e.provider]) {
        datasets[e.provider] = {
          label: e.provider,
          data: [],
          backgroundColor: providerColors[e.provider] + "99",
          borderColor: providerColors[e.provider],
          borderWidth: 1,
          pointRadius: 5,
          pointHoverRadius: 8,
        };
      }
      datasets[e.provider].data.push({ x: e.total_tokens, y: e.latency_ms, _idx: events.indexOf(e) });
    }

    container.innerHTML = '<div class="scatter-card"><h2>Latency vs Token Size</h2><canvas id="scatter-canvas"></canvas></div>';
    const ctx = document.getElementById("scatter-canvas").getContext("2d");
    scatterChart = new Chart(ctx, {
      type: "scatter",
      data: { datasets: Object.values(datasets) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              label: function(context) {
                const e = scatterEvents[context.raw._idx];
                return e.model + ": " + e.total_tokens.toLocaleString() + " tokens, " + e.latency_ms.toLocaleString() + " ms";
              }
            }
          }
        },
        scales: {
          x: { title: { display: true, text: "Total Tokens" }, beginAtZero: true },
          y: { title: { display: true, text: "Latency (ms)" }, beginAtZero: true }
        },
        onClick: function(evt, elements) {
          if (elements.length === 0) return;
          const el = elements[0];
          const point = scatterChart.data.datasets[el.datasetIndex].data[el.index];
          showEventDetail(scatterEvents[point._idx]);
        }
      }
    });
  } catch (err) {
    container.innerHTML = '';
  }
}

function showEventDetail(e) {
  const modal = document.getElementById("event-modal");
  const table = document.getElementById("event-detail-table");
  const rows = [
    ["ID", e.id],
    ["Timestamp", e.timestamp],
    ["Model", e.model],
    ["Provider", e.provider],
    ["Input Tokens", e.input_tokens.toLocaleString()],
    ["Output Tokens", e.output_tokens.toLocaleString()],
    ["Total Tokens", e.total_tokens.toLocaleString()],
    ["Latency", e.latency_ms.toLocaleString() + " ms"],
    ["Est. Cost", "$" + e.estimated_cost.toFixed(6)],
    ["Prompt Hash", e.prompt_hash || "—"],
    ["App Tag", e.app_tag || "—"],
    ["Environment", e.env || "—"]
  ];
  table.innerHTML = rows.map(function(r) { return "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>"; }).join("");
  modal.classList.add("open");
}

document.getElementById("modal-close").addEventListener("click", function() {
  document.getElementById("event-modal").classList.remove("open");
});
document.getElementById("event-modal").addEventListener("click", function(e) {
  if (e.target === this) this.classList.remove("open");
});

loadFilterOptions();
loadTotals();
loadTrend();
loadScatter();
loadBudget();
loadSnapshots();
</script>
</body>
</html>`;

export interface DashboardOptions {
  port?: number;
  dbPath?: string;
  /** Set to false to suppress automatic browser opening. */
  open?: boolean;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} ${url}`, () => {
    // Silently ignore errors — user can open the URL manually
  });
}

export function createApp(dbPath?: string): express.Express {
  const app = express();

  // Serve SPA build if available (static assets)
  app.use(express.static(SPA_DIR));

  // Fallback: serve inline HTML for "/" when no SPA build exists
  app.get("/", (_req, res) => {
    res.type("html").send(DASHBOARD_HTML);
  });

  app.get("/api/events", (req, res) => {
    try {
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const until = typeof req.query.until === "string" ? req.query.until : undefined;
      const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const limit = limitRaw != null && Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
      const events = queryEvents({ since, until, limit }, dbPath);
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/snapshots", (_req, res) => {
    try {
      const snapshots = listSnapshots(dbPath);
      res.json(snapshots);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/models", (_req, res) => {
    try {
      const models = listDistinctModels(dbPath);
      res.json(models);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/routes", (_req, res) => {
    try {
      const routes = listDistinctRoutes(dbPath);
      res.json(routes);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/budget-status", (_req, res) => {
    try {
      const config = loadConfig();
      const budget = config.budget;
      if (!budget || (!budget.daily_cost_limit && !budget.weekly_cost_limit && !budget.daily_token_limit && !budget.weekly_token_limit)) {
        res.json({ configured: false });
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

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/totals", (req, res) => {
    try {
      const now = new Date();
      const model = typeof req.query.model === "string" ? req.query.model : undefined;
      const appTag = typeof req.query.route === "string" ? req.query.route : undefined;
      const window = typeof req.query.window === "string" ? req.query.window : "7d";
      const customSince = typeof req.query.since === "string" ? req.query.since : undefined;
      const customUntil = typeof req.query.until === "string" ? req.query.until : undefined;

      let todaySince: string;
      let periodSince: string;
      let periodLabel: string;
      let periodUntil: string | undefined;

      if (window === "custom" || customSince) {
        todaySince = customSince ?? new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        ).toISOString();
        periodSince = todaySince;
        periodLabel = "Custom Range";
        periodUntil = customUntil;
      } else {
        todaySince = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        ).toISOString();
        const days = window === "30d" ? 29 : window === "today" ? 0 : 6;
        periodSince = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)
        ).toISOString();
        periodLabel = window === "30d" ? "Last 30 Days" : window === "today" ? "Today" : "Last 7 Days";
      }

      const baseFilter = { model, appTag };
      const todayAgg = queryAggregate({ ...baseFilter, since: todaySince, until: customUntil }, dbPath);
      const periodAgg = window === "today"
        ? todayAgg
        : queryAggregate({ ...baseFilter, since: periodSince, until: periodUntil }, dbPath);

      const pricing = getPricingTable();
      const prefixKeys = Object.keys(pricing).sort((a, b) => b.length - a.length);

      function costSplit(byModel: typeof todayAgg.by_model) {
        let inputCost = 0;
        let outputCost = 0;
        for (const m of byModel) {
          const key = prefixKeys.find((k) => m.model.startsWith(k));
          const rates = pricing[m.model] ?? (key ? pricing[key] : undefined);
          if (rates) {
            inputCost += rates.input * m.input_tokens;
            outputCost += rates.output * m.output_tokens;
          } else {
            const total = m.input_tokens + m.output_tokens;
            if (total > 0) {
              inputCost += m.estimated_cost * (m.input_tokens / total);
              outputCost += m.estimated_cost * (m.output_tokens / total);
            }
          }
        }
        return { input_cost: inputCost, output_cost: outputCost };
      }

      function formatPeriod(agg: typeof todayAgg) {
        const split = costSplit(agg.by_model);
        return {
          input_tokens: agg.input_tokens,
          output_tokens: agg.output_tokens,
          total_tokens: agg.total_tokens,
          estimated_cost: agg.estimated_cost,
          input_cost: split.input_cost,
          output_cost: split.output_cost,
          event_count: agg.event_count,
          top_models: agg.by_model.slice(0, 5),
        };
      }

      res.json({
        today: formatPeriod(todayAgg),
        week: formatPeriod(periodAgg),
        period_label: periodLabel,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/trend", (req, res) => {
    try {
      const daysRaw = typeof req.query.days === "string" ? parseInt(req.query.days, 10) : 7;
      const days = Math.min(Math.max(daysRaw, 1), 90);
      const trend = queryTrend({ days }, dbPath);
      res.json(trend);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/snapshots/compare", (req, res) => {
    const a = typeof req.query.a === "string" ? req.query.a : null;
    const b = typeof req.query.b === "string" ? req.query.b : null;
    if (!a || !b) {
      res.status(400).json({ error: "Both query params 'a' and 'b' are required" });
      return;
    }
    try {
      const result = compareSnapshots(a, b, dbPath);
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get("/api/events/scatter", (_req, res) => {
    try {
      const now = new Date();
      const weekStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)
      ).toISOString();
      const events = queryEvents({ since: weekStart, limit: 500 }, dbPath);
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/suggestions", (_req, res) => {
    try {
      const now = new Date();
      const weekStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)
      ).toISOString();
      const events = queryEvents({ since: weekStart }, dbPath);
      const cards = runRules(events);
      cards.sort((a, b) => b.confidence - a.confidence);
      res.json(cards);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/spend-rankings", (_req, res) => {
    try {
      const now = new Date();
      const weekStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)
      ).toISOString();
      const events = queryEvents({ since: weekStart }, dbPath);
      const cards = runRules(events).sort((a, b) => b.confidence - a.confidence);

      const byEndpoint = new Map<string, { endpoint: string; estimated_cost: number; event_count: number }>();
      const byPromptHash = new Map<string, { prompt_hash: string; estimated_cost: number; event_count: number }>();
      const byModel = new Map<string, { model: string; estimated_cost: number; event_count: number }>();

      for (const e of events) {
        const endpoint = e.app_tag ?? "unlabeled";
        const promptHash = e.prompt_hash ?? "unknown";
        const endpointRow = byEndpoint.get(endpoint) ?? { endpoint, estimated_cost: 0, event_count: 0 };
        endpointRow.estimated_cost += e.estimated_cost;
        endpointRow.event_count += 1;
        byEndpoint.set(endpoint, endpointRow);

        const promptRow = byPromptHash.get(promptHash) ?? { prompt_hash: promptHash, estimated_cost: 0, event_count: 0 };
        promptRow.estimated_cost += e.estimated_cost;
        promptRow.event_count += 1;
        byPromptHash.set(promptHash, promptRow);

        const modelRow = byModel.get(e.model) ?? { model: e.model, estimated_cost: 0, event_count: 0 };
        modelRow.estimated_cost += e.estimated_cost;
        modelRow.event_count += 1;
        byModel.set(e.model, modelRow);
      }

      const toTop = <T>(rows: Iterable<T>, keyFn: (row: T) => number) =>
        [...rows].sort((a, b) => keyFn(b) - keyFn(a)).slice(0, 5);

      res.json({
        window_start: weekStart,
        window_end: now.toISOString(),
        top_endpoints: toTop(byEndpoint.values(), (r) => r.estimated_cost),
        top_prompts: toTop(byPromptHash.values(), (r) => r.estimated_cost),
        model_mix: toTop(byModel.values(), (r) => r.estimated_cost),
        suggestions: cards.slice(0, 5),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/privacy", (_req, res) => {
    try {
      const config = loadConfig();
      const privacy = config.privacy ?? {};
      res.json({
        prompt_body_capture: privacy.capture_prompt_body ?? false,
        redaction_hooks: privacy.redaction_hooks ?? [],
        retention: "Telemetry is stored locally in SQLite under ~/.toktrace and never sent to TokTrace servers.",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/report/markdown", (_req, res) => {
    try {
      const now = new Date();
      const weekStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)
      ).toISOString();
      const events = queryEvents({ since: weekStart }, dbPath);
      const cards = runRules(events).sort((a, b) => b.confidence - a.confidence);

      const agg = queryAggregate({ since: weekStart }, dbPath);
      const topModels = agg.by_model.slice(0, 5);
      const byEndpoint = new Map<string, { app_tag: string; estimated_cost: number; event_count: number }>();
      const byPrompt = new Map<string, { prompt_hash: string; estimated_cost: number; count: number }>();
      for (const e of events) {
        const endpoint = e.app_tag ?? "unlabeled";
        const endpointRow = byEndpoint.get(endpoint) ?? { app_tag: endpoint, estimated_cost: 0, event_count: 0 };
        endpointRow.estimated_cost += e.estimated_cost;
        endpointRow.event_count += 1;
        byEndpoint.set(endpoint, endpointRow);
        const key = e.prompt_hash ?? "unknown";
        const row = byPrompt.get(key) ?? { prompt_hash: key, estimated_cost: 0, count: 0 };
        row.estimated_cost += e.estimated_cost;
        row.count += 1;
        byPrompt.set(key, row);
      }
      const topEndpoints = [...byEndpoint.values()].sort((a, b) => b.estimated_cost - a.estimated_cost).slice(0, 5);
      const topPrompts = [...byPrompt.values()].sort((a, b) => b.estimated_cost - a.estimated_cost).slice(0, 5);

      const md = [
        "# TokTrace Dashboard Export",
        "",
        `Window: ${weekStart} → ${now.toISOString()}`,
        "",
        "## Totals",
        `- Events: ${agg.event_count}`,
        `- Total tokens: ${agg.total_tokens.toLocaleString()}`,
        `- Estimated cost: $${agg.estimated_cost.toFixed(4)}`,
        "",
        "## Top 5 Endpoints by Spend",
        ...topEndpoints.map((endpoint, i) => `${i + 1}. ${endpoint.app_tag} — $${endpoint.estimated_cost.toFixed(4)} (${endpoint.event_count} calls)`),
        "",
        "## Top 5 Prompts by Spend",
        ...topPrompts.map((p, i) => `${i + 1}. ${p.prompt_hash} — $${p.estimated_cost.toFixed(4)} (${p.count} calls)`),
        "",
        "## Model Mix",
        ...topModels.map((m, i) => `${i + 1}. ${m.model} — $${m.estimated_cost.toFixed(4)} (${m.event_count} calls)`),
        "",
        "## Optimization Opportunities",
        ...(cards.length > 0
          ? cards.slice(0, 5).map((c, i) => `${i + 1}. **${c.title}** (${Math.round(c.confidence * 100)}% confidence)\n   - Evidence: ${c.evidence}\n   - Impact: ${c.impact}\n   - Next action: ${c.action}`)
          : ["No active opportunities detected in this window."]),
        "",
      ].join("\n");

      res.type("text/markdown").setHeader("Content-Disposition", "attachment; filename=\"toktrace-report.md\"").send(md);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return app;
}

export function startDashboard(opts: DashboardOptions = {}): void {
  const preferredPort = opts.port ?? 4242;
  const app = createApp(opts.dbPath);
  const shouldOpen = opts.open !== false;
  const maxRetries = opts.port != null ? 0 : 10;

  function tryListen(port: number, attempt: number): void {
    const server = app.listen(port);

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attempt < maxRetries) {
        const nextPort = port + 1;
        console.error(`Port ${port} is in use, trying ${nextPort}…`);
        server.close();
        tryListen(nextPort, attempt + 1);
      } else if (err.code === "EADDRINUSE") {
        console.error(`Error: port ${port} is already in use.`);
        if (opts.port != null) {
          console.error("Choose a different port with --port <number>.");
        }
        process.exit(1);
      } else {
        throw err;
      }
    });

    server.on("listening", () => {
      const url = `http://localhost:${port}`;
      console.log(`TokTrace dashboard running at ${url}`);
      console.log("Press Ctrl+C to stop.");
      if (shouldOpen) {
        openBrowser(url);
      }
    });
  }

  tryListen(preferredPort, 0);
}
