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

## Install

One-time machine setup (DESIGN.md §16). Until published to npm, install from GitHub:

```sh
npm install -g github:zeroliu/otacon   # one package: CLI + daemon (Node ≥ 20)
otacon install --all                   # agent wrappers; or --agent claude|codex|opencode
otacon install --agent claude --hooks  # also register the Claude Code Stop hook
otacon doctor                          # verify: node, daemon boots, wrappers, Tailscale
```

`otacon install` writes the protocol wrapper into each agent's skill location —
Claude Code: `~/.claude/skills/otacon/SKILL.md` (+ the Stop hook script at
`~/.claude/hooks/otacon-stop.sh`); Codex: a marked block in `~/.codex/AGENTS.md`;
OpenCode: `~/.config/opencode/skills/otacon/SKILL.md`. Wrappers are managed files:
reinstalls overwrite them (outside-the-markers content in Codex's shared file
survives). `--hooks` merges the Stop hook into `~/.claude/settings.json` additively
and idempotently, backing the file up first. The daemon is never started by hand —
any `otacon` command auto-spawns it.

Per-repo setup: **none.** The first `otacon start` in a repo creates `.otacon/` and
gitignores it. Approved plans land committed in `docs/plans/`. `otacon clean` archives
ended sessions' working state to `.otacon/archive/`.

## Phone access

Reviews work from a phone over Tailscale (DESIGN.md §11) — plans never leave your
devices, and the tailnet is the auth:

1. Install Tailscale on the Mac and the phone; log in (`tailscale up`).
2. `otacon expose` — configures `tailscale serve` for the daemon port and prints the
   HTTPS tailnet URL. Bookmark it on the phone.
3. Keep the Mac awake while a plan is in review: `caffeinate -i`.

If `tailscale serve` complains about certificates, enable MagicDNS + HTTPS for the
tailnet in the Tailscale admin console — the one step otacon cannot do for you.

## Roadmap

**Status: v1-complete.** All five milestones are done; the full
install-and-plan loop (DESIGN.md §16) is proven end to end against the built
artifact by `bun run accept` (and `playwright test`'s UI acceptance spec).

- **M1 — daemon + CLI core** (sessions, registry, submit + linter, wait/event queues,
  status; testable via curl/CLI) — **done**
- **M2 — web UI core** (index, plan rendering, SSE, desktop comment/question flow,
  batch send) — **done**
- **M3 — revisions** (diff vs last-reviewed, gutter markers, changelog, threads +
  resolutions, orphan tray) — **done**
- **M4 — grill + approve** (ask/answer cards, transcript panel, traceability lint,
  approve flow + artifact write-out) — **done**
- **M5 — install + phone polish** (install/doctor/expose/open/clean, Claude
  Code/Codex/OpenCode wrappers + Stop hook, Tailscale docs; section-menu
  anchoring, sticky bar, session switcher, live clean) — **done**

All v1 milestones are complete.

- **M6 — expressive plan visuals** (markdown-native callouts, decision matrix, inline
  scope pills + wrapper guidance that pushes their use) — **done**
