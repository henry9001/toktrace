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

## Useful commands

- `toktrace init` — create local config + database.
- `toktrace install` — same as init, plus zero-code run instructions.
- `toktrace run -- <command>` — run any command with auto-instrumentation.
- `toktrace verify` — validate setup and first-event ingestion status.
- `toktrace seed` — insert sample events for instant dashboard preview.
- `toktrace dashboard` — launch local dashboard.
- `toktrace suggest` — generate optimization suggestions.
- `toktrace snapshot create --name "before"` and `toktrace snapshot export --name "before"`.
