# AGENTS rules

Otacon is a tool to enrich the agent plan review, making plans easy to process with rich format in HTML and visualization, inline comments and asks, and review diffs. It's compatible with any coding agents and can be integrated as a skill.

The following conventions are mandatory for any agent
working in this repo.

## Documentation contract

DESIGN.md is the single normative source of product behavior; DECISIONS.md records
only *why*. Keep both lean; these rules exist so neither rots into a changelog.

- **DESIGN.md** is a timeless spec of what otacon is and how it behaves. Any change
  that alters behavior, architecture, protocol shapes, CLI surface, lint rules, or
  storage layout MUST update it in the same commit. It never carries rationale that
  DECISIONS.md owns, nor implementation sequencing, milestone status, or progress notes.
- **DECISIONS.md** records every tradeoff a future reader could not reconstruct from the
  code alone, as a `### Decision / Why / Revisit when` entry, tight (no essays). It is
  grouped under a fixed set of subsystem `##` sections; a new decision goes at the TOP of
  its section (newest-first), in the same commit that makes it. It states rationale only,
  never restating DESIGN.md's behavior.
- **Superseding a decision deletes the old one.** When a new decision overrides an
  earlier entry, DELETE that entry in the same commit (git keeps the full history) and
  fold any still-true rationale into the new entry's Why. Never leave two entries that
  disagree, and never tombstone or mark-superseded-in-place; the log holds only live
  decisions.

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

## Manual E2E Tests

Manually e2e the current checkout with
`bun run verify:branch [flavor]` (`full`/`visuals`/`notify`/`activity`): it builds this
checkout, restarts its isolated daemon, and populates a realistic review session, then
opens it. See `test/verify-branch.sh` + `test/populate-session.sh`.
