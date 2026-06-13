# AGENTS.md — working conventions for agent sessions

Otacon is a personal tool (owner: Zero). These conventions are mandatory for any agent
working in this repo.

## Documentation contract

- **DESIGN.md describes product behavior in general** — a timeless spec of what otacon
  is and how it behaves. Any change that alters decisions, architecture, protocol
  shapes, CLI surface, lint rules, or storage layout MUST update DESIGN.md in the same
  commit. Never put implementation sequencing, milestone status, or progress notes in
  DESIGN.md.
- **DECISIONS.md records why.** Every tradeoff decision — anything a future reader
  could not reconstruct from the code alone — gets an entry there (**Decision / Why /
  Revisit when**) in the same commit that makes it.
- **Implementation work is tracked in `.otacon/YYYY-MM-DD-<title>.md`** plan files
  written in otacon's own plan schema (DESIGN.md §4), as if otacon were already built.
  Exactly one plan file per milestone work stream; its sub-milestones are the plan's
  phases. Create the next milestone's plan only when its work starts — never detail
  future milestones upfront. As commits land, record progress in the active plan (a
  `#### Details` note on the completed phase + a frontmatter `revision` bump).
  `.otacon/` is gitignored by design — these are local working state.
- **README.md's Roadmap section is the committed milestone overview** — one line per
  milestone with status. Update it when a milestone starts or finishes.

## Change-size discipline

Keep each PR/commit small and focused on one specific core implementation. Prefer
isolated, testable modules over boiling the ocean. ~300 source LOC is a soft
recommended ceiling — a signal to consider splitting at a natural module boundary,
never a hard limit to game. Do not contort module boundaries, drop tests, or split
incoherently just to duck under the number. **Tests, lockfiles (bun.lock /
package-lock.json), and docs never count toward the limit** — write as much test
coverage as the change deserves.

## Test placement

Test files live next to the implementation they cover: `foo.ts` gets `foo.test.ts` in
the same directory. Test data fixtures live under `test/fixtures/`. The top-level
`test/` directory holds only cross-cutting assets (fixtures, the end-to-end smoke
script) — never `*.test.ts` files. Test files are excluded from the published build
(`tsconfig.build.json`); keep it that way when adding new ones.

## Repo orientation

- `src/shared/` — types, path helpers, config (used by both daemon and CLI)
- `src/daemon/` — otacond: HTTP server, session store, event queues, plan linter
- `src/cli/` — otacon: thin client that coding agents drive via their Bash tool
- `src/ui/` — the React + Vite SPA, built into `dist/ui` and served by the daemon
- `test/` — cross-cutting assets: fixtures and the end-to-end smoke script

Verification commands: `bun test` (unit), `bun run typecheck`, `bun run build` (output
must stay Node-runnable: `node dist/cli/main.js`), `bun run smoke` (end-to-end, once it
exists).

## Hard invariant

No process in this repo ever calls a model API (DESIGN.md §13). The daemon, CLI,
linter, and UI are pure TypeScript; all intelligence runs in the user's interactive
agent session.
