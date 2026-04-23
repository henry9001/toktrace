# toktrace

TokTrace is a lightweight Node.js token/cost tracker for LLM calls.

## 60-second quickstart (no app code changes)

```bash
npm install toktrace
npx toktrace install
npx toktrace run -- npm run dev
npx toktrace verify
```

That `toktrace run` command injects `--import toktrace/auto` so OpenAI/Anthropic/generic HTTP patching is enabled automatically.

## Standard quickstart

```bash
npm install toktrace
npx toktrace init
```

Then either:

- Run your app with auto-instrumentation:

  ```bash
  npx toktrace run -- node server.js
  ```

- Or add one line in app startup:

  ```ts
  import { init } from "toktrace";
  init();
  ```

## Dashboard

```bash
npx toktrace dashboard
```

Open `http://localhost:4242`.

No events yet? Seed sample data:

```bash
npx toktrace seed
```

## What gets captured

- timestamp
- model/provider
- input/output/total tokens
- estimated cost
- latency
- prompt hash (full prompt body is not stored by default)
- environment tag
- tool call metadata (`tool_call_count`, serialized tool calls)

## Importing from AI coding CLIs

Already using Claude Code or OpenAI Codex CLI? TokTrace can import every LLM call from your local session logs (no proxy, no key, no runtime injection):

```bash
toktrace import claude-code    # reads ~/.claude/projects/*/*.jsonl
toktrace import codex          # reads $CODEX_HOME/sessions/**/rollout-*.jsonl
```

Both walk their respective local session files, upsert one event per LLM turn, and tag events with `env=claude-code` or `env=codex` so you can filter or compare to your app-level LLM traffic. Re-runs are idempotent — safe to put on a cron.

- **Claude Code**: full token breakdown including cache reads / cache writes, cache-aware cost estimation (write × 1.25, read × 0.10).
- **Codex**: per-turn token usage from the `token_count` events Codex writes to rollouts; reasoning tokens priced at the output rate. Use `--inspect` to preview `event_msg` subtypes if your rollouts have unfamiliar shapes.

Cost estimates for Claude Code Max or ChatGPT Plus subscribers are **hypothetical pay-per-token numbers**, useful for tracking usage volume and per-project burn but not your actual bill (which is flat).

## Useful commands

- `toktrace init` — create local config + database.
- `toktrace install` — same as init, plus zero-code run instructions.
- `toktrace run -- <command>` — run any command with auto-instrumentation.
- `toktrace verify` — validate setup and first-event ingestion status.
- `toktrace seed` — insert sample events for instant dashboard preview.
- `toktrace dashboard` — launch local dashboard.
- `toktrace import claude-code` — import usage from Claude Code session logs.
- `toktrace import codex` — import usage from OpenAI Codex CLI rollouts.
- `toktrace suggest` — generate optimization suggestions.
- `toktrace snapshot create --name "before"` and `toktrace snapshot export --name "before"`.
