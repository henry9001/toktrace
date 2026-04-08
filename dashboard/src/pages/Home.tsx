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

function BudgetBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const color = pct >= 90 ? "#dc2626" : pct >= 70 ? "#ca8a04" : "#16a34a";
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "0.3rem" }}>
        <span>{label}</span>
        <span>
          {label === "Cost" ? `$${used.toFixed(2)} / $${limit.toFixed(2)}` : `${used.toLocaleString()} / ${limit.toLocaleString()}`}
        </span>
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

export function Home() {
  const [budget, setBudget] = useState<BudgetStatus | null>(null);

  useEffect(() => {
    fetch("/api/budget-status")
      .then((r) => r.json())
      .then(setBudget)
      .catch(() => setBudget({ configured: false }));
  }, []);

  return (
    <div>
      <h1>Overview</h1>
      {budget === null && <p className="empty">Loading...</p>}
      {budget && !budget.configured && (
        <div className="card">
          <p className="empty">
            No budget configured. Run <code>toktrace budget set --daily-cost 5.00</code> to get started.
          </p>
        </div>
      )}
      {budget?.configured && (
        <div className="grid-2">
          {budget.daily && <BudgetCard title="Daily" period={budget.daily} />}
          {budget.weekly && <BudgetCard title="Weekly" period={budget.weekly} />}
        </div>
      )}
      <SuggestionsPanel />
    </div>
  );
}
