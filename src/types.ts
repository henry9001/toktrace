export interface TokTraceOptions {
  /** Path to the SQLite database file. Defaults to ~/.toktrace/events.db */
  dbPath?: string;
  /** Whether to auto-patch OpenAI SDK. Defaults to true. */
  patchOpenAI?: boolean;
  /** Whether to auto-patch Anthropic SDK. Defaults to true. */
  patchAnthropic?: boolean;
}
