import { useEffect, useState } from "react";
import { SuggestionsPanel } from "../components/SuggestionsPanel";

interface BudgetPeriod {
  cost_used: number;
  cost_limit: number | null;
  tokens_used: number;
  token_limit: number | null;
}

interface BudgetStatus {
  configured: boolean;
  daily?: BudgetPeriod;
  weekly?: BudgetPeriod;
}

interface SpendRow {
  estimated_cost: number;
  event_count: number;
  endpoint?: string;
  prompt_hash?: string;
  model?: string;
}

interface SpendRankings {
  top_endpoints: SpendRow[];
  top_prompts: SpendRow[];
  model_mix: SpendRow[];
}

interface PrivacyStatus {
  prompt_body_capture: boolean;
  redaction_hooks: string[];
  retention: string;
}

function BudgetBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const color = pct >= 90 ? "#dc2626" : pct >= 70 ? "#ca8a04" : "#16a34a";
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "0.3rem" }}>
        <span>{label}</span>
        <span>{label === "Cost" ? `$${used.toFixed(2)} / $${limit.toFixed(2)}` : `${used.toLocaleString()} / ${limit.toLocaleString()}`}</span>
      </div>
      <div style={{ height: 12, background: "#e5e7eb", borderRadius: 6, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct.toFixed(1)}%`, background: color, borderRadius: 6 }} />
      </div>
    </div>
  );
}

function BudgetCard({ title, period }: { title: string; period: BudgetPeriod }) {
  return (
    <div className="card">
      <h3>{title} Budget</h3>
      {period.cost_limit != null && <BudgetBar label="Cost" used={period.cost_used} limit={period.cost_limit} />}
      {period.token_limit != null && <BudgetBar label="Tokens" used={period.tokens_used} limit={period.token_limit} />}
    </div>
  );
}

function SpendTable({ title, rows, keyName }: { title: string; rows: SpendRow[]; keyName: "endpoint" | "prompt_hash" | "model" }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="empty">No events yet.</p> : (
        <table>
          <thead>
            <tr><th>{keyName.replace("_", " ")}</th><th className="num">Cost</th><th className="num">Calls</th></tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={`${keyName}-${idx}`}>
                <td>{(r[keyName] as string) ?? "unknown"}</td>
                <td className="num">${r.estimated_cost.toFixed(4)}</td>
                <td className="num">{r.event_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Home() {
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [rankings, setRankings] = useState<SpendRankings | null>(null);
  const [privacy, setPrivacy] = useState<PrivacyStatus | null>(null);

  useEffect(() => {
    fetch("/api/budget-status").then((r) => r.json()).then(setBudget).catch(() => setBudget({ configured: false }));
    fetch("/api/spend-rankings").then((r) => r.json()).then(setRankings).catch(() => setRankings({ top_endpoints: [], top_prompts: [], model_mix: [] }));
    fetch("/api/privacy").then((r) => r.json()).then(setPrivacy).catch(() => setPrivacy(null));
  }, []);

  async function exportMarkdown() {
    const res = await fetch("/api/report/markdown");
    const text = await res.text();
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "toktrace-report.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>Overview</h1>
      <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>Report Export</h3>
          <p style={{ fontSize: "0.85rem", color: "#666" }}>Export markdown with top spenders, model mix, and optimization opportunities.</p>
        </div>
        <button onClick={exportMarkdown}>Export Markdown</button>
      </div>

      {privacy && (
        <div className="card">
          <h3>Privacy Controls</h3>
          <p style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}><strong>Prompt body capture:</strong> {privacy.prompt_body_capture ? "On" : "Off (default)"}</p>
          <p style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}><strong>Redaction hooks:</strong> {privacy.redaction_hooks.length > 0 ? privacy.redaction_hooks.join(", ") : "None configured"}</p>
          <p style={{ fontSize: "0.85rem", color: "#666" }}>{privacy.retention}</p>
        </div>
      )}

      {budget === null && <p className="empty">Loading...</p>}
      {budget && !budget.configured && <div className="card"><p className="empty">No budget configured. Run <code>toktrace budget set --daily-cost 5.00</code> to get started.</p></div>}
      {budget?.configured && (
        <div className="grid-2">
          {budget.daily && <BudgetCard title="Daily" period={budget.daily} />}
          {budget.weekly && <BudgetCard title="Weekly" period={budget.weekly} />}
        </div>
      )}

      {rankings && (
        <div className="grid-2">
          <SpendTable title="Top Endpoints by Spend" rows={rankings.top_endpoints} keyName="endpoint" />
          <SpendTable title="Top Prompts by Spend" rows={rankings.top_prompts} keyName="prompt_hash" />
          <SpendTable title="Model Mix" rows={rankings.model_mix} keyName="model" />
        </div>
      )}

      <SuggestionsPanel />
    </div>
  );
}
