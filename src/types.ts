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
