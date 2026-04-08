import { useEffect, useState } from "react";

interface SuggestionCard {
  rule: string;
  title: string;
  impact: string;
  action: string;
  confidence: number;
}

type CardStatus = "active" | "dismissed" | "actioned";

interface TrackedCard extends SuggestionCard {
  status: CardStatus;
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "High";
  if (confidence >= 0.5) return "Medium";
  return "Low";
}

function confidenceColor(confidence: number): string {
  if (confidence >= 0.8) return "#dc2626";
  if (confidence >= 0.5) return "#ca8a04";
  return "#6b7280";
}

export function SuggestionsPanel() {
  const [cards, setCards] = useState<TrackedCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDismissed, setShowDismissed] = useState(false);

  useEffect(() => {
    fetch("/api/suggestions")
      .then((r) => r.json())
      .then((data: SuggestionCard[]) => {
        setCards(data.map((c) => ({ ...c, status: "active" as CardStatus })));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function updateStatus(rule: string, status: CardStatus) {
    setCards((prev) =>
      prev.map((c) => (c.rule === rule ? { ...c, status } : c)),
    );
  }

  const active = cards.filter((c) => c.status === "active");
  const dismissed = cards.filter((c) => c.status !== "active");

  if (loading) {
    return (
      <div className="card">
        <h2>Suggestions</h2>
        <p className="empty">Loading...</p>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="card">
        <h2>Suggestions</h2>
        <p className="empty">No suggestions — your usage looks good.</p>
      </div>
    );
  }

  return (
    <div>
      <h2>Suggestions</h2>
      {active.length === 0 && (
        <div className="card">
          <p className="empty">All suggestions addressed.</p>
        </div>
      )}
      {active.map((card) => (
        <div key={card.rule} className="card suggestion-card">
          <div className="suggestion-header">
            <h3>{card.title}</h3>
            <span
              className="suggestion-confidence"
              style={{ color: confidenceColor(card.confidence) }}
            >
              {confidenceLabel(card.confidence)} confidence
            </span>
          </div>
          <p className="suggestion-impact">{card.impact}</p>
          <p className="suggestion-action">
            <strong>Action:</strong> {card.action}
          </p>
          <div className="suggestion-actions">
            <button
              className="btn-action"
              onClick={() => updateStatus(card.rule, "actioned")}
            >
              Mark actioned
            </button>
            <button
              className="btn-dismiss"
              onClick={() => updateStatus(card.rule, "dismissed")}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
      {dismissed.length > 0 && (
        <div className="suggestion-dismissed-toggle">
          <button
            className="btn-toggle"
            onClick={() => setShowDismissed(!showDismissed)}
          >
            {showDismissed ? "Hide" : "Show"} {dismissed.length} dismissed/actioned
          </button>
          {showDismissed &&
            dismissed.map((card) => (
              <div
                key={card.rule}
                className="card suggestion-card suggestion-inactive"
              >
                <div className="suggestion-header">
                  <h3>{card.title}</h3>
                  <span className="suggestion-status-badge">
                    {card.status === "actioned" ? "Actioned" : "Dismissed"}
                  </span>
                </div>
                <p className="suggestion-impact">{card.impact}</p>
                <div className="suggestion-actions">
                  <button
                    className="btn-restore"
                    onClick={() => updateStatus(card.rule, "active")}
                  >
                    Restore
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
