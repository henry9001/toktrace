# TokTrace: Current State and Next Epics

Date: 2026-04-10

## Current state (short take)
TokTrace is in a **strong private-alpha state** and already delivers the core value loop for many developers:

- install + init + run flows exist (`toktrace install`, `toktrace run`, `toktrace dashboard`)
- OpenAI + Anthropic + generic HTTP instrumentation are present
- local SQLite-backed collection and dashboard analytics are present
- rules-based suggestion engine is present, including MCP-related heuristics

The project is **not yet fully at PRD MVP Definition of Done quality** for broad launch because a few “last-mile” experience and parity gaps remain:

- install-and-go experience still needs clearer launch-grade UX and docs surface
- prompt/endpoint spend ranking and docs export should be more explicit in dashboard UX
- privacy controls are mostly implicit, not strongly productized in user-facing configuration/docs
- MCP “repeated near-identical tool params” and route/function tagging can be more robust

## Recommended next epics

## Epic 1 — Install-to-Insight in <10 Minutes (Activation Epic)
**Goal:** Make the PRD promise unquestionably true for a brand-new user.

### Outcomes
- users can get first ingestion + first dashboard insight in under 10 minutes, docs only
- installer flow is opinionated and validates setup health automatically

### Scope
- strengthen CLI onboarding (`install`, `run`, `dashboard`) with explicit success checks
- add “first-event verification” and troubleshooting hints in CLI output
- tighten quickstart docs with copy/paste provider examples and expected output screenshots
- add seeded sample data mode for instant dashboard preview when no events yet

### Acceptance criteria
- p50 time-to-first-insight < 10 minutes in smoke onboarding tests
- 70%+ of new installations produce first event within 15 minutes (tracked metric)
- no manual configuration needed for baseline local run

## Epic 2 — Insight Quality and PRD Suggestion Parity (Value Epic)
**Goal:** Increase trust and actionability of recommendations so users actually reduce token burn.

### Outcomes
- suggestion cards are specific, measurable, and consistently tied to observed telemetry
- MCP inefficiency detection meets PRD parity

### Scope
- add explicit heuristic for repeated near-identical tool params across call windows
- standardize suggestion format: issue, impact estimate, confidence, next action
- promote overlong system prompt and static-context findings into a unified suggestion stream
- add “top prompts/endpoints by spend” ranking panel with quick links to related suggestions

### Acceptance criteria
- each suggestion includes evidence references (counts/tokens/time window)
- at least one actionable recommendation appears in seeded realistic workload
- suggestion precision/quality reviewed on representative traces before launch

## Epic 3 — Privacy + Docs Export UX (Launch Readiness Epic)
**Goal:** Make privacy defaults and sharing workflow explicit for real team adoption.

### Outcomes
- privacy posture is obvious and configurable without deep code reading
- markdown/report export is discoverable directly from the dashboard

### Scope
- add first-class redaction hooks and explicit prompt-body capture toggle (default off)
- document data retention behavior and local storage boundaries clearly
- add dashboard “Export Markdown” action (with top-5 prompts/endpoints, model mix, opportunities)
- keep existing snapshot CLI flow as power-user path

### Acceptance criteria
- privacy defaults are visible in init/setup docs and config output
- markdown export is available in one click from dashboard
- exported report includes optimization opportunities and model usage breakdown

## Suggested sequencing (next 6 weeks)
1. **Epic 1 first** (Weeks 1-2): maximizes activation and learning speed.
2. **Epic 2 second** (Weeks 3-4): maximizes perceived value and measurable token reduction.
3. **Epic 3 third** (Weeks 5-6): closes launch trust gaps and collaboration workflow.

This sequence maps directly to the PRD milestones while preserving the developer-first, low-friction product identity.
