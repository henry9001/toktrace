export interface TokTraceOptions {
  /** Path to the SQLite database file. Defaults to ~/.toktrace/events.db */
  dbPath?: string;
  /** Whether to auto-patch OpenAI SDK. Defaults to true. */
  patchOpenAI?: boolean;
  /** Whether to auto-patch Anthropic SDK. Defaults to true. */
  patchAnthropic?: boolean;
}

export interface LLMEvent {
  id: string;
  ts: string;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  duration_ms: number;
  endpoint: string | null;
  metadata: Record<string, unknown> | null;
}

export interface SnapshotSummary {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  event_count: number;
  top_spenders: Array<{ model: string; total_cost: number; event_count: number }>;
  suggestions: string[];
}

export interface Snapshot {
  snapshot_id: string;
  name: string;
  captured_at: string;
  window_start: string | null;
  window_end: string | null;
  event_ids: string[];
  summary: SnapshotSummary;
}

export interface DeltaValue {
  before: number;
  after: number;
  absolute: number;
  percent: number | null;
}

export interface TopSpenderDelta {
  model: string;
  before_cost: number;
  after_cost: number;
  absolute: number;
  percent: number | null;
}

export interface SnapshotComparison {
  snapshot_a: Snapshot;
  snapshot_b: Snapshot;
  delta: {
    total_tokens: DeltaValue;
    total_prompt_tokens: DeltaValue;
    total_completion_tokens: DeltaValue;
    total_cost_usd: DeltaValue;
    event_count: DeltaValue;
  };
  top_spenders: TopSpenderDelta[];
  suggestions_a: string[];
  suggestions_b: string[];
}

export type AlertLevel = "warning" | "alert";
export type BudgetMetric = "tokens" | "cost_usd";

export interface BudgetAlert {
  id: string;
  period_type: string;
  period_start: number;
  metric: BudgetMetric;
  threshold_pct: number;
  level: AlertLevel;
  current_value: number;
  limit_value: number;
  fired_at: string;
  delivered: boolean;
}
