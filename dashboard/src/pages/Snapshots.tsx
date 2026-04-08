import { useEffect, useState } from "react";

interface Snapshot {
  snapshot_id: string;
  name: string;
  captured_at: string;
}

interface Delta {
  before: number;
  after: number;
  absolute: number;
  percent: number | null;
}

interface TopSpender {
  model: string;
  before_cost: number;
  after_cost: number;
  absolute: number;
  percent: number | null;
}

interface CompareResult {
  delta: {
    total_tokens: Delta;
    total_input_tokens: Delta;
    total_output_tokens: Delta;
    total_estimated_cost: Delta;
    event_count: Delta;
  };
  top_spenders: TopSpender[];
  suggestions_a: string[];
  suggestions_b: string[];
}

function fmtDelta(d: Delta, prefix = "", decimals?: number) {
  const abs =
    decimals != null
      ? `${prefix}${Math.abs(d.absolute).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
      : `${prefix}${Math.abs(d.absolute).toLocaleString()}`;
  const sign = d.absolute > 0 ? "+" : d.absolute < 0 ? "\u2212" : "";
  const pct =
    d.percent != null
      ? ` (${d.percent > 0 ? "+" : d.percent < 0 ? "\u2212" : ""}${Math.abs(d.percent).toFixed(1)}%)`
      : "";
  const cls = d.absolute > 0 ? "pos" : d.absolute < 0 ? "neg" : "zero";
  return <span className={cls}>{sign}{abs}{pct}</span>;
}

function fmtNum(n: number, decimals?: number) {
  if (decimals != null)
    return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return n.toLocaleString();
}

export function Snapshots() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selA, setSelA] = useState("");
  const [selB, setSelB] = useState("");
  const [result, setResult] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/snapshots")
      .then((r) => r.json())
      .then(setSnapshots)
      .catch(() => {});
  }, []);

  async function compare() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/snapshots/compare?a=${encodeURIComponent(selA)}&b=${encodeURIComponent(selB)}`);
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.error || "Compare failed");
      }
      setResult(await res.json());
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  const canCompare = selA && selB && selA !== selB && !loading;

  return (
    <div>
      <h1>Snapshot Comparison</h1>

      <div className="selector">
        <label>
          Before (A)
          <select value={selA} onChange={(e) => setSelA(e.target.value)}>
            <option value="">— select —</option>
            {snapshots.map((s) => (
              <option key={s.snapshot_id} value={s.snapshot_id}>
                {s.name} ({s.captured_at.slice(0, 10)})
              </option>
            ))}
          </select>
        </label>
        <label>
          After (B)
          <select value={selB} onChange={(e) => setSelB(e.target.value)}>
            <option value="">— select —</option>
            {snapshots.map((s) => (
              <option key={s.snapshot_id} value={s.snapshot_id}>
                {s.name} ({s.captured_at.slice(0, 10)})
              </option>
            ))}
          </select>
        </label>
        <button disabled={!canCompare} onClick={compare}>
          {loading ? "Loading\u2026" : "Compare"}
        </button>
      </div>

      {error && (
        <div className="card">
          <p className="empty">Error: {error}</p>
        </div>
      )}

      {result && <CompareResults data={result} />}
    </div>
  );
}

function CompareResults({ data }: { data: CompareResult }) {
  const d = data.delta;
  const rows: [string, Delta, string, number][] = [
    ["Total tokens", d.total_tokens, "", 0],
    ["Input tokens", d.total_input_tokens, "", 0],
    ["Output tokens", d.total_output_tokens, "", 0],
    ["Est. cost", d.total_estimated_cost, "$", 6],
    ["Events", d.event_count, "", 0],
  ];

  return (
    <>
      <div className="card">
        <h2>Summary Comparison</h2>
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th className="num">Before (A)</th>
              <th className="num">After (B)</th>
              <th className="num">Delta</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, delta, prefix, decimals]) => (
              <tr key={label}>
                <td>{label}</td>
                <td className="num">{prefix}{fmtNum(delta.before, decimals)}</td>
                <td className="num">{prefix}{fmtNum(delta.after, decimals)}</td>
                <td className="num">{fmtDelta(delta, prefix, decimals)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.top_spenders.length > 0 && (
        <div className="card">
          <h2>Top Spenders</h2>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Before cost</th>
                <th className="num">After cost</th>
                <th className="num">Delta</th>
              </tr>
            </thead>
            <tbody>
              {data.top_spenders.map((s) => {
                const cls = s.absolute > 0 ? "pos" : s.absolute < 0 ? "neg" : "zero";
                const sign = s.absolute > 0 ? "+" : s.absolute < 0 ? "\u2212" : "";
                const pct =
                  s.percent != null
                    ? ` (${s.percent > 0 ? "+" : s.percent < 0 ? "\u2212" : ""}${Math.abs(s.percent).toFixed(1)}%)`
                    : "";
                return (
                  <tr key={s.model}>
                    <td>{s.model}</td>
                    <td className="num">${fmtNum(s.before_cost, 6)}</td>
                    <td className="num">${fmtNum(s.after_cost, 6)}</td>
                    <td className="num">
                      <span className={cls}>{sign}${fmtNum(Math.abs(s.absolute), 6)}{pct}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(data.suggestions_a.length > 0 || data.suggestions_b.length > 0) && (
        <div className="card">
          <h2>Suggestions</h2>
          <div className="grid-2">
            <div>
              <h3>Before (A)</h3>
              {data.suggestions_a.length > 0 ? (
                <ul>{data.suggestions_a.map((s, i) => <li key={i}>{s}</li>)}</ul>
              ) : (
                <p className="empty">None</p>
              )}
            </div>
            <div>
              <h3>After (B)</h3>
              {data.suggestions_b.length > 0 ? (
                <ul>{data.suggestions_b.map((s, i) => <li key={i}>{s}</li>)}</ul>
              ) : (
                <p className="empty">None</p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
