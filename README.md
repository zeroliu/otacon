# otacon

> Snake is in the field; Otacon is on the line helping him think it through.

Plan review surface for coding agents (Claude Code, Codex, OpenCode). Replaces native
plan modes with one CLI protocol: schema'd concise plans, anchored comments and
questions from any device (phone included, over Tailscale), revision diffs against
what you last reviewed, and a mandatory grill-me interview phase before any plan
reaches review. Approval produces a committed plan artifact for a future implementer
skill (`snake`) to execute.

**Status: design phase. No code yet.** Read [DESIGN.md](DESIGN.md).

Personal tool by/for Zero. Zero API spend by construction — all model work happens in
your interactive subscription-backed agent session; the daemon, CLI, and UI never call
an LLM.
