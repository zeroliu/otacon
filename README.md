<img width="9034" height="1857" alt="github-otacon" src="https://github.com/user-attachments/assets/18796111-63d7-4df6-a2ba-b95f132eabd3" />

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
2. Enable **HTTPS Certificates** for the tailnet: Tailscale admin console → DNS →
   Enable HTTPS (MagicDNS must be on). This is the one step otacon cannot do for you.
3. `otacon expose` — configures `tailscale serve` for the daemon port, verifies the
   tailnet URL actually serves, and prints the HTTPS URL with `verified: true`.
   Bookmark it on the phone.
4. Keep the Mac awake while a plan is in review: `caffeinate -i`.

If you skip step 2, `tailscale serve` still succeeds but the URL resets every TLS
handshake — so `otacon expose` reports `verified: false` and links the admin DNS page
instead of handing you a dead URL. (Just enabled HTTPS? The cert can take a minute to
provision; re-run `expose`.)

On the Mac App Store Tailscale, putting `tailscale` on your `PATH` needs a manual
launcher — a wrapper script that runs the app-bundle binary (a bare symlink crashes).
otacon finds the app-bundle binary on its own either way.
