/** Describes how to intercept and parse token usage from a raw HTTP provider. */
export interface ProxyTarget {
  /** Human-readable provider name, e.g. "mistral" or "cohere". Used as the `provider` field in events. */
  name: string;
  /** Substring or regex-style pattern matched against the request URL. e.g. "api.mistral.ai" */
  urlPattern: string;
  /** Dot-separated path to the model field in the response JSON. Defaults to "model". */
  modelPath?: string;
  /** Dot-separated path to input/prompt token count. Defaults to "usage.prompt_tokens". */
  inputTokensPath?: string;
  /** Dot-separated path to output/completion token count. Defaults to "usage.completion_tokens". */
  outputTokensPath?: string;
}

export interface TokTraceOptions {
  /** Path to the SQLite database file. Defaults to ~/.toktrace/events.db */
  dbPath?: string;
  /** Whether to auto-patch OpenAI SDK. Defaults to true. */
  patchOpenAI?: boolean;
  /** Whether to auto-patch Anthropic SDK. Defaults to true. */
  patchAnthropic?: boolean;
  /** Whether to auto-patch globalThis.fetch for generic HTTP interception. Defaults to true when proxyTargets are provided. */
  patchGenericHTTP?: boolean;
  /** Proxy target definitions for unsupported providers. Each target describes a URL pattern and how to extract token usage. */
  proxyTargets?: ProxyTarget[];
}

export interface LLMEvent {
  id: string;
  timestamp: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  latency_ms: number;
  prompt_hash: string | null;
  app_tag: string | null;
  env: string | null;
}

export interface SnapshotSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_estimated_cost: number;
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
    total_input_tokens: DeltaValue;
    total_output_tokens: DeltaValue;
    total_estimated_cost: DeltaValue;
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
