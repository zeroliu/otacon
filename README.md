# otacon

> Snake is in the field; Otacon is on the line helping him think it through.

Plan review surface for coding agents (Claude Code, Codex, OpenCode). Replaces native
plan modes with one CLI protocol: schema'd concise plans, anchored comments and
questions from any device (phone included, over Tailscale), revision diffs against
what you last reviewed, and a mandatory grill-me interview phase before any plan
reaches review. Approval produces a committed plan artifact for a future implementer
skill (`snake`) to execute.

Behavior spec: [DESIGN.md](DESIGN.md) · tradeoff rationale: [DECISIONS.md](DECISIONS.md)
· agent conventions: [AGENTS.md](AGENTS.md)

Personal tool by/for Zero. Zero API spend by construction — all model work happens in
your interactive subscription-backed agent session; the daemon, CLI, and UI never call
an LLM.

## Roadmap

- **M1 — daemon + CLI core** (sessions, registry, submit + linter, wait/event queues,
  status; testable via curl/CLI) — **in progress**
- **M2 — web UI core** (index, plan rendering, SSE, desktop comment/question flow,
  batch send)
- **M3 — revisions** (diff vs last-reviewed, gutter markers, changelog, threads +
  resolutions, orphan tray)
- **M4 — grill + approve** (ask/answer cards, transcript panel, traceability lint,
  approve flow + artifact write-out)
- **M5 — phone polish + agent wrappers** (section-menu anchoring, sticky bar, Tailscale
  docs, Claude Code/Codex/OpenCode wrappers + Stop hook)
