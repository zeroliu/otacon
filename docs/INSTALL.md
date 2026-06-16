# Installing otacon

otacon ships as a single npm package — the CLI (`otacon`) and the daemon
(`otacond`) live in the same package, so one install gives you both. It runs on
Node 20 or newer. You install it once per machine; there is no per-repo setup.

## Quick start

```sh
npm install -g otacon                   # one package: CLI + daemon (Node ≥ 20)
otacon install --all                    # agent wrappers; or --agent claude|codex|opencode
otacon install --agent claude --hooks   # also register the Claude Code Stop hook
otacon doctor                           # verify: node, daemon boots, wrappers, Tailscale
```

What each line does:

- **`npm install -g otacon`** — installs the CLI and daemon globally. One package,
  Node ≥ 20.
- **`otacon install --all`** — writes the protocol wrapper into every supported
  agent's skill location. Use `--agent claude`, `--agent codex`, or
  `--agent opencode` to install for a single agent instead.
- **`otacon install --agent claude --hooks`** — additionally registers the Claude
  Code Stop hook (see [Managed files](#what-otacon-install-writes) below).
- **`otacon doctor`** — verifies your setup: Node version, that the daemon boots,
  that the agent wrappers are in place, and that Tailscale is reachable.

You never start the daemon by hand. Any `otacon` command auto-spawns it.

## What `otacon install` writes

`otacon install` drops a protocol wrapper into each agent's skill location so your
coding agent learns how to drive otacon:

- **Claude Code** — `~/.claude/skills/otacon/SKILL.md`, plus the Stop hook script
  at `~/.claude/hooks/otacon-stop.sh`.
- **Codex** — a marked block inside `~/.codex/AGENTS.md`.
- **OpenCode** — `~/.config/opencode/skills/otacon/SKILL.md`.

### Managed-file semantics

These wrappers are **managed files**: a reinstall overwrites them with the current
version. For Codex's shared `~/.codex/AGENTS.md`, only the marked block is managed —
any content of yours outside the markers survives a reinstall untouched.

### The Stop hook (`--hooks`)

`--hooks` merges the Claude Code Stop hook into `~/.claude/settings.json`. The merge
is **additive and idempotent** — it adds the hook without clobbering your other
settings, and running it again does nothing new. otacon backs up
`~/.claude/settings.json` before touching it.

## Per-repo setup: none

There is nothing to configure inside a repository before you use otacon:

- The first `otacon start` in a repo creates a `.otacon/` directory and adds it to
  the repo's `.gitignore` for you.
- Approved plans land **committed** in `docs/plans/`.
- `otacon clean` archives ended sessions' working state to `.otacon/archive/`.

## Updating

```sh
npm update -g otacon   # the version handshake restarts the daemon on next use
```

After an update, the next `otacon` command notices the version change through the
daemon's version handshake and restarts the daemon for you — no manual restart
needed.

## Build from source (contributors)

This path is for contributors or anyone tracking the bleeding edge. The published
npm package is the supported user path; build from source only if you intend to hack
on otacon.

```sh
git clone https://github.com/zeroliu/otacon && cd otacon
bun install
./bin/otacon doctor              # run straight from source
# — or build a Node artifact and link it onto PATH —
bun run build && npm link        # `otacon` now points at this checkout
```

You have two options once the dependencies are installed:

- **Run straight from source** with `./bin/otacon …` (here, `./bin/otacon doctor`).
- **Build and link** with `bun run build && npm link` to compile a Node artifact and
  put `otacon` on your `PATH`, now pointing at this checkout.

> **Note:** `npm i -g github:zeroliu/otacon` is **not** a supported install. The
> published package ships a prebuilt `dist/`, and a GitHub install would need a
> build-on-install step that is intentionally not wired. Use `npm install -g otacon`
> for the supported path, or clone and build as above.
