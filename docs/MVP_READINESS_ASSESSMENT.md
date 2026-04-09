# TokTrace MVP Readiness Assessment (Against PRD)

Date: 2026-04-09

## Executive take
TokTrace is **close to MVP** for an early developer beta, but **not yet production-ready** for broad release.

- **MVP completeness estimate:** ~70-80%
- **Production readiness estimate:** ~40-55%

Why: the core event capture, SQLite collector, dashboard APIs, trend/totals views, and rules-based suggestion engine are all present. Biggest gaps are onboarding/docs, "install-and-go" UX proof, route/app tagging consistency, explicit privacy redaction hooks, dashboard polish (especially docs export UX), and operational hardening.

## PRD coverage matrix

### 1) SDK instrumentation (`npm install toktrace`, one init)
**Status: Partial to Strong**

Implemented:
- Package is published as `toktrace` with Node >=18 and SDK exports.  
- `init()` exists and auto-applies patch modules.  
- OpenAI + Anthropic monkey-patching exists.  
- Generic HTTP patching supports custom providers via URL/token paths.  
- Captures timestamp/model/provider/input/output/total/cost/latency/prompt hash/env.
- Event schema also includes MCP-related fields (`tool_calls`, `context_size_tokens`, `tool_call_count`).

Gaps:
- `app_tag`/route tagging is in schema, but OpenAI/Anthropic/generic patches currently write it as `null` by default.
- No explicit redaction hook API surfaced in options/config today.
- Prompt-body storage is effectively off by design (good), but privacy controls are implicit rather than first-class documented/configured.

### 2) Dashboard overview
**Status: Partial to Strong**

Implemented:
- Dashboard server + APIs for totals, trends, events, models, routes, snapshots, budget status, suggestions.
- Totals/today+period logic, model breakdown, trend, and event scatter endpoints are present.
- Filters by model/route/time window are present in UI/inline HTML.

Gaps:
- PRD asks for “top endpoints/prompts by token spend”; model and route views exist, but dedicated prompt-spend ranking UI appears limited.
- Dashboard has a mix of inline HTML fallback and React SPA; this split can complicate UX consistency and maintenance.

### 3) Prompt optimization suggestions
**Status: Strong**

Implemented:
- Rules-based engine with multiple heuristics:
  - high token usage
  - model downgrade opportunity
  - high latency
  - output-heavy usage
  - repeated static context
  - high retry loop
- Suggestion cards include issue/impact/action/confidence style data.
- Suggestion persistence table + lifecycle helpers (active/dismissed/actioned).

Gap:
- A dedicated “overlong system prompt” exists as a rule violation path, but not unified into suggestion cards in the same UX stream.

### 4) MCP inefficiency suggestions
**Status: Good (MVP-level)**

Implemented:
- Tool-call-specific heuristics present:
  - too many tool calls per response
  - excessive context growth across calls
- Event schema captures tool call count/content.

Gap:
- PRD also calls out repeated near-identical tool calls; not clearly implemented as its own specific heuristic yet.

### 5) “Write Docs” / markdown export
**Status: Partial**

Implemented:
- Snapshot export creates ZIP with `snapshot.json`, `report.md`, `metadata.json`.

Gap:
- PRD asks for a dashboard markdown export button and top-5 prompt/endpoint summary framing. Current flow appears CLI/snapshot-driven, not clearly surfaced as a direct dashboard action.

### 6) Local datastore + collector
**Status: Strong**

Implemented:
- SQLite store with schema migrations.
- Query/aggregate/trend/snapshot support.

### 7) Quality gates and launch readiness
**Status: Partial**

Implemented:
- Test suite exists across smoke, totals, trend, rules, suggestions, dashboard APIs.
- CI runs typecheck, lint, build.

Gaps:
- CI currently does not run `npm test`.
- README is essentially empty, which is a major blocker for “install-and-go in <5 minutes”.
- No visible telemetry quality checklist, migration/rollback guidance, or release hardening docs.

## Overall opinion
If your goal is a **private alpha** with technical users, you are close and can start quickly after onboarding fixes.

If your goal is **public MVP launch** aligned to this PRD promise (“install one package, one init call, first insight in minutes”), you should complete a short launch-hardening sprint first.

## Highest-impact next steps (in order)

1. **Ship a real quickstart and examples (must-do).**
   - Add README with 5-minute path: install, init, run dashboard, sample output, privacy defaults.
   - Provide OpenAI + Anthropic examples and one generic HTTP provider example.

2. **Make route/app tagging first-class.**
   - Add `appTag` to `TokTraceOptions` and/or middleware helper to set route/function context.
   - Ensure top endpoints view is accurate by default.

3. **Close privacy feature gap explicitly.**
   - Add redaction hook interfaces in options (request/response scrubbers).
   - Add explicit prompt body capture toggle (default off) with docs.

4. **Complete PRD suggestion parity.**
   - Add explicit “repeated near-identical tool call params” MCP rule.
   - Unify rule violations and suggestions into one coherent card surface.

5. **Dashboard UX polish for MVP doD.**
   - Add clear markdown export action from dashboard.
   - Add top prompts/endpoints by spend panel.

6. **Production hardening pass.**
   - Run tests in CI (`npm test`).
   - Add crash/error handling strategy for patch modules and dashboard APIs.
   - Add basic versioned migrations + backup guidance.
   - Add performance guardrails (sampling/retention caps for local DB).

## Suggested launch rubric
Use this simple go/no-go checklist:

- [ ] New user can install + instrument within 10 minutes from README alone.
- [ ] Dashboard shows tokens/cost/trend/top spenders without manual SQL.
- [ ] At least one actionable suggestion appears on realistic seed data.
- [ ] Markdown export is discoverable from dashboard or clearly documented CLI flow.
- [ ] Privacy defaults and redaction behavior are explicit and tested.
- [ ] CI includes typecheck, lint, build, and tests.

Once these are true, TokTrace should be in strong MVP shape and ready for early public users.
