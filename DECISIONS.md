# Decisions

Why, not what — the *what* lives in [DESIGN.md](DESIGN.md). One entry per decision a
future reader could not reconstruct from the code alone. Format: **Decision / Why /
Revisit when**. Every tradeoff made in a change gets its entry here in the same commit
(see [AGENTS.md](AGENTS.md)).

## Storage: plain JSON files, not SQLite

- **Decision:** All daemon state is plain JSON files (`~/.otacon/registry.json`,
  `~/.otacon/sessions/<id>/{session,events}.json`), written atomically (tmp + rename).
- **Why:** Zero native dependencies (better-sqlite3 needs node-gyp), state stays
  human-inspectable with `cat`, single-user write volumes are tiny, and corruption
  recovery is "quarantine one small file".
- **Revisit when:** Concurrent writers appear, or state outgrows whole-file rewrites.

## Tooling: bun for dev, plain Node for the shipped artifact

- **Decision:** bun is the dev package manager and test runner (`bun test`); the
  published package builds with plain `tsc` (no bundler) and its bins run on Node.
- **Why:** bun for speed where only the developer sees it; Node because
  `npm install -g otacon` must work everywhere with no runtime surprises. `tsc`'s 1:1
  `src/ → dist/` mapping keeps `import.meta.url`-relative file resolution deterministic
  (bundlers flatten/rename and would break daemon spawn-by-path).
- **Revisit when:** Startup time matters enough to bundle, or bun-on-PATH becomes a
  safe runtime assumption.

## Daemon spawned by resolved file path, never PATH

- **Decision:** The CLI auto-spawns otacond via `process.execPath` + the daemon entry
  resolved relative to its own module (`new URL("../daemon/main.js", import.meta.url)`;
  when no built sibling exists — a source-tree run under bun — the `.ts` entry, which
  bun's execPath runs directly). The `otacond` bin exists only as a manual-debugging
  convenience.
- **Why:** The CLI always spawns *its own package's* daemon — `npm i -g`, `npm link`,
  and local dev all behave identically, and "which otacond is on PATH" version skew
  cannot happen. This is what makes the version handshake meaningful.
- **Revisit when:** Never, realistically.

## Plan visuals: markdown-native, semantic-ink, budget-capped

- **Decision:** Review-oriented plan visuals (v1: typed callouts, decision matrices, and
  inline scope pills) are authored as plain markdown the renderer styles — a `> [!type]`
  blockquote, a `✓`-led GFM table, bracket tokens — not fenced DSLs. Type/winner is
  encoded with semantic ink (a 2px accent rule + glyph/hue drawn from the tested
  chip/accent palette), no heavy fills, no radius. The block visuals are exempt from line
  budgets but capped per read-path section (default 2, tunable), parallel to the one-fence
  rule; inline pills are always free.
- **Why:** Markdown-native keeps every element comment-anchorable (a comment pins to one
  risk), diff-able, and degrading to readable text if rendering fails — a fenced DSL
  would anchor only at section level and sit outside the budget/diff machinery. Semantic
  ink lets a risk pop out of prose without becoming a Notion block, staying inside the
  §10 hairline discipline. Budget-exempt-but-capped preserves the "no wall of text"
  invariant: a 2-line risk can _be_ a callout, but a section can't fill with widgets.
- **Revisit when:** A visual genuinely needs structure plain markdown can't express (the
  blast-radius file tree was cut from v1 for exactly this reason), or the cap default of
  2 proves wrong in real use.

## Mermaid diagrams are exempt from the per-section fence cap

- **Decision:** A `mermaid` fence counts only toward `diagramCount` (the L7 lead-diagram
  check), never toward `fenceCount` / `E_FENCE_CAP`. Code and before/after fences keep
  the one-fence-per-read-path-section cap; the lead diagram no longer spends Summary's
  fence allowance.
- **Why:** otacon actively encourages diagrams, especially for tree- and hierarchy-shaped
  content, so a one-fence-per-section cap conflicts with the common shape of a lead
  diagram plus an in-section structural diagram. Diagrams are visual, not prose, and the
  line budgets already keep sections scannable, so the cap's "no wall of text" job is
  already done without charging diagrams against it.
- **Revisit when:** Sections start stacking diagrams and reading cluttered; then
  reintroduce a higher diagram-specific cap rather than the blanket exemption.

## Plan parser: hand-rolled and line-based, no markdown/yaml libraries

- **Decision:** The linter parses plans with a single-pass, line-oriented parser; no
  remark/marked, no yaml package.
- **Why:** The schema is deliberately rigid (fixed H2 set, labeled phase fields, flat
  scalar frontmatter), so an AST adds dependency weight without signal. Owning the line
  loop makes errors line-number-accurate and the budget rules deterministic.
- **Revisit when:** The schema gains nesting that makes hand-parsing error-prone.

## Event delivery: at-least-once

- **Decision:** `wait` delivery dequeues in memory, responds, then flushes disk. A
  crash inside that window re-delivers the event rather than losing it. Stable ids
  (`b<n>`/`t<n>`/`q<n>`) make duplicates detectable downstream.
- **Why:** For a human-in-the-loop review tool, a silently lost comment is the
  unacceptable failure; a duplicate is a shrug.
- **Revisit when:** An explicit ack protocol is worth the extra round trip.

## Spawn race: the port is the lock

- **Decision:** No lockfile. Two CLIs may both spawn a daemon; the loser exits 0 on
  EADDRINUSE and both health-poll whoever won the bind.
- **Why:** The OS already serializes port binds; a lockfile adds stale-lock cleanup for
  zero extra safety.
- **Revisit when:** The daemon ever listens on more than one resource.

## SessionQueue: synchronous methods only

- **Decision:** Every `SessionQueue` method runs synchronously (sync file flushes, no
  `await` between the queue-empty check and waiter parking).
- **Why:** This is the entire no-lost-wakeup argument: Node's single thread cannot
  interleave an enqueue between "check found empty" and "waiter parked" if the whole
  block is synchronous. Cheap to guarantee at single-user scale.
- **Revisit when:** Event volume makes sync I/O a real latency cost.

## Plan grammar: accepted field and heading forms

- **Decision:** Phase fields accept `Goal:` and `**Goal**:`/`**Goal:**` (case-sensitive
  labels: Goal, Files, Verification, Out of scope); a field runs until the next label,
  heading, or `#### Details`. Phase headings accept `—` or `-`; numbers must be 1..N
  strictly ascending.
- **Why:** Models emit both bold and plain label styles and both dash characters;
  rejecting one form would cause pointless lint-fix loops. Everything else stays strict.
- **Revisit when:** Observed agent output shows other benign variants worth accepting.

## Schema is closed: unknown structure is an error

- **Decision:** Unknown extra H2 sections and non-Details H4s inside phases are L1
  errors, not warnings.
- **Why:** "Fixed sections" only constrains conciseness if the set is closed — loose
  extra sections are exactly where detail-smuggling would creep in.
- **Revisit when:** A real recurring need for an optional section shows up.

## `.otacon/` at the git repo root holds config + saved plans only

- **Decision:** `otacon start` resolves `git rev-parse --show-toplevel` and uses that
  repo root for the registry's `repo` field and for the repo-local `.otacon/` dir, which
  now holds ONLY project config (`config.json` / `config.local.json`) and, on Save, the
  `plans.dir` copies. Per-session working state moved to the home store
  (`~/.otacon/sessions/<id>/`, see "Session working state lives in the home store"
  below); the repo root no longer determines where session state is written. In non-git
  directories `start` warns and uses the cwd as the repo root. (otacon touches no
  `.gitignore` either way; see "otacon manages no `.gitignore`" below.)
- **Why:** The repo-root resolution still matters for config (a subdirectory invocation
  must find the same project config) and for the registry's single-active-session-per-repo
  rule; separate worktrees have distinct roots, which preserves worktree-parallel planning
  for free. But per-session state has no reason to live in the repo: keying it by the
  globally-unique session id in the home store keeps `<repo>/.otacon/` clean (config +
  saved plans) and makes session state repo-independent. The non-git fallback keeps
  temp-dir testing trivial.
- **Revisit when:** Monorepo sub-project sessions become a real use case.

## Frontmatter authority: the daemon owns `revision` and `status`

- **Decision:** L1 requires the frontmatter keys to exist and `session` to match the
  target session (error); mismatched `revision`/`status` *values* are warnings only.
- **Why:** The daemon's store is the source of truth; failing a submit because the
  agent forgot to bump a counter the daemon tracks anyway would be pure friction. The
  `session` check stays hard because cross-posting a plan to the wrong session is
  unrecoverable confusion.
- **Revisit when:** Warnings prove too weak to keep frontmatter honest.

## Status transitions on feedback

- **Decision:** A comment batch flips the session to `revising`; user questions leave
  status untouched; every successful submit sets `in_review`.
- **Why:** Comments are by definition revision requests (DESIGN.md §9); questions
  explicitly leave the plan untouched. Encoding that in status keeps the UI chips
  honest without extra state.
- **Revisit when:** Approve/resolution flows (M3/M4) need finer states.

## Budget counting: non-blank lines, fences exempt

- **Decision:** A budgeted line count = non-blank lines, excluding fenced-block content
  *and* the fence delimiter lines. Details blocks count raw lines (everything).
- **Why:** DESIGN.md exempts fences from budgets; counting delimiters would silently
  charge 2 lines per diagram. Blank lines are layout, not content. Details' soft cap is
  about scroll length, so there raw size is the honest measure.
- **Revisit when:** Budget gaming via blank-line abuse actually happens.

## Env overrides: `OTACON_HOME` and `OTACON_PORT`

- **Decision:** Both CLI and daemon honor `OTACON_HOME` (default `~/.otacon`) and
  `OTACON_PORT` (default 4747). Not in DESIGN.md's UX surface.
- **Why:** Hermetic tests (smoke tests run against a temp HOME and a non-default port)
  and an escape hatch for port conflicts. Harmless otherwise.
- **Revisit when:** Real config wants to subsume them.

## Project config: gitignored `<repo>/.otacon/config.json`, no committed layer

> [!warning] Superseded by "Two-tier project config" below. This made
> `<repo>/.otacon/config.json` gitignored with no committed layer; the two-tier
> decision makes `config.json` the **committed** project layer and adds a
> gitignored `config.local.json` override.

- **Decision:** The per-repo config override is `<repo>/.otacon/config.json` (in the
  already-gitignored `.otacon/` dir). The old committed `<repo>/otacon.config.json`
  layer is dropped — the read order is now defaults ← `~/.otacon/config.json` ←
  `<repo>/.otacon/config.json`.
- **Why:** The upcoming Settings UI writes project config; pointing it at the gitignored
  dir means it never mutates a tracked, team-shared file (zero tracked edits, ever).
  Config is per-developer tuning, not a shared contract, so a committed layer wasn't
  earning its keep. No repos rely on the old path yet, so a hard drop beats migration
  ceremony.
- **Revisit when:** A genuinely shared, reviewed project config (committed, PR-edited)
  becomes worth reintroducing as a distinct layer.

## Two-tier project config: committed `config.json` + gitignored `config.local.json`

- **Decision:** Project config goes two-tier, mirroring Claude Code's `settings.json`
  (committed) + `settings.local.json` (gitignored): `<repo>/.otacon/config.json` is the
  **committed, team-shared** project layer and `<repo>/.otacon/config.local.json` is a
  **gitignored, personal** override. Precedence is defaults ← user
  (`~/.otacon/config.json`) ← project (`config.json`) ← project.local
  (`config.local.json`) — closest wins. `otacon start` writes a **selective** ignore to
  a fresh repo's `.gitignore` (`.otacon/*` + `!.otacon/config.json`) so all working
  state stays ignored while `config.json` is trackable; `config.local.json` is caught by
  the `.otacon/*` glob. The daemon `/api/config` GET/POST gain a `project.local` scope.
  This supersedes the "gitignored, no committed layer" decision above (#11).
- **Why:** The genuinely shared, reviewed project config that #11 deferred is now needed
  so a team can commit a shared save location (the configurable-plan-storage feature):
  `plans.dir` is a contract a team wants to share, not per-developer tuning. Claude
  Code's two-tier split is the proven pattern — committed defaults plus a `.local`
  personal escape hatch — so we adopt it verbatim rather than invent. The selective
  gitignore keeps the one tracked file precise: `.otacon/*` + a single negation, instead
  of enumerating every working-state path. No migration of pre-existing blanket
  `.otacon/` ignores: pre-release, no repos carry one (decision t2), and `start` simply
  leaves any existing otacon ignore line untouched.
- **Revisit when:** Two tiers stop being enough (e.g. a third committed-but-environment
  scope), or the selective-ignore negation collides with a path users want ignored under
  `.otacon/`.
- **Superseded in part** by "otacon manages no `.gitignore`; build worktrees live in
  `~/.otacon`" below: the `.otacon/*` + `!.otacon/config.json` ignore `start` used to
  write is gone. The two-tier *layering* survives unchanged (user ← project ←
  project.local, closest wins); only the auto-ignore did — `config.local.json` is no
  longer special-cased out of git, so a developer who wants it private now ignores it
  themselves.

## Single `CONFIG_SCHEMA` as the source of truth; `worktree.dir` tunable

- **Decision:** One `CONFIG_SCHEMA` (field metadata: section/key/label/type/default/min)
  enumerates every leaf config key; runtime merging, the API validator, and the future
  UI all derive from it. A guard test asserts it matches `DEFAULT_CONFIG` exactly. Added
  a `worktree.dir` field (`type:"path"`, default `~/.otacon/worktrees` — see the
  worktree-location decision below; was `.otacon/worktrees` when first added).
- **Why:** Two parallel code paths (file merge + API validation) drifting apart is the
  obvious failure mode once a UI can write config; one schema with one `coerceFieldValue`
  rule per type keeps them in lockstep, and the guard test makes "added a key but forgot
  the schema/UI" a test failure. `worktree.dir` lets a developer relocate the build tree
  without a new bespoke knob.
- **Revisit when:** A field needs validation richer than int/bool/path (enums, ranges,
  cross-field constraints), or config grows nested structures the flat schema can't model.

## `POST /api/config` replaces the scope file; project scope requires a repo

- **Decision:** `POST /api/config` overwrites the target scope file with the sanitized
  sparse `values` (only valid, provided keys) rather than merging into what's on disk. A
  field the UI cleared is simply absent from `values`, so it's gone from the file and
  reverts to inherited. `scope:"project"` with no `repo` is a 400 (writes nothing); a
  value that fails its type rule is a 422 `{fieldErrors}` (writes nothing).
- **Why:** Replace is the only semantics that lets the Settings UI express "reset this
  field to inherited" — a merge could never delete a key, so a cleared field would stick
  forever. The UI already holds the full intended scope state, so sending it whole is
  natural and keeps the daemon stateless about prior values. Project config lives in a
  repo-scoped file, so writing it without a repo has no well-defined target — refuse
  rather than guess.
- **Revisit when:** Concurrent editors of the same scope file need field-level merge, or
  a partial-update (PATCH-style) verb proves worth the extra surface.

## `otacon config` opens the Settings UI; `config get` is read-only; no CLI editing

- **Decision:** Two CLI forms only: `otacon config` (open the `/settings` web UI in the
  browser: `?repo=<cwd repo root>` inside a repo, bare `/settings` outside one; launches
  like `otacon open`, `OTACON_NO_BROWSER` prints the URL instead) and `otacon config get
  <key>` (read-only merged lookup of
  one dotted key via `loadConfig`, validated against `CONFIG_SCHEMA`, no daemon). There
  is deliberately **no** `config set` / write verb — editing config stays UI-only.
- **Why:** q4 declined a get/set *editing* CLI; the Settings UI is the one writer, which
  keeps the write surface (validation, scope/repo targeting, replace semantics) in one
  place. But the agent's Approve & Implement loop needs to *read* `worktree.dir` to place
  its build worktree (§12), so a strictly read-only `config get` is the minimum surface
  that unblocks that without reopening CLI writes. Reading config never needs the daemon
  (the files are the source of truth), so `config get` reads them directly and stays fast
  and dependency-free.
- **Revisit when:** Agents or scripts need to read whole config sections (not single
  keys), or a non-interactive write path (CI seeding a project config) proves worth the
  editing surface q4 declined.

## Settings screen shows inherited defaults + cross-scope override flags

- **Decision:** The Settings screen presents each field's *inherited* fallback, not just
  the schema default, across all three scopes (user < project < project.local). When a
  field is unset in the active scope it shows the value it inherits and flags its source:
  Project inherits the user profile ("default from user profile"); Project · local
  inherits the committed project first, then the user profile ("default from project" /
  "default from user profile"). It also flags a value shadowed from above: User flags a
  field a project or project · local overrides ("overridden by project" / "overridden by
  project · local"); Project flags a project · local override. The inherit/override chains
  are computed by walking ordered ancestor/overrider lists (highest precedence first), so
  the first scope that sets the field wins and names itself — there is no fixed two-scope
  special-casing. An override hint wins the single hint slot over an inherit hint. To
  compute these the screen fetches `GET /api/config` with `?repo=` whenever a repo is
  selected — on *every* tab, not only the project ones — so all three scopes are always in
  hand. The repo selector stays visible on the User tab as an optional "compare repo" (the
  user file it writes is global regardless). No API or storage change: the GET already
  returns all three scopes, and POST still replaces one file.
- **Why:** The overlay order is invisible if every field just shows its hardcoded schema
  default — a value that "looks unset" is actually inheriting from a lower scope, and a
  setting can silently lose to a higher one. Showing the *effective* inherited value and
  the override direction makes the precedence legible at the point of editing. Walking
  ordered scope lists (rather than a per-pair flag) is what let the third scope drop in
  without re-special-casing the hint logic. Fetching the project scopes on the User tab is
  the cheapest way to know the override direction without a new endpoint; the cost is that
  picking a compare repo re-fetches and re-seeds the form (mirroring the existing
  reload-reseed), so an in-progress User edit is discarded on repo change — acceptable for
  a rare action.
- **Revisit when:** A worktree config *scope* lands (today worktree is a section, not a
  layer), adding a fourth precedence level; or editing one scope while comparing against
  several repos at once becomes a real need.

## Settings auto-saves on blur; no Save button

- **Decision:** The Settings screen has no Save button; edits auto-save. A text/number
  field commits when it loses focus (only if it actually changed); a checkbox toggle and a
  reset-to-inherit commit immediately. Each save posts the full sparse `buildPayload`
  (POST still replaces the scope file). On success the screen advances a local `baseline`
  to the saved form *instead of* refetching and reseeding, and saves are single-flighted (a
  save fired while one is in flight is queued, and the latest queued one runs after the
  current resolves). 422s still render inline per field. An ambient "changes save
  automatically" note sits inline under the path banner (documenting the no-button
  contract up top), and the transient lifecycle (saving / saved ✓ / error) reports through
  a floating toast pinned to the viewport rather than an in-flow footer.
- **Why:** A Save button is easy to forget: tweak a value, navigate away, silently lose
  it; blur is the natural commit point. The save confirmation is the one piece of feedback
  the user actively waits for, so it floats as a viewport-pinned toast: an in-flow footer
  landed below the fold and an edit made up top would confirm off-screen, reading as "did
  it save?". The autosave *documentation* has no such urgency, so it stays inline up top
  where it is read once. The replace-file POST already carries the complete
  desired override set, so committing per field is free. The earlier flow refetched and
  reseeded the whole form after each save (fine for a once-at-the-end Save); under
  auto-save that fires mid-editing and the reseed would clobber an in-progress edit in
  another field, so the baseline is advanced locally and the network refetch dropped. A
  scope-tab switch remounts `ScopeFields` (it is keyed by `scope:repo`) but reuses the
  fetch already in memory rather than re-fetching, so the save *also* patches that cache
  (`useConfig.applySaved`, mirroring the persisted values) — otherwise re-entering the
  just-edited tab would re-seed from the pre-save fetch and show the stale value. A *repo*
  switch genuinely refetches (the repo is the fetch key), so cross-scope hints stay fresh.
  Single-flight
  is required because the endpoint *replaces* the file: two overlapping saves landing out
  of order would let a stale earlier payload overwrite a newer one.
- **Revisit when:** A field wants debounced live-save while typing (not just on blur), or a
  save failure needs a richer manual-retry affordance than the inline 422 errors.

## Per-worktree daemon isolation in the dogfood shim

- **Decision:** `bin/otacon` detects a linked git worktree (`.git` is a *file*, not a
  directory) and — unless the caller already set them — derives a stable per-worktree
  `OTACON_PORT` (`4800 + cksum(root) % 1000`) and `OTACON_HOME`
  (`~/.otacon-worktrees/<basename>-<cksum>`) before exec'ing the CLI. The main checkout
  (`.git` is a directory) is left on 4747 / `~/.otacon`. The shim also intercepts
  `./bin/otacon restart`, POSTing `/api/shutdown` at the resolved port.
- **Why:** One shared daemon (the port is the lock) is fine for parallel *planning* —
  sessions are already isolated by repo root (DESIGN.md §7). But it defeats testing
  *divergent daemon source* across worktrees: the version handshake only restarts on a
  version *mismatch*, and every worktree carries the same `VERSION`, so a worktree would
  silently reuse whichever one spawned the daemon first — exercising the wrong
  `src/daemon/**`. Isolating port + home per worktree gives each its own daemon from its
  own source. This lives only in the dev shim; the product CLI/daemon defaults are
  unchanged, so DESIGN.md's one-daemon model still holds for installed otacon. `restart`
  exists because the same-`VERSION` handshake can't auto-restart after a daemon-source
  edit, and the raw `curl … :4747` it replaces would hit the wrong daemon in a worktree.
- **Revisit when:** Worktree port collisions actually bite (the cksum range is 1000
  wide), or the CLI grows a real `restart` subcommand the shim's intercept would shadow.

## Multiple waiters: FIFO, one event each

- **Decision:** Concurrent `wait` calls on one session queue up; each delivered event
  goes to exactly one waiter, first-parked first.
- **Why:** Preserves "one event per wait call" without forbidding the odd second
  watcher; deterministic and trivial to implement.
- **Revisit when:** A broadcast consumer (e.g., a dashboard) wants every event.

## Session ids: `otc_` + 6 base36 chars

- **Decision:** Ids are `otc_` plus 6 lowercase base36 characters from
  `crypto.randomBytes`, collision-checked against the registry.
- **Why:** Short enough to type from a phone screen, unique enough for a single user's
  registry; the prefix makes them greppable.
- **Revisit when:** Never, realistically.

## Daemon serves the built SPA from dist/ui with a hand-rolled static handler

- **Decision:** `vite build` emits the UI into `dist/ui`; the daemon serves `/` and
  `/s/:id` as the SPA shell (index.html, no-cache) and `/assets/<name>` with a strict
  flat-name regex and immutable cache headers, resolving the UI dir relative to its
  own module (`../ui` from `dist/daemon`, falling back to `<root>/dist/ui` for
  source-tree runs). No serveStatic middleware. `/s/:id` always answers 200 — unknown
  ids render a client-side not-found. Without a build, the pages answer 503.
  (Supersedes the M1 plain-text `/s/:id` placeholder.)
- **Why:** @hono/node-server's serveStatic resolves roots against `process.cwd()`,
  which is meaningless for a daemon spawnable from any repo; resolving next to the
  module is the same trick that makes daemon spawn-by-path reliable. Vite's output is
  a flat hashed-asset dir, so the name regex is a complete traversal guard in ~40
  lines. A static shell cannot know session ids, so the 404 moved into the client.
- **Revisit when:** the UI build stops emitting a flat assets dir, or the daemon must
  serve anything user-supplied.

## Documentation structure: behavior spec, decision log, gitignored work plans

- **Decision:** DESIGN.md describes product behavior only (no sequencing); this file
  records tradeoff rationale; implementation work is tracked in gitignored
  `.otacon/YYYY-MM-DD-<title>.md` plans written in otacon's own plan schema, one per
  milestone work stream; README's Roadmap is the committed milestone overview.
- **Why:** Keeps the spec timeless instead of rotting into a changelog; dogfoods the
  plan artifact format before the tool exists; keeps review exhaust out of git exactly
  as the product itself will.
- **Revisit when:** Once otacon can run its own planning sessions, the hand-written
  plan files should become real otacon sessions.

## SessionQueue API: in-flight tracking, flush(event) ack, store-minted seqs

- **Decision:** `take()` and waiter wake-ups move the event to an in-flight list; the
  caller responds, then acks with `flush(event)`. Every flush persists in-flight +
  queued events, so only an ack removes an event from disk. `requeue(event)` returns
  an undeliverable event (wait aborted after wake) to the head; a waiter that throws
  gets its event put back at the head. Event `seq`s are minted by
  `Store.bumpCounter("eventSeq")` (persisted in `session.json`), not by the queue.
- **Why:** This is at-least-once delivery made literal — the dequeue→respond→ack
  crash window re-delivers instead of losing. A bare `flush()` that persisted only
  the queued tail let any interleaved enqueue's internal flush trim an unacked
  in-flight event from disk — losing it in exactly the window the contract protects
  (caught in M1e review). `requeue` covers the in-process abort-after-wake case
  without a heavier ack protocol. Seqs live in the session counters so they never
  reset when the queue file drains, keeping duplicates detectable.
- **Revisit when:** Consumers need exactly-once (seq-based dedupe stops being
  enough), or queue wiring wants the seq owned in one place.

## Long-poll ack and abort ride the Node response socket

- **Decision:** The events endpoint acks an event (`queue.flush(event)`) from the
  Node `ServerResponse`'s `"close"` listener when `writableFinished` is true and
  requeues it otherwise; a client dropping a *parked* poll is detected via
  `c.req.raw.signal` (accessing it materializes @hono/node-server's lazy
  AbortController, which aborts on premature close). Under `app.request()` in tests
  there is no socket, so the ack is immediate.
- **Why:** "Ack only after the response is written" needs a write-completion signal
  that Hono's fetch-shaped handlers don't expose. @hono/node-server passes the raw
  `ServerResponse` as `c.env.outgoing`, and its `"close"` event fires exactly once
  per response with `writableFinished` separating delivered from aborted (verified
  against the 1.19.x source; exercised by the e2e abort check). Hooking it makes
  at-least-once literal: a crash or client abort inside the dequeue→respond window
  re-delivers instead of losing the event.
- **Revisit when:** @hono/node-server changes its bindings or abort contract, or
  the daemon moves off Node's http server. One caveat baked into the code: that
  AbortController only aborts if it already existed when `"close"` fired, and a
  `"close"` listener added after the fact never runs — so the park and ack paths
  also check `outgoing.destroyed`/`outgoing.closed` up front instead of trusting
  the signal alone.

## Foreign-Origin requests are refused, not authenticated

- **Decision:** Non-GET `/api` requests carrying an `Origin` header whose host is
  not the daemon's own `Host` get a 403. No tokens, no auth.
- **Why:** Binding 127.0.0.1 does not stop a malicious webpage in the user's
  browser from delivering a `no-cors` POST to loopback (`/api/shutdown` needs no
  guessable id), and browser private-network blocking is not universal. Browsers
  always attach `Origin` to cross-origin POSTs; the CLI and curl never send one,
  and the M2 web UI is same-origin — so the header alone cleanly separates the
  one hostile caller class from every legitimate one.
- **Revisit when:** anything other than the CLI or the same-origin UI must POST
  (e.g. a packaged app with an `app://` origin), or remote access stops being
  Tailscale-shaped.

## One SessionQueue instance per session, for the daemon's lifetime

- **Decision:** The app keeps a lazy `Map<sessionId, SessionQueue>`; queues are
  never evicted or re-created per request.
- **Why:** Waiters park on an in-memory list, so every request must hit the same
  instance — and the constructor re-reads disk, so a per-request queue would
  resurrect delivered-but-unacked in-flight events as duplicates. Daemon-lifetime
  scope is the simplest correct choice at single-user session counts.
- **Revisit when:** `otacon clean` archives sessions while the daemon runs —
  eviction must then drain in-flight events first. *(Resolved in M5a the other way:
  clean accepts only approved sessions, where dropping undrained `approved` copies
  is safe — see "clean: daemon deregisters, CLI archives".)*

## Daemon spawn: health re-probe, not the boot line

- **Decision:** `ensureDaemon` spawns otacond fully detached with stdout/stderr
  appended to `$OTACON_HOME/daemon.log`, then polls `/api/health` while watching the
  child's exit code — it never reads the boot line. Child exit 0 before health means
  it lost the spawn race to another otacond (keep polling the winner); any other exit
  fails with a pointer at the log. A port answering HTTP as something other than
  otacond is refused before spawning (`E_PORT_CONFLICT`); a non-HTTP squatter is
  caught after the fact via the spawned daemon's own exit-1 refusal.
- **Why:** Reading the boot line means holding a pipe to a process that must outlive
  the CLI — close it too early and the line races, too late and the CLI hangs. The
  health probe is the same check every other caller already performs, and "the port
  is the lock" already makes exit-0-without-health a defined success path. The log
  file keeps the boot line inspectable for humans.
- **Revisit when:** Spawn failures need richer diagnostics than the log tail.

## CLI exit codes: 0 success, 1 actionable failure, 2 usage/internal

- **Decision:** Exit 0 covers every protocol-normal outcome including
  `{"event":"timeout"}`; exit 1 is an expected failure the agent can act on (lint
  reject, no/ambiguous/unknown session, port conflict, daemon won't start, daemon
  unreachable mid-command — `E_DAEMON_DOWN`); exit 2 is bad flags or an internal
  error. Always exactly one JSON line on stdout; notices on stderr.
- **Why:** Agents branch on exit codes before parsing: 1 means "fix your input or
  environment and retry", 2 means "you invoked the tool wrong or it is broken — stop
  and report". Timeout exits 0 because re-parking is the normal loop (DESIGN.md §6),
  not a failure.
- **Revisit when:** A consumer needs finer-grained codes than the JSON `error.code`
  already provides.

## Session resolution precedence: explicit, then the repo's lone active session

- **Decision:** `--session` always wins. Otherwise the CLI resolves against the daemon
  registry alone: the repo's single *active* (non-approved) session is assumed; zero
  refuses (`E_NO_SESSION`), two or more refuse with the candidate list attached
  (`E_AMBIGUOUS_SESSION`). There is no local `.otacon/current-session` pointer — an
  approved (ended) session is reachable only via explicit `--session`.
- **Why:** The never-guess rule (DESIGN.md §7) exists because cross-posting feedback to
  the wrong plan is unrecoverable confusion. The earlier repo-root pointer (last
  `otacon start` wins) silently sent a session's flagless commands to whichever session
  another agent `start`ed most recently in the *same* working tree — exactly that
  failure, and one the pointer's own staleness guards could not catch because the
  target was a valid active session. Dropping the pointer makes the registry the single
  source of truth: with one active session the common case stays flag-free, and any
  ambiguity refuses with the machine-readable list so the agent's very next call can
  pass `--session`. Approved sessions never count toward the lone-active default —
  a finished plan (§6) should never block starting the next one, and implicitly
  resubmitting to it would resurrect a closed plan. Separate worktrees keep parallel
  planning flag-free because each has its own git root.
- **Revisit when:** A single working tree needs multiple concurrent sessions resolved
  without flags (would require a per-terminal binding that env vars can't provide
  across an agent's Bash calls), or archived-but-active states appear.

## `wait` parks in ≤240-second slices under one fixed deadline

- **Decision:** The CLI computes its deadline once (`now + --timeout`), then loops:
  re-ensure the daemon, long-poll `?wait=min(remaining, 240)`, re-park on a daemon
  "timeout" body or a connection failure (after a 250ms backoff), until the deadline
  expires and it prints `{"event":"timeout"}` with exit 0. Per-request parks are
  capped at 240s even though the daemon accepts 600s.
- **Why:** Node's fetch (undici) kills any request whose response headers take more
  than 300s, and a parked long-poll sends headers only when an event (or the daemon
  timeout) fires — a single 540s park would die mid-request. Slicing costs one
  no-op HTTP round trip every 4 minutes; the daemon's disk-backed queue makes
  re-parking free, which is also exactly what makes a kill -9 mid-park invisible to
  the agent (the same loop just respawns and re-parks).
- **Revisit when:** The CLI adopts an HTTP client with configurable timeouts, or
  agents' Bash caps move and the slice math deserves retuning.

## Corrupt state files are quarantined, not fatal

- **Decision:** A corrupt `registry.json`, `session.json`, or `events.json` (unparseable
  or wrong shape) is atomically renamed to `<name>.corrupt-<timestamp>-<serial>`, logged
  to stderr, and the daemon continues with a fresh structure instead of throwing. The
  rebuilt session state recovers `revision` from the highest `r<N>.md` snapshot on disk
  (the snapshots are the actual plan history — restarting at r1 would overwrite them);
  counters restart at 0, so post-quarantine `b`/`t`/`q` ids and event seqs can repeat. A
  quarantined registry forgets its sessions (their `.otacon/` dirs survive for manual
  re-registration via a new `otacon start`).
- **Why:** The old throw-on-corrupt behavior wedged the daemon permanently — every boot
  (registry) or every touch of the session (state/events) re-threw forever, with no
  recovery path short of hand-editing files. Atomic writes already make corruption an
  exceptional, externally-caused event; preserving the bad file beats both losing it and
  refusing to run. Repeated ids are acceptable because at-least-once delivery already
  forces consumers to treat duplicates as a handled condition.
- **Revisit when:** Threads/resolutions (M3) make repeated thread ids actively harmful —
  then recover counters from a high-water scan of snapshots and the queue, too.
  *(Happened in M3a — see "Quarantine counter recovery high-water scans threads and
  events".)*

## Stale-daemon restart: bounded attempts, identity re-check before shutdown

- **Decision:** `ensureDaemon` runs at most 3 probe→shutdown→respawn cycles before
  failing `E_VERSION_MISMATCH`. `shutdownStaleDaemon` re-probes the daemon immediately
  before POSTing `/api/shutdown` and skips the kill if it is already the current version
  (or gone); the post-shutdown poll likewise accepts a current-version daemon appearing
  in the gap.
- **Why:** Peer CLIs race restarts. Without the pre-shutdown re-check, a CLI that probed
  a stale daemon could kill the healthy current daemon a peer spawned in the meantime
  (the probe→shutdown TOCTOU), dropping its parked waiters; the re-check shrinks that
  window to one round trip. Without the bound, two CLI versions sharing one port would
  ping-pong shutdown/respawn forever; three attempts absorbs transient races but turns a
  genuine version fight into an actionable error.
- **Revisit when:** `/api/shutdown` grows a conditional "only if you are version X"
  parameter, which would close the remaining race window entirely.

## UI live updates: in-process Notifier, snapshot-first SSE, no replay

- **Decision:** Daemon mutations publish `{type, session, data}` UiEvents through one
  EventEmitter-backed Notifier (`src/daemon/notify.ts`). Two SSE endpoints consume
  it — `GET /api/stream` (index, all sessions) and `GET /api/sessions/:id/stream`
  (filtered) — each opening with a `snapshot` frame, then `session` (full summary:
  registry entry + revision + pendingEvents), `revision` (`{session, revision}`),
  and `queue` (`{session, pending}`) frames, plus a `: hb` comment every 25s. No
  event ids, no Last-Event-ID resume.
- **Why:** One daemon process makes an in-process emitter the whole bus. Opening with
  the snapshot kills the subscribe-vs-fetch race and makes reconnects self-healing
  (EventSource retries on its own; the fresh snapshot re-syncs) — which is exactly
  what makes replay pointless at personal scale. The index is poll-free by
  subscription instead of polling `/api/sessions`. The heartbeat keeps
  Tailscale-serve/proxy idle timeouts from severing quiet streams.
- **Revisit when:** snapshots get heavy (many sessions × payload size), or a second
  consumer needs guaranteed replay rather than resync.

## Session accent color: FNV-1a of the id picks a hue

- **Decision:** accent hue = FNV-1a-32(session id) mod 360; the UI fixes
  saturation/lightness per color scheme (45%/34% light, 55%/62% dark) and derives
  every accent use from one `--hue` custom property set inline per session.
- **Why:** Deterministic on every device with zero stored state — the same session is
  always the same color on phone and desktop, which is the whole point of DESIGN.md
  §7's wrong-plan-feedback guard. FNV-1a is five lines and spreads short `otc_` ids
  well. Varying hue only keeps contrast in both schemes under control.
- **Revisit when:** two concurrently open sessions collide on hue often enough to
  annoy (then: golden-angle spacing by registry order, trading stability for spread).

## UI toolchain: Vite builds into dist/, React stays a devDependency

- **Decision:** `src/ui/` is a Vite root built by `vite build src/ui` into `dist/ui`;
  react/react-dom/vite/@vitejs/plugin-react are devDependencies; runtime deps stay
  hono + @hono/node-server. `src/ui/` has its own tsconfig (DOM libs, JSX, bundler
  resolution); `bun run typecheck` checks both projects. The SPA imports wire types
  type-only from `src/shared/types.ts`.
- **Why:** The shipped artifact is static bytes under `dist/` — `files: ["dist"]`
  already publishes it, `npm i -g otacon` pulls no UI or native deps, and the
  Node-runnable invariant is untouched. The type-only import keeps the SPA and the
  daemon from drifting on wire shapes without entangling their builds.
- **Revisit when:** the UI needs a dependency that must exist at runtime.

## Unread badge state lives in the browser, not the daemon

- **Decision:** The index unread badge compares each session's revision to a
  per-device localStorage map (`otacon.seenRevisions`), written when the session
  screen is opened. The daemon stores nothing about read state.
- **Why:** "What has this device shown me" is presentation state; the daemon's
  contract stays "single source of truth for plan state", and no API surface exists
  for something only the UI cares about. Cross-device unread sync is not worth daemon
  state for a single user.
- **Revisit when:** M3 revision banners need richer read tracking, or multi-device
  divergence actually bites.

## Playwright e2e drives the real daemon; specs are `*.e2e.ts`

- **Decision:** `bun run e2e:ui` builds, then @playwright/test boots
  `node dist/daemon/main.js` via its webServer (temp OTACON_HOME, port 4790,
  loopback NO_PROXY) and tests seed state through the real HTTP API. Specs live in
  `test/ui/*.e2e.ts`.
- **Why:** Testing the built artifact end-to-end matches the shell e2e suites and
  exercises the same socket paths (SSE, statics) real browsers hit. bun test
  auto-discovers `*.test.*` and `*.spec.*` anywhere, so the `.e2e.ts` suffix is what
  keeps the two runners' files disjoint in both directions.
- **Revisit when:** the suites need shared fixtures, or bun can run Playwright specs
  natively.

## M1 scope: CLI surface is `start`/`submit`/`wait`/`status` only

- **Decision:** M1 ships sessions, registry, submit + linter (L1/L2/L6), event queues,
  and status. `ask`/`answer`/`open`/`clean`/approve, diffs, SSE, and the web UI come in
  later milestones. Comment/question HTTP endpoints exist so curl can exercise queues.
- **Why:** The strict milestone reading keeps every change small and testable
  end-to-end via curl/CLI before any UI exists.
- **Revisit when:** M2+ planning starts (each milestone gets its own `.otacon/` plan).

## Review screen renders via a ported line grammar, not the linter parser

- **Decision:** The UI has its own plan parser (`src/ui/plan/parse.ts`) implementing
  the identical line grammar as the linter's (`src/daemon/linter/parse.ts` —
  headings, phase/field regexes, fences, the same slug and Details line-count
  algorithms) but building a render model that *keeps* content where the linter only
  measures it. It is deliberately tolerant: structure it does not recognize renders
  as plain markdown, never an error.
- **Why:** The linter's `ParsedPlan` carries line counts and verdict inputs, not
  bodies — rendering from it would mean growing the daemon a parallel content model
  plus an API for it, coupling the review screen's needs into submit-path code. The
  grammar itself is ~10 regexes; duplicating it is cheaper than the coupling, and the
  shapes that must never drift (section slugs, `phase-<n>`, the L6 line measure) are
  pinned by the e2e suite asserting UI badges against linter-recorded warnings.
  Tolerance is safe because every stored revision already passed lint at submit.
- **Revisit when:** The grammar changes twice in one milestone (then extract a shared
  grammar module), or the daemon grows a render-model endpoint for another consumer.

## Before/after pairs: fence info-string tags, adjacency required

- **Decision:** A before/after pair (DESIGN.md §4) is a fence whose info string is
  `<lang> before` immediately followed — same container, nothing but blank lines
  between — by one tagged `<lang> after`. Pairs render side-by-side ≥640px and
  stacked on phones; an unpaired `before`/`after` renders as an ordinary fence.
- **Why:** The info string is where fence metadata already lives, so the plan stays
  plain markdown that renders acceptably in any other viewer (GitHub shows two
  labeled code blocks — degraded, not broken). Adjacency keeps pairing deterministic
  with zero cross-references to resolve or lint. Falling back to a plain fence beats
  erroring because the linter has already accepted the revision.
- **Revisit when:** Plans need more than one pair semantic (e.g. N-way variants), or
  agents habitually emit non-adjacent pairs.

## Plan rendering deps: marked + DOMPurify + highlight.js, mermaid as a lazy chunk

- **Decision:** Plan prose renders through `marked` (GFM) with the output — and
  mermaid's SVG — sanitized by `DOMPurify` before touching the DOM. Code fences
  highlight with highlight.js's common-languages build. All four are
  devDependencies bundled into `dist/ui`; runtime deps stay hono +
  @hono/node-server. The whole renderer is a lazy route chunk (the index never
  loads it); mermaid is a further dynamic import fetched on the first diagram,
  initialized with `securityLevel: "strict"` and top-level `htmlLabels: false` —
  the flowchart-scoped option is ignored by mermaid 11's renderer, and HTML labels
  live in `foreignObject`s, which the DOMPurify SVG profile strips (labels would
  vanish). The prose pass additionally forbids `<form>`, `<style>`, and inline
  `style` (phishing-form and CSS-exfiltration surfaces the html profile leaves
  open); the SVG pass keeps `<style>` because mermaid inlines its theme CSS there
  and strict mode sanitizes diagram-author styles.
- **Why:** Prose *inside* sections is arbitrary markdown — this is where the
  hand-rolled-parser argument (DECISIONS.md "Plan parser") flips, because rendering
  full markdown correctly is exactly what an AST library is for. Sanitizing
  semi-trusted agent-written content is defense in depth for a surface that will be
  exposed over Tailscale (DESIGN.md §10-11). Mermaid is by far the heaviest dep
  (~1.5 MB of chunks), which lazy loading turns into a cost paid only on plans that
  actually contain diagrams.
- **Revisit when:** The published package would need any of these at runtime, or
  mermaid's sanitization story changes enough to drop the strict/htmlLabels posture.

## L6 warnings persist beside the revision; JSON read via Accept header

- **Decision:** `saveRevision` writes the lint warnings a revision was accepted with
  to `r<N>.warnings.json` next to `r<N>.md`. `GET /api/sessions/:id/revisions/:n`
  still returns raw markdown by default; `Accept: application/json` returns
  `{session, revision, markdown, warnings}`. A missing or corrupt warnings file
  reads as `[]` — no quarantine.
- **Why:** Warnings exist only in the submit response; the UI renders L6 badges on
  every later read, so they must be stored — re-linting at read time would let later
  budget tuning silently rewrite what the user was shown at review time. Content
  negotiation keeps the CLI/curl contract byte-identical instead of minting a second
  endpoint. Corruption degrades to `[]` because badges are presentation metadata;
  quarantine machinery exists for state the protocol cannot lose.
- **Revisit when:** Revisions need richer read-side metadata (diff stats, changelog)
  — then a real `?format=` or detail endpoint should subsume the Accept switch.

## Threads: one threads.json per session; answer is a question sub-resource

- **Decision:** Comment and question threads persist in `~/.otacon/sessions/<id>/threads.json`
  (append on post; the agent's answer is written inline on its question thread,
  re-answers overwrite). The agent answers via
  `POST /api/sessions/:id/questions/:qid/answer`; non-question ids 404 with
  `E_UNKNOWN_QUESTION`. The UI reads threads from the per-session SSE snapshot and
  applies `thread` frames as upserts; `GET /threads` exists for the CLI/curl surface.
- **Why:** The event queue drains on delivery, so it cannot back the rail — threads
  need their own durable file, and one whole-file JSON matches the storage posture
  (atomic writes, quarantine-not-fatal) at single-user volumes. The endpoint is a
  sub-resource because §6's `POST /:id/answers` is already reserved for the *user*
  answering an *agent* question (M4) — overloading one route with both directions
  invites cross-posting bugs. Overwrite-on-re-answer because at-least-once delivery
  means a duplicate `answer` call is legitimate, and the newer text wins. Snapshot
  threads ride the stream for the same no-fetch-race argument as snapshot-first
  itself.
- **Revisit when:** M3 resolutions need per-thread state transitions (then threads
  likely want ids beyond t/q and a real update API), or thread counts make
  whole-file rewrites notable. *(Resolved in M3a without new ids or an update API:
  resolution and anchor-state transitions ride the submit path —
  `applyRevisionToThreads` — and SSE `thread` upserts carry them out.)*

## Review-loop drafts live in the browser, not the daemon

- **Decision:** Pending drawer comments (and the composer's text) are React state —
  nothing is persisted until the user sends; a reload drops unsent drafts.
- **Why:** The drawer is presentation state, like the unread badges: the daemon's
  contract stays "source of truth for *sent* feedback", and a draft API would add
  server state for something only one screen cares about. Batches are short-lived
  by design (§9) — the loss window is minutes, not sessions.
- **Revisit when:** Real use shows drafts dying to accidental reloads (then:
  localStorage, still never the daemon).

## Selection anchors capture Range context; flashing uses CSS highlights

- **Decision:** The anchor's prefix/suffix are 32 chars of Range-measured text
  between the selection and its enclosing slug-ID section. Click-to-flash
  re-locates the quote (prefix-disambiguated) over the section's text nodes and
  paints it with the CSS Custom Highlight API plus a section-level wash class;
  browsers without the API just get the wash.
- **Why:** Ranges measure exactly what the user saw, and `closest("section[id]")`
  makes the innermost slug (phase over section) the anchor for free. Highlights
  paint without mutating the DOM — wrapping quotes in `<mark>`s would fight React's
  reconciliation over nodes it owns. A quote spanning block boundaries fails to
  re-locate (toString() synthesizes newlines) and degrades to the section wash;
  M3's orphan tray is the real answer for moved/edited quotes.
- **Revisit when:** Re-anchoring across revisions lands in M3 (fuzzy matching will
  want a real algorithm, e.g. diff-match-patch-style), or Safari/Firefox support
  data changes the fallback calculus.

## The plan renderer is memo'd: a re-render rewrites the DOM and kills selections

- **Decision:** `PlanView` (the lazy chunk's root) and `Markdown` are wrapped in
  `React.memo`, so review-loop state churn (selection tracking, drawer edits) never
  re-renders the dossier; only a new revision payload does.
- **Why:** React re-applies `dangerouslySetInnerHTML` whenever the owning component
  re-renders — the `{__html}` wrapper object is new each time — which rebuilds every
  text node, collapses the user's selection mid-anchoring, and re-renders mermaid
  SVGs. memo is correct here because the props are a string and the revision
  payload's stable arrays, so shallow comparison is exact.
- **Revisit when:** React's host-prop diffing compares `__html` by value (making the
  memo a pure perf optimization), or the renderer gains props that defeat shallow
  equality. *(Hardened post-review: every `dangerouslySetInnerHTML` site now also
  `useMemo`s its `{__html}` wrapper, so innerHTML survives re-renders even if a
  future parent breaks prop identity — memo is the perf layer, the stable wrapper
  the correctness layer.)*

## Selection toolbar suppressed over renderer chrome

- **Decision:** `captureSelection` rejects any selection whose range intersects
  renderer chrome — mermaid SVG, fence captions, `#slug` anchors, phase numbers,
  Details summaries, the diagram-pending notice — so the toolbar (and the `c`/`q`
  shortcuts) simply do not offer to anchor there. Suppress, not degrade.
- **Why:** Chrome text exists only in the rendered DOM, never in the plan markdown
  the agent reads: an `exact` captured from it can never be grepped in the source
  nor re-located by `findExactRange`, so the "anchored" comment would silently
  behave as whole-plan. A toolbar that won't appear is honest; an anchor that
  quietly stops meaning anything is not. Prefix/suffix may still absorb adjacent
  chrome text — capture and re-locate concatenate the same text nodes, so the UI
  stays self-consistent, and the agent treats context as a hint, not a contract.
- **Revisit when:** plans grow selectable generated surfaces users legitimately
  want to discuss (e.g. diagram nodes) — that calls for a different anchor type,
  not a looser guard.

## Review screen: reading surface only until the verbs exist

- **Decision:** The M2-era review screen renders the dossier — header, sections,
  phases, Details, badges — with no Approve/Diff/Changelog controls and no threads
  rail; those appear only when their flows land (comments M2c, diffs/approve M3+).
  Section and phase elements already carry their slug DOM ids (`#decisions`,
  `#phase-2`), quietly surfaced on hover, so the M2c anchoring contract is in the
  DOM from day one.
- **Why:** Disabled chrome trains the user to ignore chrome, and a dead Approve
  button on a review surface is actively dangerous. Shipping the ids early means
  comment anchoring (DESIGN.md §4) attaches to a stable contract rather than
  retrofitting one.
- **Revisit when:** M2c lands the comment flow (drawer + selection toolbar mount
  around the dossier). *(Happened: M2c shipped the toolbar, drawer, and threads
  rail. The principle stands for what remains — no Approve/Diff/Changelog chrome
  until M3+ gives those verbs life.)*

## Resolutions file: one revision-accompaniment document

- **Decision:** `resolutions.json` (and the `resolutions` field of the submit JSON)
  is `{"changelog": string, "threads": {"t<n>": "reply"}}` — both the thread replies
  and the revision changelog ride one document. The daemon validates the shape
  strictly (unknown top-level keys, non-string replies → 400 before linting).
- **Why:** DESIGN.md §6 had it underspecified ("thread → reply"). The changelog and
  the resolutions are both "what this revision did about the feedback" — one file
  the agent writes per revision beats a CLI flag holding multi-line shell-quoted
  prose. Strict shape validation because a typo'd key (`thread` for `threads`)
  would otherwise silently drop every resolution and bounce the agent off a
  confusing L5 error instead of the real mistake.
- **Revisit when:** Resolutions need per-thread structure beyond a reply string
  (e.g. disposition: accepted/rejected), or a second accompaniment field appears.

## Reviewer-driven resolution: agent replies = response, reviewer Resolve = close

- **Decision:** A thread closes only when the **reviewer** acts. The agent's reply
  (landed on resubmit, lint L5) is a *response* and is stored as `reply: {body,
  revision, repliedAt}` on the comment; it does NOT close the thread. The reviewer
  closes via a dedicated **Resolve** verb (`POST .../threads/:tid/resolve {resolved}`),
  which stamps `resolved: {revision, at}` on the conversation root (comment or
  question) — `{resolved:false}` reopens. Resolve doubles as **withdraw**: resolving a
  comment with no reply tells the agent the comment is dropped, and L5 skips any
  reviewer-resolved comment so an un-answerable thread never deadlocks a submit. The
  rail's lit mark, the Approve unresolved count, and the comment & approve sweep all key
  on `resolved`, not on `reply`. (Replaces the M3 field shape `resolution: {body,
  revision, resolvedAt}`, which conflated "agent answered" with "thread closed"; a
  pre-Phase-2 in-flight session's `resolution` is read-normalized to `reply` so it is
  never quarantined.)
- **Why:** Conflating reply with close gave the *agent* the power to dismiss feedback
  the human never accepted — a reply auto-cleared the mark and dropped the thread from
  the approve count, so a hand-wavy "done" looked identical to an accepted fix. Putting
  the close on the reviewer keeps the human as the gate: the thread stays lit and
  counted until they actively Resolve. Folding withdraw into the same verb (rather than
  a separate `otacon`-side or reviewer-side "withdraw") means one button does both
  "I accept your reply" and "never mind" — the only two ways a reviewer ends a comment —
  and gives L5 a clean skip predicate (`replied || resolved`) instead of a special
  withdraw state. The close carries the session's current revision so the ✓ card and
  Review notes stay auditable.
- **Revisit when:** Comments become multi-turn conversations (Phase 3) — "the agent
  replied" stops being a single bit and Resolve has to reason about whose turn it is;
  or reviewers want a disposition on the close (accepted vs won't-fix).

## L5 scope: a reply for every un-replied, un-resolved comment thread at submit time

- **Decision:** L5 requires a reply for every comment thread that has neither a stored
  reply NOR a reviewer `resolved` close when the submit arrives — not just the latest
  batch. A reviewer-resolved comment is skipped (that is the withdraw path). Unknown
  thread ids and question ids in `threads` are errors (questions are answered via
  `otacon answer`, never replied); blank replies are errors; re-replying to an
  already-replied thread is allowed and overwrites.
- **Why:** Under normal operation "every open thread" is the self-healing scope — each
  submit must carry the agent's response to everything still owed one, so after a
  quarantine, a crash between writes, or a hand-edited threads.json, stray open threads
  block the next submit instead of silently rotting (DESIGN.md §9). Skipping
  reviewer-resolved threads is what makes the **Resolve = withdraw** path safe: a
  comment the agent cannot or should not answer (the reviewer dropped it) would
  otherwise deadlock every submit. Overwrite-on-re-reply mirrors answerQuestion:
  at-least-once delivery makes duplicate submits legitimate. (This is the
  long-standing "withdraw verb" this entry once flagged as a revisit-when — Resolve
  *is* that verb; see "Reviewer-driven resolution" above.)
- **Revisit when:** Comment threads grow multi-turn conversations (Phase 3) — L5 would
  then need to reason about whose turn it is, not just "has a reply".

## Changelog requirement is a lint error, not a 4xx

- **Decision:** A missing/blank changelog on revisions ≥ 2 is `E_CHANGELOG_MISSING`,
  severity error, rule L5, in the 422 lint payload. r1 needs none. The daemon
  composes L5's context (open threads from threads.json, the submitted replies,
  the next revision number) and passes it to the pure `checkL5(ctx)` rule; the
  linter itself never touches disk.
- **Why:** The agent already has exactly one fix-and-resubmit loop — the 422 with
  machine-readable issues (DESIGN.md §5). A second rejection channel (400) for
  what is semantically the same class of problem ("your submission is incomplete")
  would force every wrapper to handle two shapes. 400 stays reserved for
  *malformed* bodies. The context-arg seam keeps the linter pure and the rule unit-
  testable without a store.
- **Revisit when:** L5 needs data the daemon cannot cheaply compose ahead of the
  lint call.

## Diff engine: hand-rolled LCS over slug-segmented plan units

- **Decision:** `GET /diff` segments both revisions into the slugs the UI renders
  (summary, decisions, phases preamble, phase-<n>, risks, open-questions — reusing
  the linter's pure parser), excludes frontmatter, and runs a hand-rolled
  common-affix-trimmed LCS line diff per unit, grouped into unified-style hunks
  (3 context lines). Response: `{sections: [{id, title, status, hunks}]}`, statuses
  added/removed/changed/unchanged; unchanged units carry no hunks, added/removed
  carry their whole body. No diff dependency.
- **Why:** The gutter markers (DESIGN.md §9-10) need per-unit verdicts, which a
  whole-document diff cannot give without re-deriving section boundaries the parser
  already computes; per-unit diffing also makes moved-section noise impossible to
  bleed across units. Plan units are budget-bounded small (§5), so quadratic LCS is
  microseconds and a Myers implementation or a dependency buys nothing. Frontmatter
  is excluded because the daemon-owned revision counter changes every submit —
  every diff would open with a guaranteed-noise hunk.
- **Revisit when:** Plans grow units big enough that LCS DP tables matter, or the
  UI needs intra-line (word-level) diffs.

## Re-anchoring ladder: raw match → context-scored → normalized; unique or orphaned

- **Decision:** On every accepted revision the daemon re-locates every thread's
  anchor (resolved ones included; whole-plan anchors skip). Quoted anchors walk:
  (1) raw `exact` occurrences anywhere in the plan; (2) if several, the candidate
  with the strictly best prefix/suffix context score, else a single candidate in
  the original section; (3) if none, the same search over normalized text
  (whitespace runs collapsed, `*` `` ` `` `_` stripped) — a unique normalized match
  rewrites the anchor to the new revision's raw span and regenerates context.
  Anything still missing or ambiguous sets `anchorState: "orphaned"` (the thread
  and its original anchor are kept verbatim); a later revision that restores the
  text un-orphans it. Section-only anchors just require the slug to exist.
- **Why:** Quotes are captured from *rendered* text but matched against markdown
  source — emphasis markers and reflowed whitespace are the two systematic
  mismatches, which is exactly what the normalization forgives; anything beyond
  that (edited words, case changes) means the text the user discussed is gone, and
  §4 says that must surface in the tray, never be guessed at. Ambiguity orphans
  because a wrong anchor silently misdirects review — strictly worse than an honest
  "lost it". Resolved threads re-anchor too so the rail's click-to-flash keeps
  working on old conversation.
- **Revisit when:** Real plans show systematic mismatches the ladder misses (e.g.
  link syntax `[text](url)`), or orphan rates suggest the context scorer needs to
  become a real similarity metric (diff-match-patch style).

## `anchorState:"orphaned"` is an internal-only marker — no UI tray, inline & muted

- **Decision:** `anchorState:"orphaned"` stays the daemon's persisted marker for a
  thread whose quote re-anchoring lost, but the rail no longer surfaces it as its
  own concept. There is no orphan tray, no badge, no toggle, and the word
  "orphaned" appears nowhere user-facing. A detached thread (and its whole
  conversation chain) renders **inline in the same newest-first list** as every
  other thread; its quote shows muted — not clickable, not jumpable, never lit —
  beside a subtle ⌀ icon whose `title` tooltip explains the quote changed in a
  later revision (no revision number, no ⚠).
- **Why:** The tray made a recoverable, transient state (a later revision restoring
  the text un-detaches it automatically) look like an error the reviewer must act
  on, splitting one conversation's context across two places. Keeping the thread
  inline preserves chronology and the agent's reply in situ; muting the quote and a
  tooltip are enough to signal "this text moved on" without alarming chrome. The
  marker stays internal so the daemon, the anchoring ladder, and the lit-mark
  filter (which already skips it) are untouched — this is a pure presentation
  change.
- **Revisit when:** Reviewers miss detached threads in a long list (then: a quiet
  in-list affordance like a filter or jump-to-next, still not a separate tray), or
  the muted-quote treatment proves too subtle to notice.

## lastReviewedRevision is daemon state, set implicitly and explicitly, monotonic

- **Decision:** `session.json` carries `lastReviewedRevision` (0 = never). It moves
  on a comment-batch flush (to the revision being commented on) and on
  `POST /:id/reviewed` (UI mark-reviewed/banner-dismiss; defaults to latest); it
  only ever increases, clamped to the current revision. It is the diff endpoint's
  default `from`; `?from=` overrides per request without touching the stored value.
  Pre-M3 session.json files missing the key read as 0 instead of quarantining.
- **Why:** Unlike the index's unread badges (browser localStorage, presentation
  state), the diff baseline is protocol state: §9's "diff vs what you last actually
  reviewed" must mean the same thing on the phone and the desktop, so the daemon
  owns it. Monotonic because "reviewed" is knowledge, not a cursor — looking
  backwards is a per-request baseline choice, not an un-knowing. Commenting implies
  reviewing (§9: comments are revision requests on what was read).
- **Revisit when:** Multi-reader sessions appear (per-device baselines), or
  marking individual sections reviewed becomes a thing.

## Re-review chrome is derived server state; banner from r2, markers need a baseline

- **Decision:** The new-revision banner renders while
  `lastReviewedRevision < revision` **and** `revision ≥ 2`; Dismiss just POSTs
  `/reviewed` and the answering session SSE frame unmounts it — no client-side
  "dismissed" flag exists. Gutter markers and the changed tally render only when
  the diff baseline is ≥ r1.
- **Why:** Deriving visibility from the summary makes the banner identical across
  devices and reloads for free, and dismiss idempotent — unlike the index unread
  badge (per-device presentation state), the diff baseline is §9 protocol state, so
  the daemon's value is the only truth worth rendering. r1 and the never-reviewed
  case are first reviews, not re-reviews: r1 carries no changelog to show, and with
  a baseline of 0 every section is "new", so marking them all carries zero signal.
- **Revisit when:** Multi-reader sessions want per-device banners, or agents stack
  several unreviewed revisions (the banner may then need a changelog list, not the
  latest one).

## Diff mode: unchanged units collapse to calm rails; anchoring stays clean-view-only

- **Decision:** In diff mode, unchanged sections render as a dimmed status-tagged
  rail with no body; changed/added/removed ones render their server hunks (mono op
  gutter, add/del washes). Diff units reuse the real slug ids — only one view is
  ever mounted — so j/k jumps and thread click-to-flash work in both views from one
  implementation. The selection bar and the c/q shortcuts are disabled in diff
  mode.
- **Why:** The diff exists to audit change; re-rendering full prose for unchanged
  sections buries the hunks under exactly the content the user already reviewed,
  and the clean reading is one toggle away. Selections over hunk lines would
  capture del-text and op glyphs that do not exist in the current plan source — an
  anchor that could never survive, the same honesty rule as the renderer-chrome
  guard.
- **Revisit when:** Users want to comment from the diff view (then: map hunk
  to-lines back to plan source for a real anchor), or unchanged units need
  expand-in-place.

## Diff baseline picker is per-screen view state; markers follow it

- **Decision:** The picker defaults to last-reviewed, and a pick overrides it for
  this screen only — React state, never persisted, never POSTs `/reviewed`. The
  clean view's gutter markers track the same pick.
- **Why:** §9 calls looking backwards "a per-request baseline choice, not an
  un-knowing" — persisting a pick would quietly redefine what *reviewed* means. One
  baseline driving both views keeps the marker count and the hunk set the same
  story; two baselines would let the markers contradict the diff.
- **Revisit when:** Cross-device baseline pinning becomes a real want.

## Quarantine counter recovery high-water scans threads and events

- **Decision:** When session.json is rebuilt after quarantine (or deletion), the
  b/t/q/eventSeq counters recover from a loose scan of threads.json (thread ids,
  batch ids) and events.json (seqs, payload batch/thread/question ids) instead of
  restarting at 0. The scan is deliberately unvalidating — a half-corrupt file
  still surrenders every id it can parse. `lastReviewedRevision` restarts at 0.
- **Why:** The M2c handoff flagged it: once threads carry resolutions, a re-minted
  `t1` would cross-wire a new comment with an old thread's resolution state —
  duplicates stopped being "a shrug" the moment threads got state. Events are
  scanned too because threads.json itself may be the casualty being recovered
  around. The reviewed pointer merely degrades the default diff baseline, which
  the user can re-select in one tap — not worth a recovery source.
- **Revisit when:** Any new id-bearing state file appears (add it to the scan).
  *(Happened in M4a: transcript.json joined the scan when grill questions started
  minting q ids.)*

## Grill transcript: its own transcript.json; q ids shared with user questions

- **Decision:** Agent grill questions persist in `~/.otacon/sessions/<id>/transcript.json`
  (`{version, entries: [{id, question, options?, recommend?, multi?, askedAt,
  answer?}]}`), not in threads.json — same atomic-write/quarantine posture, the
  user's answer is written inline on its entry, re-answers overwrite and re-queue
  the answer event. Agent-question ids come from the same `question` counter as
  user-question threads (one `q<n>` space); the counter-recovery scan reads the
  transcript too.
- **Why:** The transcript and the threads rail are different surfaces with
  different lifecycles — the transcript ships inside the approved artifact while
  threads stay gitignored review exhaust — so sharing a file would entangle the
  artifact's contents with comment-resolution state. One q id space because L3
  citations and the UI's decision deep-links must be unambiguous: with two `q7`s,
  `D3 ← q7` could point at either. Overwrite-on-re-answer mirrors answerQuestion:
  at-least-once delivery makes duplicate POSTs legitimate, newest wins.
- **Revisit when:** Transcript entries need threading (follow-up questions), or a
  UI wants to render questions and threads in one merged timeline.

## L3 rides the L5 context seam; stable codes, severity flips on --quick

- **Decision:** `checkL3(plan, ctx)` is pure; the daemon composes
  `{quick, knownQuestions}` (session registry flag + transcript q ids) at submit.
  Without the context (unit callers) L3 does not run. Both checks — an untraced
  `- D<n>:` entry (`E_DECISION_UNTRACED`) and a citation of a q id missing from
  the transcript (`E_UNKNOWN_QUESTION_CITED`) — keep their codes in `--quick`
  sessions and flip severity to warning. Citations accept `← q7`, `← q7, q9`,
  and the ASCII `<-` arrow; `[assumed]` anywhere in the entry satisfies the rule;
  non-`D<n>` list items in Decisions are ignored.
- **Why:** Same argument as L5: the linter never touches disk, and the daemon
  already owns both inputs (registry, transcript). Severity-not-code is the
  contextual dimension because agents and the UI key behavior off `severity`
  while dashboards aggregate by `code` — a `W_`-prefixed twin code would make
  every consumer match two names for one rule. `<-` is accepted for the same
  reason the phase grammar accepts both dashes: models emit both, and a lint
  bounce over an arrow glyph is pure friction. Unknown citations are errors
  because a fabricated `← q9` would otherwise game traceability invisibly.
- **Revisit when:** Decisions want richer provenance (multiple sources, comment
  citations), or quick-mode warnings prove too quiet to keep plans honest.

## Approve: unresolved = comments the reviewer hasn't Resolved + asks with neither answer nor Resolve; force bypasses

- **Decision:** POST /approve counts every conversation root the reviewer has not
  `resolved`, then: a **comment** always counts (a landed agent reply is a response,
  not a close — only the reviewer's Resolve clears it), a **question** counts only
  when its turn has no answer. A reviewer-resolved root (comment or question) is never
  counted — Resolve doubles as the close/withdraw, so a responded-but-unresolved
  comment STILL warns while an unanswered-but-resolved ask does NOT. A non-zero count
  answers 409 `E_UNRESOLVED_THREADS` with `unresolved: n` unless the body is exactly
  `{"force": true}` — the UI warns with the count and retries with force on confirm.
  A session with no revisions answers 409 `E_NO_REVISION`. The artifact is written
  before the status flips (write, flip, enqueue `approved`) so a crash can leave an
  orphan file but never an approved session without its artifact. After the flip,
  submit/comments/questions/question-answers/ask/answers/resolve/approve all answer
  409 `E_SESSION_OVER` — the daemon enforces the terminal state, not just the CLI's
  pointer rules.
- **Why:** §9 says Approve *warns* on threads the reviewer hasn't closed — a hard
  refusal would make the daemon override the human's judgment, and silence would make
  dangling feedback invisible; 409-unless-force encodes "warn then allow" in one round
  trip and leaves the count machine-readable for the confirm sheet. The count keys on
  the reviewer's Resolve, not on the agent's reply, because closing a thread is the
  reviewer's call — auto-clearing on a reply would let the agent dismiss feedback the
  human never accepted. A reviewer can Resolve an open ask to clear it without waiting
  for an answer, which is why Resolve (not just `answer`) suppresses a question.
  Daemon-side enforcement exists because curl/UI/--session callers never pass the CLI's
  pointer guard.
- **Revisit when:** Approve wants per-thread acknowledgment finer than one
  resolved/open bit, or a bulk "Resolve all" affordance.

## Comment & approve: a deferred-finalize hop, not a relabeled approve button

- **Decision:** When the reviewer approves with open comments, the warn stage
  offers a third path beside *commit anyway* (force-drop): **Send to agent**
  (`approve {sendOpenComments:true}`). It does NOT finalize — it flips the session
  to a new non-terminal status `finalizing`, arms a `pendingApproval` flag on
  session.json (carrying the Commit-Plan-vs-Implement choice and the swept comment
  thread ids), and queues a `comments` event marked `final:true` carrying every
  still-open comment thread. The agent folds them in; the daemon detects
  `pendingApproval` on its next clean `submit` and finalizes then — composing the
  artifact (with a `## Review notes` section built from the swept threads' now-
  landed replies), flipping to `approved`/`implementing`, and queuing the
  `approved` event — instead of returning to `in_review`. The mechanism **reuses
  the comments→revise→submit loop**: no new agent verb, and L5 already forces every
  swept comment to carry a reply before the finalize submit can pass. Only
  comment threads still **owed a response** are swept (the foldable kind: no reply
  yet and not reviewer-resolved); open questions are not (answered via `otacon
  answer`, never folded in — they still drop on approve as before). The
  E_UNRESOLVED_THREADS 409 gains an `openComments` count so the UI offers *Send to
  agent* only when there is something to fold in.
- **Why:** Leaving a final nit shouldn't cost a full comment→revise→re-review→
  approve round trip — the reviewer is done the instant they click. A deferred hop
  reuses the entire revise loop (linter, resolutions, re-anchoring, SSE) rather
  than inventing a parallel finalize path, so the fold-in is schema-linted (the
  agent cannot smuggle new scope into a plan the reviewer already left) and
  auditable (the `## Review notes` git trail is the only check on an unreviewed
  fold-in). Storing `pendingApproval` on session.json (not the registry) keeps it
  daemon-owned detail like the counters, and persists the choice across a daemon
  restart. `finalizing` is non-terminal for the same reason `implementing` is: the
  agent's submit must still mutate. A hung fold-in is escapable — `approve
  {force:true}` mid-finalize commits the current revision and force-drops the
  open threads (honoring the variant the reviewer originally chose). The
  double-finalize race serializes on the same guards as double-approve: an
  `approved` finalize is terminal (the loser hits `E_SESSION_OVER`), and an
  `implementing` finalize is caught by a new `submit`-during-`implementing` refusal
  (`E_ALREADY_IMPLEMENTING` — submit was never in the implementing verb set).
  A `finalizing` session also refuses new **comments** (`E_ALREADY_FINALIZING`):
  the comments route otherwise flips status back to `revising` while leaving
  `pendingApproval` armed (so a later clean submit silently finalizes the plan the
  reviewer thought they had reopened) and mints a thread outside `pendingApproval.
  threads` that L5 then demands the agent resolve though it was never handed it —
  wedging the fold-in. Locking the window to the agent's solo pass is simpler and
  truer to "the reviewer is done the instant they click" than queuing the comment
  for after the finalize or re-disarming on every reopen.
- **Revisit when:** Open questions need folding in too (a "send questions to agent"
  needs the agent to answer-then-finalize, which the current submit hop doesn't
  model), or a hung-finalize timeout should auto-fall-back to drop without the
  manual escape.

## Approve archives logically; the artifact appends an "## Interview" section

> **Superseded** by "Home plan store + Save vs Implement; otacon never commits" and
> "Session working state lives in the home store `~/.otacon/sessions/<id>/`":
> the artifact now lands in `~/.otacon/sessions/<id>/` (canonical, alongside the
> session's working state) plus, on Save, a project copy under `plans.dir`; otacon no
> longer writes `docs/plans/` or commits. The home copy is no longer a permanent
> archive: deleting the session (UI or `otacon clean`) removes the whole home folder
> (see "Delete permanently removes the home session folder; no archive"). The
> "## Interview" append and the collision-suffix naming still hold.

- **Decision:** Approve writes `docs/plans/YYYY-MM-DD-<slug>.md` (local approve
  date; slug from the session title, `plan` fallback; name collisions suffix
  `-2`, `-3`, … rather than overwrite) containing the final revision with
  frontmatter `status`/`revision` rewritten by the daemon and the transcript
  appended as `## Interview` (`### q<n> — question`, an `- Options:` line with
  `(recommended)`/`(multi)` tags, an `- Answer:` line; `_unanswered_` for open
  questions; omitted entirely on an empty transcript). `.otacon/<id>/` stays on
  disk untouched; physical archival is `otacon clean`'s job (M5).
- **Why:** The daemon owns frontmatter truth (DECISIONS "Frontmatter authority"),
  so the committed file must carry its values, not the agent's last guess. The
  Interview lives outside the closed schema because the artifact is post-lint
  output for humans and `snake`, never resubmitted — extending the schema for it
  would weaken L1's anti-smuggling closure. Logical-only archival because the
  approved event still has to drain through the session's queue file, and
  `E_SESSION_OVER`/registry status already remove the session from every active
  surface; moving directories under a live queue would be a race for zero gain.
- **Revisit when:** `snake` needs structured (non-markdown) access to the interview.
  *(The physical move landed in M5a — see "clean: daemon deregisters, CLI archives".)*

## "questions pending" is derived from openQuestions, never a stored status

- **Decision:** Session summaries carry `openQuestions` (transcript entries
  without an answer, counted at read time); the UI chip shows "questions
  pending" whenever it is non-zero on a non-approved session, outranking the
  stored status. Every transcript change (ask, answer) publishes a `session`
  frame so the count stays live on the index and the review header.
- **Why:** §10 lists the chip but the status machine (§12) has no such state —
  an open question is the user's move regardless of whether the agent is
  drafting or revising underneath, and deriving it means it can never go stale
  or contradict the registry the way a fifth stored status could. Riding
  `session` frames (not a new frame type) keeps the index's existing listener
  the only consumer.
- **Revisit when:** Summaries grow more derived counts (unread threads?) and
  recomputing the transcript on every summary read shows up in profiles.

## Grill cards: one-tap single answers; settled cards persist per mount only

> Superseded 2026-06-23 by "The Interview panel is the single grill surface; the
> pinned queue is removed". The one-tap-single-answer rule still holds (it lives
> in `AnswerForm`); the pinned card queue and the per-mount "settle in place"
> persistence are gone.

- **Decision:** On a single-choice card the chip tap IS the answer — no arm/
  confirm step; multi-select and free text arm an explicit send. An answered
  card settles in place (green-checked, answer echoed) rather than vanishing,
  but only for questions this mount watched while open; on reload, answered
  entries render solely in the Interview panel. An optional note rides any
  chip answer as `text`.
- **Why:** §8 says grilling happens one-thumbed while walking — a confirm step
  on the 90% path (tap the recommended chip) doubles every interaction for no
  information, while the settle-in-place flip is the answer's only visible
  confirmation (the POST has no UI of its own). Settled cards expire with the
  mount because the queue is an action surface, not an archive: re-rendering
  every answered question above the plan forever would bury the open ones the
  card queue exists to surface.
- **Revisit when:** Re-answering from the card (not just the API) is wanted, or
  the agent asks faster than one-at-a-time and the queue needs grouping.

## Decision citations: pre-render text transform, delegated clicks, ephemeral path

- **Decision:** `← q<n>` citations (and `[assumed]`) become deep-link/veto
  chrome via a text transform on the Decisions section's markdown before the
  sanitized render — the injected markup carries only `\d+`-derived ids, and
  the click is handled by one delegated listener on the plan container that
  ignores ids missing from the transcript. The approve response's artifact
  path lives only in the tab that approved; after a reload the approved notice
  names the destination folder, not the file.
- **Why:** A renderer plugin or per-link React callback would thread props into
  the memo'd PlanView and rebuild the DOM mid-selection (DECISIONS "The plan
  renderer is memo'd"); the transform keeps PlanView pure and the listener
  survives re-renders. Mirroring L3's citation grammar means the UI and linter
  can never disagree about what a citation is. The path is not persisted on
  the summary because the artifact is committed into the user's repo — the
  repo is the durable record, and a daemon-side copy would be a second source
  of truth that goes stale the moment the file is moved or renamed.
- **Revisit when:** Citations want hover previews (the transform would need
  real components), or sessions list their artifact post-approve (M5 `clean`).

## Wrappers are managed files: overwrite wholesale, marked

- **Decision:** `otacon install` owns wrapper content. SKILL.md files are rewritten
  byte-for-byte on every install and carry a visible ``managed by `otacon install` ``
  marker (Codex's SKILL.md included — see "Codex moves to a `.codex/skills/` SKILL.md
  folder"). User edits inside managed content are not preserved.
- **Why:** The wrapper is product behavior — it must track the CLI version exactly
  (`npm update -g` then reinstall, §16), and a three-way merge with user edits would
  fork the protocol invisibly: an agent following last month's card against this
  month's linter is a support nightmare. The marker makes the policy legible at the
  point of temptation.
- **Revisit when:** Wrapper customization becomes a real need (then: a user-content
  slot outside the managed region, never merge).

## Wrapper destinations: a SKILL.md skill folder per agent

- **Decision:** Claude Code `~/.claude/skills/otacon/SKILL.md` + the hook script
  `~/.claude/hooks/otacon-stop.sh`; Codex `$CODEX_HOME/skills/otacon/SKILL.md`
  (default `~/.codex/`); OpenCode `$XDG_CONFIG_HOME/opencode/skills/otacon/SKILL.md`.
  All three are the same SKILL.md skill folder, fully implemented; one protocol card is
  the single source for all of them.
- **Why:** Verified conventions (June 2026): all three agents now read the
  cross-agent SKILL.md skill convention from their own skills dir, so a uniform skill
  folder is the honest integration for each (Codex's move off `~/.codex/AGENTS.md` is
  recorded separately below). OpenCode also reads `~/.claude/skills/`, so the Claude
  install alone would work — the dedicated copy exists so installing/uninstalling one
  agent never silently depends on another's files. One card for all three because the
  protocol is agent-agnostic by construction (§13: "can run shell commands + can edit
  files").
- **Revisit when:** The agents' skill conventions drift apart enough that one card
  stops fitting all.

## Stop hook: plain sh, block-decision JSON, fail-open, stop_hook_active ignored

- **Decision:** The hook is POSIX sh: cwd parsed from the stdin JSON with sed ($PWD
  fallback), repo root via `git rev-parse` canonicalized with `pwd -P`, then the open
  session is found by fetching `GET /api/sessions` and selecting (in sh) the first
  non-approved entry whose `repo` equals that root — the compact registry array is
  split one object per line on `},{`, filtered with `grep`, the id read with `sed`. An
  open session emits `{"decision":"block","reason":…}` on exit 0, everything else exits
  0 silently. Any failure — daemon down, curl absent, no match — allows the stop.
  `stop_hook_active` is deliberately not consulted.
- **Why:** Exit-0-plus-JSON is Claude Code's documented decision channel and routes
  the reason to the model cleanly (exit 2 ignores stdout and dumps stderr). Fail-open
  is non-negotiable: a guard that can trap an agent in an unstoppable session when
  the daemon dies is worse than no guard. Ignoring `stop_hook_active` is the point of
  §13 — the block should hold exactly as long as the session is open; it terminates
  deterministically because approve flips the status the very check reads, and the
  human can always interrupt. Reading the registry by repo (instead of the old
  `.otacon/current-session` pointer) keeps the hook in step with the CLI's single
  source of truth — `pwd -P` canonicalizes the root so it matches the realpath the CLI
  stores, and a symlink that defeats the match merely fails open. The substring/split
  parsing is naive but sound in practice: the registry JSON is compact and flat, so a
  session title containing the literal `},{` or `"status":"approved"` is not a real
  threat model for a personal tool.
- **Revisit when:** Hook input or the registry JSON grows shapes sed can't safely
  extract — a title containing `},{` mis-splits, or nested objects appear (then: a node
  one-liner — node is guaranteed by the package's own engines) — or false blocks show
  up in real use.

## Stop hook is optional: doctor confirms-when-present, install never nags

- **Decision:** The Stop hook is treated as an optional extra, not a required piece of
  setup. `otacon doctor` reports a `stop-hook` check **only when the hook is registered**
  (status `ok`); when absent it omits the check entirely — no `warn`. `otacon install`
  without `--hooks` no longer prints the "Stop hook not registered — run … --hooks"
  notice or the `hint` field; it just carries the factual `registered` boolean in its
  JSON. The functionality is unchanged: `--hooks` still writes and registers the script,
  and the script still blocks turn-end while a session is open.
- **Why:** Nothing establishes the Stop hook as must-have. The skill's
  never-end-your-turn instruction (§13) already covers the same ground; the hook is a
  belt-and-suspenders backstop. Flagging its absence as a warning (doctor) or nagging on
  every hookless install framed an optional convenience as a setup defect, pushing users
  toward editing `~/.claude/settings.json` they may not want touched. Confirm-when-present
  keeps the signal for those who opted in (and keeps the e2e/acceptance `stop-hook: ok`
  assertions valid, since they install `--hooks` first) without manufacturing a problem
  for those who didn't.
- **Revisit when:** Real use shows agents routinely ending their turn mid-review on
  Claude Code despite the skill instruction — i.e. the hook proves load-bearing rather
  than belt-and-suspenders — at which point promote it back to a warned/recommended part
  of setup.

## clean: daemon deregisters AND archives; undrained events leave with the dir

> **Superseded** by "Delete permanently removes the home session folder; no archive":
> `DELETE /api/sessions/:id` no longer archives to `.otacon/archive/`; it `rmSync`s the
> session's home folder `~/.otacon/sessions/<id>/` outright for every status, and the
> response no longer carries `archivedTo`. `Store.archiveSessionDir` was removed. The
> daemon-owns-deregistration rationale, the queue-`close()`-before-removal ordering, and
> the drop-undrained-events tradeoff below all still hold (the removal replaces the move).

- **Decision:** `DELETE /api/sessions/:id` is **status-branched**; its **approved**
  branch is `otacon clean`'s path: it removes the registry entry, evicts the session's
  queue instance without draining it, and the **daemon** moves `.otacon/<id>/` to
  `.otacon/archive/<id>/` (`Store.archiveSessionDir`), returning the destination as
  `archivedTo`. The CLI just relays that field; it no longer moves the dir itself. The
  response also reports still-pending events; clean surfaces them as a notice and
  proceeds. The queue instance is `close()`d before the move: a delivered-but-unacked
  event's post-response ack firing after it would otherwise recreate
  `.otacon/<id>/events.json` next to the archive (writeFileAtomic mkdirs). `clean` only
  ever sends approved ids, and `approved` is terminal, so it never takes the pending
  branch (next entry).
- **Why:** The registry is daemon-owned in-memory state — a CLI editing `registry.json`
  directly would be overwritten by the next flush, so deregistration must be a daemon
  verb. Archiving moved **into the daemon** (it was the CLI's job through M5) so the
  browser UI can delete an approved session too (the browser can't move files on the
  daemon's host); one archiving implementation now serves both clean and the UI. The
  daemon already owns `.otacon/<id>/`, and it captures `session.repo` before deregistering
  (the registry copy survives `deleteSession`), so nothing races the move. Dropping
  undrained events is the conscious resolution of the M2-era eviction caveat (DECISIONS
  "One SessionQueue instance per session"): on an approved session the only loseable
  events are `approved` copies, and the artifact they announce is already committed on
  disk — blocking clean on them would make the common "approve, then tidy up" flow refuse.
- **Revisit when:** clean itself should bulk-sweep pending sessions (today the UI deletes
  those one at a time — next entry), which would need a real force/drain story.

## delete a session from the UI: any status; approved archives, pending hard-removes

> **Superseded** by "Delete permanently removes the home session folder; no archive":
> delete is now uniform: the daemon `rmSync`s the home folder `~/.otacon/sessions/<id>/`
> for every status, with no archive branch. The parked-agent `{event:"deleted"}` wake,
> the wake-before-deregister + `closeWith`-before-removal ordering, and the shared
> `removed` SSE frame all still hold; only the approved-archives split is retired. The
> confirm-sheet copy follows status to explain where the durable copy survives, not
> whether the delete is recoverable.

- **Decision:** Every session is deletable from the review UI (index card + session
  header) via `DELETE /api/sessions/:id`, status-branched on whether it has committed
  value. **Approved** → the clean path above (deregister + `archiveSessionDir`,
  recoverable). **Pending** → wake any parked agent with a terminal `{event:"deleted"}`
  (new `EventPayload` member; `SessionQueue.closeWith` sets the queue closed, then hands
  the synthetic event to every parked waiter), deregister, and **hard-remove**
  `.otacon/<id>/` (`Store.removeSessionDir`, `rm -rf`) — permanently. Ordering on the
  pending branch: wake before deregister (so the woken long-poll resolves against a
  still-registered session), and `closeWith` marks the queue closed before the dir is
  removed (so a late ack cannot recreate it). Both branches publish the existing terminal
  `removed` SSE frame — no new browser frame. No new CLI verb; the wrapper's review loop
  learns to stop on `deleted`. The confirm sheet (one stage, mirroring Approve) is the
  only guard, and its copy follows status: "archived (recoverable)" vs "permanent".
- **Why:** Sessions of any status pile up in the index, and clearing them shouldn't
  require the CLI. Disposition follows committed value: an **approved** session's plan +
  transcript are committed under `docs/plans/`, so its working state is worth keeping —
  archived, exactly as `clean` already does. A **pending** session has no committed
  artifact and its working state is pure review exhaust, so archiving every discarded
  draft would just grow `.otacon/archive/` with junk — hard-remove instead. Waking a
  parked agent beats letting it 404 on its next `wait`: it stops *immediately and cleanly*
  with an honest terminal event. Reusing the route + `removed` frame keeps the surface
  minimal — the UI and CLI already handle `removed`, so only the daemon branch, one event
  member, the archive helper, and the wrapper text are new.
- **Revisit when:** users want an undo for the hard-delete (then: a soft-delete/trash with
  a TTL, not `rm -rf`), or deletion needs to reach an agent that is mid-call rather than
  parked (then: a per-session kill flag the next call checks, beyond the wake).

## Session working state lives in the home store `~/.otacon/sessions/<id>/`

- **Decision:** Every per-session file (`plan.md`, `session.json`, `events.json`,
  `threads.json`, `transcript.json`, `activity.json`, `stream.jsonl`, the `rN.*`
  revision snapshots, queues) lives in the home store under
  `~/.otacon/sessions/<id>/`, keyed by the globally-unique session id and resolved with
  no repo argument. This is the same folder the approved artifact already landed in, so
  working state and the approved plan now share one home dir. The path helpers
  (`paths.sessionDir(id)` and friends) take the id only; `Store` keeps the registry's
  `RegistrySession.repo` for listing and the single-active-session-per-repo rule, but
  path resolution no longer touches it. Config stays in the repo (`<repo>/.otacon/`).
- **Why:** The session id is already globally unique, so keying state by it removes the
  last reason to scatter working state across repo `.otacon/` dirs: `<repo>/.otacon/`
  collapses to config + the Save plan copies (easy to track or ignore as one unit), and
  session state becomes repo-independent (a build worktree and its main repo no longer
  hold split halves of one session). It also unifies the storage model: the approved
  artifact was already home-keyed, so working state simply joins it. The two phases that
  did this (relocate state, then make delete remove the home folder) shipped in one
  commit because they are coupled through the `sessionDir(id)` signature change.
- **Revisit when:** Two machines need to share one session's live state (then the home
  store needs a sync story, which a repo-relative layout would not have helped anyway), or
  a session needs files large enough that `$HOME` placement matters.

## Delete permanently removes the home session folder; no archive

- **Decision:** `DELETE /api/sessions/:id` (UI delete + `otacon clean`) deregisters the
  session and `rmSync`s its home folder `~/.otacon/sessions/<id>/` (`recursive, force`)
  for **every** status. There is no `.otacon/archive/` move and the response carries no
  `archivedTo`; `Store.archiveSessionDir` was deleted. A live (non-terminal) session's
  parked agent is still woken with a terminal `{event:"deleted"}` before deregistration.
  The durable copies are the Save copy under `plans.dir` and (for Implement plans) the PR.
- **Why:** Once working state and the plan both live in one id-keyed home folder, "archive
  the working dir but keep the home plan" no longer parses: they are the same folder.
  Archiving every deleted session would just accrete copies of state the user explicitly
  discarded, and the genuinely durable record already exists outside otacon (the committed
  Save copy, or the PR). A uniform `rm` is simpler than a status-branched
  archive/hard-remove split and matches what "delete" plainly means. Pre-release and home
  state is gitignorable/global, so losing it on delete costs nothing a user expected to
  keep.
- **Revisit when:** Users need a recoverable trash (then: a soft-delete with a TTL and a
  restore path, not an immediate `rm`).

## No migration of pre-existing in-repo `.otacon/<id>/` dirs

- **Decision:** The relocation is going-forward only: otacon ships no migration that moves
  old `<repo>/.otacon/<id>/` working dirs into the home store. For any session whose state
  was written in the repo before this change, the daemon simply rebuilds fresh state from
  the (empty) home dir on next access: `readState` already recovers a missing
  `session.json` to revision 0 with zeroed counters, which is the existing quarantine/
  rebuild path. Stale `<repo>/.otacon/<id>/` dirs are inert and safe for the user to
  delete by hand.
- **Why:** otacon is pre-release and `.otacon/` working state is gitignorable, so no real
  session history is at stake: a migration would be code (and a test surface) written to
  preserve data nobody is depending on. The rebuild path already exists for corrupt/missing
  state, so an orphaned old session degrades gracefully rather than wedging. Leaving stale
  dirs in place (rather than auto-deleting them) keeps the change from ever touching repo
  contents the user did not ask otacon to touch.
- **Revisit when:** otacon has shipped to users with real in-repo session history worth
  carrying forward (then: a one-time `otacon migrate` that moves dirs and re-points the
  registry).

## doctor/expose: OTACON_TAILSCALE override, PATH + app-bundle lookup, serve-only automation

- **Decision:** Tailscale is discovered via `OTACON_TAILSCALE` (authoritative when
  set), else PATH, else the macOS app bundle's embedded CLI. `otacon expose`
  automates exactly one thing — `tailscale serve --bg http://127.0.0.1:<port>` after
  verifying `BackendState === "Running"` — then **verifies the result** by GETting
  `<url>api/health` and reporting `verified`; install, login (`tailscale up`), and
  tailnet HTTPS/MagicDNS enablement are errors/pointers, never automated. doctor
  treats every tailscale state as a warning, and wrapper absence likewise; only node
  < 20 and a daemon that cannot own its port fail the run (exit 1).
- **Why:** Login and HTTPS enablement are interactive and account-scoped (browser
  auth, admin console) — automating them means scraping flows that change under us,
  for a step done once per machine. But `serve --bg` exits 0 once its config is
  written, so it is a false success signal: with the tailnet's HTTPS Certificates
  disabled the URL resets every TLS handshake, and a bare `ok:true` sent users
  chasing the wrong layer (the daemon's Origin guard, the App Store sandbox) when the
  real fix was one admin toggle. An actual GET is the only honest check — DNS that
  never resolves is fatal (the hermetic e2e stub, a foreign tailnet), a TLS reset is
  retried to ride out cold-cert provisioning. `cap/https` in `status --json` is *not*
  a usable signal — it is absent even when HTTPS is enabled and serving. The env
  override extends the OTACON_HOME/OTACON_PORT escape-hatch pattern and keeps the
  e2e hermetic (a stub binary + an unresolvable name, never a real tailnet). Doctor's
  warn-vs-fail split follows use: phone access and non-Claude agents are optional
  features, but a broken daemon or runtime breaks everything.
- **Revisit when:** `tailscale serve` syntax changes (the e2e stub pins today's),
  expose needs serve-status introspection to detect an already-configured tailnet, or
  Tailscale exposes a reliable "HTTPS enabled" signal that could replace the live GET.

## open and config launch the browser; OTACON_NO_BROWSER opts out

- **Decision:** `otacon open` and `otacon config` launch the URL in the default browser
  (best-effort, detached: `open`/`xdg-open`/`start`). `OTACON_NO_BROWSER` (any non-empty
  value) suppresses the launch and prints the `{url}` JSON to stdout instead. `open
  --session` still resolves strictly; implicit resolution failures (no session,
  ambiguous, stale pointer, ended session) still degrade to the index URL with a stderr
  notice rather than failing; they just launch the index. `config get` is unaffected:
  it is data, always JSON on stdout.
- **Why:** These two verbs are human convenience and the whole point is "show me the
  page": printing a URL the human then has to copy was friction, and the desktop
  open-in-browser convenience the original print-only decision deferred turned out to be
  missed (its own "revisit when"). The launch is best-effort and detached so a missing
  opener (ENOENT), a non-GUI host, or a slow browser never throws out of the JSON-on-
  stdout contract, fails the command, or stalls an agent that ran it. OTACON_NO_BROWSER
  keeps the stdout-is-the-contract path for headless hosts, CI, the e2e scripts, and any
  agent that wants to parse the URL, so the old behavior is one env var away. Lenient
  index fallback stays because the never-guess rule (§7) guards *writes*, not looks.
- **Revisit when:** The daemon is reached over an exposed/remote URL where the CLI host's
  browser is the wrong machine (then: gate the launch on locality, or add a `--print`
  flag that wins regardless of env).

## Section ⋯ menus mint section-only anchors; clicks delegate like citations

- **Decision:** Every section and phase header renders a `⋯` button (M5b) whose menu
  offers _comment on section_ / _ask about section_; both open the existing composer
  with a `{section}`-only anchor — no `exact` quote, no new anchor grammar. The
  buttons are pure markup inside the memo'd PlanView; their clicks are delegated
  through the plan container's onClick exactly like the `← q<n>` citation links, and
  the buttons join the chrome selector so a text selection touching one never offers
  the toolbar. The menus render on desktop too (a popover under the button; a bottom
  sheet on phones).
- **Why:** Selection anchoring is miserable on a phone, and §4's anchor shape already
  treats the quote as optional — the re-anchoring ladder's quoteless rung (section
  existence) and the orphan tray have handled `{section}` anchors since M3, so the
  daemon needed zero changes; inventing a coarser anchor type would have forked the
  thread/orphan logic for nothing. Delegation keeps PlanView callback-free: a menu
  prop would defeat the memo and re-render (= re-write) the DOM under the very
  selection being anchored. Desktop keeps the menus because hiding an affordance per
  viewport makes muscle memory lie.
- **Revisit when:** Plans grow anchor targets below section granularity (paragraph
  ids), which would want a finer menu or a different gesture.

## Modal dialogs portal to document.body for top-tier stacking

- **Decision:** Every modal overlay (the approve/delete confirm dialogs, the section
  ⋯ menu, the mobile session sheet) renders through a tiny `Portal`
  (`src/ui/portal.tsx`, a `createPortal(children, document.body)` wrapper) instead of
  inline where it is triggered. The confirm overlay sits at `z-index: 60`, above the
  session sheet (50) and section menu (41); because the overlays now live on body,
  those z-indexes are global rather than local to a trapped subtree.
- **Why:** The `DeleteDialog` (and the approve dialog) can be opened from a sidebar
  row, and `<aside class="app-sidebar">` is `position: sticky` (a stacking context),
  painted *before* `<main class="app-content">`. An inline overlay is trapped inside
  that sidebar context, so the main column's grill cards paint above it no matter how
  high its z-index climbs: raising z-index alone cannot escape a stacking context, the
  value only orders siblings *within* it. Portaling to body lifts the overlay out of
  every ancestor stacking context, so a single global z-index actually wins. React has
  no automatic top-layer; `createPortal` is the standard escape, and a one-line shared
  component keeps every dialog honest about it.
- **Revisit when:** We adopt the native `<dialog>` element / the CSS top-layer (which
  would supersede the portal), or a dialog needs to stay scoped to a subtree (focus
  trapping or inert-background handling that the portal would complicate).

## The sticky bar is the drawer, augmented at the phone breakpoint

- **Decision:** The §10 phone sticky bar is not a new component: the comment drawer
  bar gains the phone-only instruments — ❓ question count (scrolls to the grill
  queue), ✓ approve — and CSS at ≤639px swaps the faces: the header strip's approve
  hides, the drawer's review toggle folds into the (now tappable) ◆N tally, labels
  compact to glyphs, every target grows to ≥44px. With a batch pending, approve drops
  its word to its glyph via a sibling selector so all five instruments hold one 375px
  row. Glyphs stay the rail's mono family (◆ comment, ? question), not emoji.
- **Why:** One DOM means one state machine — pending drafts, busy/failed, the
  question count — with zero risk of the two surfaces disagreeing; the §10 rule
  ("don't show both redundantly") becomes a pure CSS concern. 639px matches the
  existing phone breakpoints rather than minting another. The conditional approve
  word is the cheapest honest fix for the densest-bar overflow found in the 375px
  screenshot audit.
- **Revisit when:** The bar wants a sixth instrument (it is full at 375px), or
  thread bottom-sheets land and need their own bar seat.

## Preserve pinch-zoom; kill only the iOS input auto-zoom

- **Decision:** The viewport meta stays permissive (`width=device-width,
  initial-scale=1` — no `maximum-scale`/`user-scalable=no`), so pinch-zoom keeps
  working. iOS's *other* zoom — the auto-zoom that fires when you focus a field
  whose text is below 16px — is defeated instead by sizing every touch input
  (`input`/`textarea`/`select`) to `var(--fs-body)` (16px) at the ≤639px breakpoint.
  CSS only; the override rides the body token rather than a hardcoded 16px, so the
  anti-zoom floor and the reading-content size are one value (see "A 5-role semantic type
  scale": lowering `--fs-body` below 16 reinstates the zoom).
- **Why:** The two zooms are different mechanisms and only one is the bug.
  `maximum-scale=1` would kill both, but pinch-zoom is a baseline accessibility
  affordance (low-vision users magnify), so suppressing it to fix a focus jank is
  the wrong trade. 16px is the documented threshold below which iOS Safari decides
  the field is too small to type into and zooms — meeting it removes the trigger
  without touching the meta. The grill interview reversed the initial
  "disable both" answer for exactly this a11y reason.
- **Revisit when:** A field must render below 16px on a phone for layout reasons
  (then: scope the rule, or accept the zoom there), or iOS changes the threshold, or
  `--fs-body` is lowered below 16 (which would silently reinstate the focus-zoom, since
  the override now tracks that token).

## Keyboard-aware sheets: VisualViewport inset + a body scroll-lock, one shared mechanism

- **Decision:** Bottom sheets clear the on-screen keyboard by adding a live
  `--kb-inset` CSS var to their `bottom`, measured from `window.visualViewport`
  (`innerHeight − (vv.height + vv.offsetTop)`, clamped ≥0); a sibling
  `useScrollLock` pins `<body>` (`position: fixed; top: −scrollY`) behind any open
  sheet. One mechanism covers all sheets (composer, section ⋯ menu, approve), gated
  to phone widths so desktop is untouched. The pure inset math and the lock/restore
  live as DOM-free functions in `keyboard.ts` for unit tests.
- **Why:** VisualViewport is the only API that reports the keyboard's real size
  across iOS/Android; the rejected alternatives each fall short — `interactive-
  widget=resizes-content` + dvh is Chromium-only and still untested on iOS, and
  top-anchoring the composer abandons thumb reach. The body-lock is the separate
  half of the bug the grill surfaced ("the UI behind it is also affected"):
  `overflow: hidden` alone does not hold iOS momentum scroll, so the fixed-position
  technique is required. Sharing one mechanism (not just the composer that
  triggered the report) means no sheet can regress into the keyboard later.
- **Revisit when:** `interactive-widget` ships and is reliable on iOS (it would
  replace the inset math), or a sheet needs to stay keyboard-anchored on desktop.

## Selection affordance is a docked bar: coexist with native popovers by placement

- **Decision:** The select-to-comment affordance is a Comment/Ask bar docked at a
  fixed bottom edge (thumb range on phone, a slim strip on desktop), not a toolbar
  floating over the selection. It retires the old "codec cursor" toolbar on both
  platforms; desktop keeps the `c`/`q` shortcuts. The composer's at-the-selection
  placement on desktop is unchanged (it opens on a click that has already dismissed
  the native popover).
- **Why:** Native selection popovers cannot be suppressed on the web — not the iOS
  long-press callout, not the macOS force-click "Look Up" dictionary (an OS trackpad
  feature with no JS hook). The old toolbar floated *exactly* where those land, so
  they stacked, on desktop as much as phone. Google Docs only dodges this by
  rendering text to a canvas (reimplementing selection + a11y — overkill for a review
  tool); Notion/Medium just coexist by placement. Relocating out of the popover zone
  is the cheap, correct version of the same move. The deliberate cost — the bar sits
  farther from the selection than a floating one — is paid down by the `c`/`q`
  shortcuts on desktop and thumb-range placement on phone. A left-margin gutter pip
  (the other coexisting option) was rejected because it anchors to the block, not the
  exact selection span.
- **Revisit when:** Browsers gain a real hook to suppress or reposition the native
  popover, or selection moves to a canvas surface that eliminates it.

## Switcher rides the index stream; current chip leads; unread is device-local

- **Decision:** The review header's session switcher is one component with two
  CSS-toggled faces: a native `<select>` on desktop, the §7 chip strip on phones.
  It opens its own `/api/stream` EventSource (snapshot + `session` + `removed`
  frames). The current session's chip is pinned first and never shows an unread
  badge; other chips badge `●N` where N = revision − this device's seen mark
  (localStorage, M2's unread convention).
- **Why:** The index stream already carries exactly the needed summaries live —
  reusing it costs one idle SSE connection and zero new endpoints. A native select
  is the one dropdown that needs no positioning, focus-trap, or ARIA work. Pinning
  the current chip keeps the "you are here" anchor from scrolling out of the strip;
  suppressing its badge avoids a lie — markSeen runs after the first render, so the
  badge would flash for one frame on every switch and then mean nothing.
- **Revisit when:** Session counts make the strip unwieldy (then: collapse approved
  chips behind a tail toggle), or the select needs unread affordances a native
  control cannot draw.

## clean publishes a terminal `removed` frame; cleaned screens close their stream

- **Decision:** `DELETE /api/sessions/:id` publishes `removed` (the M5a review's
  carry-forward) after deregistration. The index and switcher drop the session from
  their maps; an open review screen flips to a quiet "session cleaned" terminal
  state — switcher still live, message naming `otacon clean` and `docs/plans/` —
  and closes its EventSource for good. The daemon ends the per-session stream after
  the frame too (the index stream stays open).
- **Why:** Without the frame, an open tab showed a ghost session until reload (noted
  as acceptable-for-M5a, revisited here). Closing the stream matters: EventSource
  auto-reconnects, and a reconnect against the deregistered id can only 404-loop;
  cleaned is terminal by definition, so there is nothing to re-sync. The frame
  carries just the id — removal needs no summary, and the UI must not retain one.
  Server-side close is the other half of terminal: nothing can ever be published
  for the session again, so a client that ignored the frame would otherwise pin the
  connection (subscription + heartbeat) until it disconnected on its own.
- **Revisit when:** Sessions gain other terminal removals (abandon/expire), which
  should reuse this frame rather than mint new ones.

## Option grill cards accept a free-form custom answer ("Other" parity)

- **Decision:** `POST /answers` accepts a non-empty trimmed `text` with neither
  `choice` nor `choices` on an option question (single AND multi) as a complete
  answer; the chip path (one `choice`, or 1+ `choices` under `--multi`, optionally
  with `text` as a note) is unchanged. The UI mirrors this: a single-select card's
  "+ add a note" box doubles as the custom-answer field with a "send custom" button,
  and a multi-select's send arms on non-empty text even with no chip picked.
- **Why:** Native AskUserQuestion always offers an escape-hatch "Other"; otacon's
  chips did not, so a user who disagreed with every offered option had no way to say
  so without the agent re-asking — the exact friction that surfaced live while
  grilling this very feature. Relaxing validation to text-only closes the gap with
  one rule and no schema change (`GrillAnswer.text` already existed). The guard
  against garbage is narrow — `text.trim() !== ""` — and the choice/choices branches
  stay byte-for-byte, so the instant single-tap answer the user called "nice" is
  untouched.
- **Revisit when:** Custom answers need their own provenance in the transcript
  (today they are indistinguishable from a note that rode a chip), or a question
  type wants to forbid free-form override (none does yet).

## Batch ask mints N ordinary cards — no grouping, no new transcript field

- **Decision:** `otacon ask --batch <file|->` (and `POST /ask {questions:[…]}`)
  posts several **independent** questions in one call. The daemon validates every
  member, then mints all ids in one counter bump and one transcript write — a
  malformed member fails the whole batch (no partial queue). The minted entries are
  *ordinary* `TranscriptEntry` cards: no batch id, no group field, no new SSE frame
  type. They render and answer exactly like standalone questions, and `wait` stays
  one-answer-at-a-time (the agent loops it to drain the batch). A `wait --all` that
  blocks until a whole batch is answered is deferred — the per-answer loop suffices.
- **Why:** Asking one round-trip at a time is slow when several questions are truly
  independent. Batching is purely an *ask-time* convenience: dependency-first
  grilling is unchanged (only siblings whose answers don't shape each other batch),
  and the user-facing flow — instant single-tap, settle-in-place — is the one the
  user already called "nice", so it must not change. Minting ordinary cards keeps
  the entire UI, transcript, citation, and approve surface untouched; the only new
  surface is the ask route's body and the CLI flag. Atomic mint mirrors the comment
  batch (`POST /comments`): validate the whole set, then one counter write, so a
  rejected batch burns neither ids nor disk.
- **Revisit when:** A batch needs to render as a visually grouped set (a header /
  group submit), or `wait --all` proves necessary because draining a large batch
  one answer at a time grates in practice.

## Card system is hairline telemetry, not rounded-rect + fat left-border

- **Decision:** The repeated house card pattern — rounded rectangle, 3–4px painted
  accent left-border, soft drop-shadow — is replaced system-wide with flat panels
  split by thin rules. Containers drop `border-radius` (to 0); the accent becomes a
  small mark (a mono `▍` tag in the meta row, or a 2px accent rule along the top
  edge), never a side blade; in-flow cards (index rows, grill card, revision banner,
  threads, phases, dossier containers) drop their shadow; floating overlays
  (composer, section menu, approve/bottom sheets, drawer) keep a shadow to lift off
  the page. The index becomes a top-ruled telemetry list. The codec identity
  (masthead, mono type, scanlines, per-session hue) and all controls (chips with the
  `★rec` star + on/off states, buttons, inputs, pills, every ≥44px hit target) are
  unchanged — only container chrome moves.
- **Why:** The rounded-card + fat-left-border + shadow pattern reads as generic
  "AI-slop" dashboard, not the Metal-Gear codec instrument otacon is identity-wise.
  Hairline telemetry executes the *same* codec aesthetic sharply: denser, flatter,
  reads like a real readout. Keeping the accent as a thin mark (rather than removing
  it) preserves per-session identity and the "agent is transmitting" signal on the
  grill card and banner. Controls are deliberately exempt — they are touch targets a
  thumb hits while walking (§8, §10), so their shape and feedback must not change;
  the refresh is purely the panels *around* them. Floating surfaces keep shadows
  because depth-from-the-page is functional there, not decoration.
- **Revisit when:** The accent mark's final form is judged on a live screen and a
  different indicator (dot vs tag vs underline) wins, or a surface needs more than a
  hairline to separate from dense neighbors.

## Live agent activity: explicit `otacon progress` narration, not inferred state

> [!note] Reframed by "`otacon progress` stays as the universal floor + curated
> highlights" below. `progress` is no longer the *only* live-activity signal: the
> automatic transcript stream (§10a) now carries routine activity on supported agents,
> so `progress` is asked for sparingly (highlights / chapter markers) and is the sole
> signal only on agents with no transcript adapter. The verb, endpoint, and feed are
> unchanged.

- **Decision:** The agent reports what it's doing with a new `otacon progress
  "<note>"` verb (not the daemon inferring state from existing calls). Notes append
  to a capped (~20, config) `activity.json` feed, push as an `activity` SSE frame,
  and the newest one drives the `draft` chip (falling back to "agent working"). No
  new status value is added; `progress` queues no agent event.
- **Why:** The daemon only hears from the agent at discrete CLI calls; during a long
  research or drafting stretch it makes none, so there is nothing live to show.
  Inference is brittle and silent — explicit checkpoints are accurate and cheap, and
  keep the zero-API invariant (the agent narrates; no model call). Making the *draft*
  chip activity-driven (rather than adding a `researching` status) avoids churn in the
  4-status machine, the linter, and every status surface, while fixing the real
  problem: `draft` rendered a fixed "agent drafting" that misled during research. A
  capped append-only feed (vs a single current-note line) gives a readable history
  without unbounded growth; a UI-only frame (no queued event, like `ask`) keeps it
  pure telemetry that never wakes the agent.
- **Revisit when:** Agents reliably forget to call `progress` (then automatic
  inference becomes worth its complexity), or the feed cap / note length need to be
  something other than config knobs.

## Agent presence is in-memory and ephemeral, derived UI-side from recency

- **Decision:** Presence is an in-memory `Map<id, lastContactAt>` in the daemon
  (bumped by every mutating verb and each `wait` park) plus a `parked` flag from the
  queue's waiter count — exposed on the summary, never persisted. The UI derives
  live/offline as `parked || (now - lastContactAt < THRESHOLD)`, with a screen tick
  keeping it honest while idle; the threshold is a UI constant that must exceed
  `wait`'s 240s park slice. A `wait` park (and its settle) publishes a `session`
  frame so the dot updates within one slice. The dot is subtle (a small mark beside
  the chips, labelled "agent" to distinguish it from the "link" dot), not a new
  first-class status — the chips stay the primary "your turn" signal.
- **Why:** Liveness is inherently ephemeral — a daemon restart genuinely means "I
  haven't heard from the agent since," so showing offline until the next contact is
  correct, and a persisted timestamp would lie across restarts. Deriving in the UI
  needs no daemon timer. Publishing on park (not only on progress) means the dot
  stays live across the silent stretches when the agent is parked waiting on the
  user. Keeping it subtle honors the ask (q4): the existing chips already say "your
  turn"; presence answers a different question ("is it still on the line?").
- **Revisit when:** The threshold proves too eager/laggy in practice, presence needs
  to survive restarts (then it must be persisted with its caveats), or the subtle dot
  loses to a louder "your turn" treatment.

## Start-first protocol order; one parametrized protocol card feeds both wrappers

- **Decision:** The canonical loop runs `otacon start` *before* research (not after),
  so the review UI exists from the first second. The protocol card is built once by
  `protocolCard(cmd)`, parametrized only by command prefix: the installed wrapper
  (`skillMd`, shared by all three agents) uses `otacon`; this repo's committed dogfood wrapper
  (`dogfoodSkillMd`, written to `.claude/skills/otacon-dev/SKILL.md`) uses `./bin/otacon`
  and prepends a repo preamble. The dogfood wrapper is **named `otacon-dev`, not `otacon`**,
  so it never collides with the installed product skill (`otacon`) when developing otacon
  itself — `/otacon` invokes the real product, `/otacon-dev` the source-mode wrapper. The
  dogfood file is generated, never hand-edited, and
  `assets.test.ts` asserts the committed file equals `dogfoodSkillMd()`.
- **Why:** Start-first is the whole point of live activity — minting the session only
  after research wastes the watch window the feature exists to provide. Single-source
  removes the standing risk that the dogfood wrapper and the installed wrapper drift:
  before, the dogfood SKILL.md was hand-kept "in sync" with `assets.ts` and a protocol
  edit could silently update one and not the other. The equality test turns that drift
  into a CI failure. `otacon install` into other repos is unchanged — it writes the
  plain-`otacon` wrapper, which already works anywhere; only this repo needs the
  source-mode variant, so no project-scoped install path is added. The dogfood wrapper is
  named `otacon-dev` because an otacon developer almost always also has the installed
  `otacon` product skill present; two skills both named `otacon` make `/otacon` ambiguous
  and the harness silently picks one (in practice the product wrapper, which talks to the
  shared `:4747` daemon, not this checkout's isolated worktree daemon). A distinct name
  keeps the choice explicit: `/otacon-dev` always exercises this checkout's source.
- **Revisit when:** A second repo needs a source-mode wrapper (then generation should
  be a real CLI subcommand, not a test-guarded committed file), the two wrappers
  need to diverge by more than the command prefix + preamble, or `otacon install
  --project` in this repo starts writing an `otacon` wrapper that re-introduces the
  collision the rename avoided.

## Attention notifications: native macOS banner, not Web Push, for desktop

- **Decision:** "This plan needs your attention" reaches the desktop as a native
  macOS banner that the **daemon** fires (`src/daemon/desktop-notify.ts`), not via
  Web Push. The daemon already runs on the Mac, so it owns that surface directly —
  no service worker, no VAPID, no push subscription. Phone (Web Push) is a separate,
  deferred path (DESIGN.md §14), tracked in TODOs.md.
- **Why:** Web Push exists to reach a device the sender can't address directly — the
  phone. The desktop is not that device: the daemon is already a local process on the
  same machine, so a local OS call is the shortest, most reliable path and adds zero
  moving parts. Shipping desktop first delivers the daily-driver surface (you plan at
  your Mac) without the push-infrastructure tax, and keeps the phone path a clean,
  isolated future lift rather than a half-built dependency.
- **Revisit when:** The phone Web Push path lands and a shared notification core is
  worth extracting, or the daemon routinely runs somewhere without a Mac GUI session.

## Desktop notify tool: prefer terminal-notifier, fall back to osascript, no hard dep

- **Decision:** `notifyDesktop` prefers `terminal-notifier` when callable
  (`$OTACON_TERMINAL_NOTIFIER` pins it, else PATH), because its banner is
  *clickable* — `-open <url>` opens the review screen on tap. Absent it, it falls
  back to `osascript -e 'display notification …'` (zero dependency, informs but not
  clickable). Neither is a hard dependency; off macOS the whole thing is a no-op.
  Every spawn goes through `execFile` with an **arg array** (no shell).
- **Why:** Click-to-open is the difference between a banner that just pings and one
  that lands you on the plan — worth preferring `terminal-notifier` when the user has
  it, but not worth forcing a `brew install` on a personal tool that must work out of
  the box, hence the osascript fallback. The arg array (no shell) is the injection
  guard: a session title or question text rides as one inert argv element, so quotes,
  semicolons, or backticks in plan content can never become a command — only
  osascript's own AppleScript-literal escaping (backslash + double-quote) remains, and
  that is applied explicitly.
- **Revisit when:** Linux/Windows desktop support is wanted (add `notify-send` /
  toast equivalents behind the same seam), or terminal-notifier's CLI changes.

## Every notification decision is logged to daemon.log (always-on audit trail)

- **Decision:** The daemon logs one stderr line per notification decision, landing
  in `$OTACON_HOME/daemon.log`. `maybeNotify` (`src/daemon/app.ts`) writes a `notify
  dispatch` line (session, kind, title, message) when a banner fires and a `notify
  skip` line (reason `config-disabled` or `watched`) when one is suppressed; the
  notifier (`src/daemon/desktop-notify.ts`) writes a `notify backend` line recording
  the backend (`terminal-notifier`/`osascript`/`none-non-darwin`) and a `clickable`
  flag. Always on — no debug flag, no separate log file.
- **Why:** "Why did otacon send this banner, and why does clicking it do nothing?"
  was unanswerable after the fact. One line per decision at the single `maybeNotify`
  chokepoint plus the backend reuses the existing stderr→`daemon.log` routing (zero
  new surface), and notification volume is low so always-on is free. A debug flag
  would have the trail off in exactly the moment a user hits the surprise. The
  `clickable=false` lines also surface the osascript no-click limitation directly.
- **Revisit when:** Notification volume grows enough that the lines become noise, or
  a structured/leveled daemon log channel replaces ad-hoc stderr writes.

## Daemon tests injected the real notifier; fixed with a no-op sink, not a guard

- **Decision:** Every `createApp(...)` in `src/daemon/app.test.ts` now passes a
  `notify` option (the recorder for the shared app, a no-op `() => {}` in helpers
  that do not assert on notifications). Previously `tailedApp`, the `bare`, and the
  `beating` apps omitted it and fell through to the real `createDesktopNotifier()`,
  so `bun test` fired live macOS banners titled by throwaway session titles such as
  "t". Fixed surgically; no env kill-switch or bunfig test preload was added.
- **Why:** the leak was a missing injection against an already-established
  convention, so restoring it where it lapsed is the smallest correct fix. A central
  guard (an env switch honored by the notifier, set via a test preload) was weighed
  and declined (q3) to avoid adding production surface for a test-hygiene bug. The
  residual risk (a future helper forgets the inject) is accepted and called out in
  the plan's Risks.
- **Revisit when:** a third helper leaks a real banner, at which point the central
  guard (env kill-switch + preload) earns its keep.

## Banner suppression keys on visibility, not on a live SSE connection

- **Decision:** A desktop banner is suppressed only while that session's review is
  *visible*. The review screen reports `document.visibilityState` to the daemon
  (`POST /presence`: {visible:true} on show + a ~20s heartbeat, {visible:false} on
  visibilitychange→hidden, a `sendBeacon` false on unload); the daemon's `Presence`
  tracker holds `lastVisibleAt` and treats a session as watched within a ~45s TTL.
  Suppression is NOT keyed on the per-session SSE stream being connected.
- **Why:** The original sketch (q5) suppressed on a live SSE connection because "the
  daemon already knows the stream count." But a hidden or backgrounded tab keeps its
  SSE stream open — so a connection count silences exactly the banner you need when
  you've tabbed away or locked your phone. Visibility is the real signal: the point of
  the banner is to reach you when you're *not* watching. The TTL makes a crashed or
  closed visible tab self-expire (it stops heartbeating) instead of suppressing
  forever, while the explicit hidden/unload ping makes the common "switched tabs" case
  un-suppress immediately. The agent's parked `otacon wait` hits `/events`, never
  `/presence`, so a waiting agent can never suppress.
- **Revisit when:** Multiple devices view one session (per-device visibility, or
  "suppress only if visible *somewhere*"), or the heartbeat/TTL pair needs retuning
  against real backgrounding behavior.

## Phone (Web Push) is deferred; the future approach is zero-dep VAPID + wake-up fetch

- **Decision:** This milestone ships desktop banners only. Phone notifications via
  Web Push are deferred to a TODO (DESIGN.md §14). When they land, the agreed shape is:
  zero-dependency hand-rolled VAPID signing (`node:crypto`) plus a **payload-less**
  wake-up push — the service worker, woken by the push, fetches the session detail over
  Tailscale and builds the notification client-side. No `web-push` library, no
  RFC-8291 payload encryption in the daemon.
- **Why:** Desktop is the daily-driver surface (you plan at your Mac) and reaching it is
  a local OS call with zero infrastructure, so shipping it alone delivers most of the
  value immediately; bundling Web Push would have dragged a service worker, push
  subscription storage, and VAPID into the same change for the secondary surface.
  Deferring keeps this milestone small and the phone path a clean future lift. The
  payload-less design is chosen ahead of time because it sidesteps RFC-8291 encryption
  entirely (the heaviest hand-rolled-crypto path) while keeping plan content off the
  push service — the SW already has authenticated Tailscale access to the daemon, so a
  bare "wake up and fetch" is both the simplest and the most private option. Sketching
  it now means the TODO is actionable, not a blank "do Web Push somehow."
- **Revisit when:** The phone path is picked up — at which point payload-less-fetch vs.
  a `web-push` dep vs. full hand-rolled RFC-8291 gets re-decided against the then-current
  effort/dependency tradeoff (the alternatives from the interview's q2 are recorded
  there).

## Follow-up questions: linked `replyTo` threads, not a `messages[]` rewrite

> [!warning] The "question threads only / comment threads stay one-shot" scope is
> superseded by "Comments are multi-turn conversations too" below. The `replyTo`
> linked-thread mechanism itself stands — it is what comments now reuse.

- **Decision:** A follow-up on a question thread is a brand-new `q<n>` thread carrying
  `replyTo` (the root question's id), not a turn appended to a `messages[]` array on the
  existing thread. The new thread inherits the **root's** anchor (a client anchor on a
  follow-up is ignored), and "follow up on a follow-up" resolves to the same root, so a
  chain shares one key. The UI groups root + follow-ups into one conversation card with a
  pure `groupThreads` helper. Scope is question threads only, one direction (you ask, the
  agent answers); comment threads stay one-shot resolutions.
- **Why:** Linking reuses everything already built — the event queue and `question`
  wake-up, overwrite-idempotent `otacon answer <q>` (each turn is its own id, so a
  duplicate POST is still a shrug), the SSE `thread` upsert, the shared q-id space, and
  the existing re-anchoring pass (a chain that shares the root's anchor relocates and
  orphans identically, so the group travels as a unit). A `messages[]` rewrite would
  reshape the `Thread` union, migrate `body`/`answer` into the array, break the
  answer-by-id idempotency, and touch every thread reader (linter L5, approve's
  unresolved count, the rail, orphan re-anchoring) — far more surface for a P3 feature.
  Keeping it to question threads and one direction matches how the surface is actually
  used (you interrogate the plan; the agent's turn is the plan revision itself), and
  leaves comment-thread back-and-forth out of a change that doesn't need it.
- **Revisit when:** Conversations need agent-initiated turns inside a thread, comment
  threads need follow-ups too, or per-turn metadata (edits, reactions) makes a first-
  class `messages[]` model worth the migration.

## Comments are multi-turn conversations too, sharing the rail's conversation card

- **Decision:** Comment threads are no longer one-shot. A comment follow-up is a
  brand-new `t<n>` thread carrying `replyTo` (the root comment's id), inheriting the
  root's anchor — exactly the `replyTo` linked-thread mechanism questions already use,
  now extended to the comments route (`POST /comments` accepts `{items:[{replyTo,body}]}`
  and 404s E_UNKNOWN_COMMENT on a non-comment id). The rail renders BOTH kinds through
  one shared conversation card: a root + each follow-up turn, each turn paired with the
  agent's response — a question turn's `answer` (answered out-of-band via `otacon answer`)
  or a comment turn's `reply` (landed on the agent's resubmit, lint L5). `groupThreads`
  registers both comment and question roots as attach targets (ids are unique across
  kinds), and the one-shot comment card is folded into the conversation card. The reviewer
  Resolves the root to close the whole conversation (a resolved comment conversation
  collapses to the ✓ card); resolving the root withdraws every turn at once.
- **Why:** The threaded-review backend (turn-aware L5, openComments, approve's
  per-conversation unresolved count) and the `replyTo`/anchor-inheritance plumbing already
  generalize to both kinds — the only thing pinning comments to one-shot was the UI
  rendering them through a separate `ThreadCard`. Sharing one card removes that duplicate
  surface, keeps questions rendering and behaving exactly as before, and matches the real
  workflow: a reviewer often needs to refine a comment ("also handle rotation") before the
  agent acts, not just fire one note and wait. The key difference from question follow-ups
  is preserved and intentional — a comment follow-up is **revision-tied** (the agent
  responds per turn through the revise/submit loop, L5), whereas a question follow-up is
  answered out-of-band and never touches the plan.
- **Revisit when:** Comment turns need their own per-turn Resolve (today only the root
  closes), agent-initiated turns are wanted inside a thread, or per-turn metadata makes a
  first-class `messages[]` model worth the migration.

## The switcher hides approved sessions on both faces, with no current-session anchor

- **Decision:** The session switcher (DESIGN.md §7) lists only active sessions —
  approved ones are filtered from both faces (phone chips and desktop dropdown),
  including the session you are currently viewing (there is no "you are here" anchor
  exception for an approved current). Active-vs-approved comes from one shared,
  React-free `partitionByApproval` (`src/ui/session-filter.ts`) that also feeds the home
  list. When the current session is absent from the visible list — cleaned, or itself
  approved (opened from home) — the controlled `<select>` shows a labeled placeholder
  (title + state) and the chip strip omits it, rather than rendering blank.
- **Why:** Approved sessions are over; leaving them in the switcher clutters the strip
  you switch through on a phone with plans you'll never touch again. An interview first
  chose to keep the current session's chip as an anchor (q1), but that was reversed (t3):
  a lone approved anchor is dead weight, and once the current session can be absent for a
  *cleaned* reason anyway, "current isn't in the visible list" is one condition the
  placeholder already had to handle — folding approved into it adds no new state. One
  shared split (not two independent filters) is what guarantees the switcher and the home
  list can never disagree about which sessions are hidden.
- **Revisit when:** Switching back to an approved plan from the switcher (not just home)
  becomes a common need, or the placeholder's "title + state" proves to carry too little
  context.

## Approving the viewed session redirects home — on the live transition only

- **Decision:** When the session open on the review screen transitions to approved, the
  screen navigates to home (`navigate("/")`). The redirect fires **only** on the live
  non-approved → approved crossing, tracked with a `sawActive` ref that records we
  observed a non-approved status first; opening a session that is already approved
  (tapping an approved card on home) never redirects. Because the review screen is **not**
  remounted when the routed `id` changes (the router swaps the prop, it does not key the
  component), the `sawActive` ref is reset to `false` on every `id` switch — so the
  per-session crossing can't leak across a navigation. A `session` SSE frame that flips
  the status remotely (approved on another device) still redirects — accepted, not
  special-cased.
- **Why:** Once approved, the session's switcher chip is gone (above), so leaving you on
  a screen whose switcher can't navigate back to it is a dead end; home is where the
  approved section now holds it. The transition-only guard is load-bearing: if the
  redirect fired whenever status is approved, the home approved section could open
  nothing — every tap would bounce straight back, making approved plans unopenable. The
  ref-records-active approach is needed because a bare boolean's initial `false` is
  indistinguishable from an observed non-approved state, which would wrongly redirect a
  session that is already approved. The per-`id` reset is the other half of that guard:
  without it the "saw active" set while reading one session would persist into the next
  (no remount clears it), bouncing the next already-approved session you open straight
  home — the exact unopenable case the guard exists to prevent. Honoring the remote flip
  too keeps the rule simple and matches "approved is approved, wherever it happened" (q5).
- **Revisit when:** Users want to keep reading a plan they just approved in place (an
  in-screen "approved" confirmation state instead of a redirect), or a remote approval
  yanking you off an unrelated read becomes a real annoyance.

## Approved sessions group into a collapsed home section; the top count is active-only

- **Decision:** On the index (DESIGN.md §10) active sessions stay in the main `.cards`
  list; approved ones render in a dedicated `approved` section below it, collapsed by
  default, its heading carrying the count (`approved 3`), expanding on tap. It reuses the
  activity panel's disclosure idiom (button + `aria-expanded` + caret + `useState`) and
  the same `SessionCard` rows. The list's top `sessions N` count reflects the active list,
  not the registry total; the approved section carries its own count.
- **Why:** Approved plans should stay reachable from home (they're the committed
  artifact's review record) but not crowd the list of what still needs you — a
  collapsible section declutters while keeping them one tap away (chosen over an
  always-visible group, which still fills the list, and over expanded-by-default, which
  pays the toggle cost without the declutter win — q3/q4). Reusing the activity
  disclosure and the existing card keeps the surface consistent and the change small. The
  active-only top count makes the masthead number mean "your queue", matching the new
  main-list scope; the per-section count keeps the approved total visible without
  reintroducing the clutter.
- **Revisit when:** The approved section grows long enough to want its own search/paging,
  or users read the top `sessions N` as the registry total often enough that the
  active-only meaning surprises them (a one-line flip back, flagged as an open question
  in the plan).

## Sticky session header: one element that compacts, not a separate reveal bar

- **Decision:** The review screen's masthead is a single always-on sticky header
  (`ReviewHeader`, `position: sticky; top: 0`) that subsumes the old `.topbar` (back +
  switcher) and the scroll-away `SessionHead` hero. One `.rh-bar` carries everything on a
  single wrapping line: the identity ("Title - repo · branch"), the status pill, the
  agent-presence dot, the "updated Xm ago" timestamp, the delete button, and the clean⇄diff
  toggle (+ Approve on desktop only). There is **no separate detail row to collapse**:
  compaction past a small scroll threshold (`nextCompact`, rAF-throttled in
  `useCompactOnScroll`) now only tightens the padding and title-font size, re-expanding at
  the top. The revision pill is gone. The rejected alternative was a hero plus a separate
  condensed bar that fades in once the hero scrolls past. On phone the bar wraps to keep
  everything visible (including the status pill, which the old "phone header is chips-only,
  detail hidden" behavior wrongly hid below 640px); only Approve is CSS-hidden there, living
  solely in the fixed bottom bar. (We keep the toggle on phone because hiding it removed the
  only phone path into diff view, a regression an existing 375px e2e test caught, and the
  toggle, unlike Approve, carries no shown-in-two-places hazard.)
- **Why:** Two elements (hero + reveal bar) means an IntersectionObserver to gate the
  reveal and **two copies of the title/Approve** that can disagree or briefly both show
  — the exact double-render the §10 "Approve never shown twice" rule forbids. One
  element is always complete and consistent by construction: a dropped or coalesced
  scroll frame merely leaves it in its last state (still fully usable), never a
  half-rendered or duplicated bar. Folding the detail row's contents up into the one
  always-on bar (rather than collapsing it on scroll and hiding it on phone) extends that
  "one element can't disagree with itself" property to the status pill: it is now always
  visible, on every breakpoint, instead of vanishing on phones. rAF-throttling matches the
  selection reposition so the compact transition never janks per scroll frame. Keeping
  Approve out of the phone header (rather than duplicating it) preserves the never-twice
  rule while the bottom bar stays the one-thumb control surface.
- **Revisit when:** The header needs content that genuinely cannot fit a single morphing
  element, or scroll-driven compaction proves janky on a real low-end device (a
  scroll-timeline / `content-visibility` approach would be the next lever).

## Review page disables scroll anchoring so the compacting header can't move scrollY

- **Decision:** The review page (`.page-review`) sets `overflow-anchor: none` so the
  sticky header's compact-on-scroll resize cannot move `window.scrollY`.
- **Why:** Default scroll anchoring compensates the scroll offset when an above-the-fold
  element resizes (~44px header collapse), and that compensation exceeds the compact
  hysteresis band (enter 48 / exit 12), re-crossing the fold threshold and oscillating
  the header compact⇄expand whenever the rest scroll sits near the fold (reproduced
  in-browser; scrollY pumped 52→9→back). Disabling anchoring on the review subtree
  freezes scrollY through the resize, so the fold decision is stable. Chosen over
  widening the band because it removes the cause instead of out-tuning a content-dependent
  delta (the band-width fragility this file's sticky-header "Revisit when" already
  flagged). Safari ships no scroll anchoring at all and is unaffected; this just makes
  Chrome/Firefox match it. Scoped to `.page-review` so index and settings keep anchoring.
- **Revisit when:** A genuinely short plan (total height within the header-collapse delta
  of the viewport) still clamp-loops at the bottom, or the review screen needs scroll
  anchoring back for late-resizing above-the-fold content (a revision banner appearing
  while scrolled down); then a controller-level room-gate would be the lever.

## Persistent thread marks paint from a ReviewLoop effect, never a PlanView re-render

- **Decision:** Open threads (unanswered questions, unresolved comments) and unsent
  drawer drafts keep their anchored text lit via a `useLayoutEffect` that registers two
  named CSS Custom Highlights over `planRef` (`paintThreads` in `anchor.ts`) — `otacon-q`
  (underlined) for questions, `otacon-comment` for comments + drafts. The effect is gated
  on a stable anchor signature (ids + the quote-locating fields) so a drawer body
  keystroke never repaints, and re-fired by a `PlanView` `onRendered` tick after each
  lazy/revision commit. The click-flash keeps the higher `Highlight.priority`, so it
  still pops above the steady marks.
- **Why:** Re-rendering the memo'd `PlanView` to paint would rewrite the dossier DOM (see
  the next entry) — collapsing an in-progress selection and re-running mermaid. The
  Custom Highlight API paints without touching React-owned nodes (the same reason the
  flash uses it, and why wrapping quotes in `<mark>` was rejected). Open-only scope means
  answering or resolving a thread clears its mark on the next paint with no extra wiring
  (it just leaves the lit set); drafts reuse the comment ink, giving three readable
  states without a third treatment. Orphaned and whole-plan anchors have no re-locatable
  quote, so they are never lit. The `onRendered` tick closes the window where a new
  revision's DOM mounts before the paint runs; the signature gate keeps painting off the
  per-keystroke path.
- **Revisit when:** Answered/resolved threads should leave a faint "was-discussed" tick
  instead of clearing (open question from the plan's q1), or a new thread kind needs its
  own ink and the two-name scheme no longer suffices.

## Tap a lit span focuses its thread; a drag still selects to comment

- **Decision:** In `onPlanClick`, a **collapsed** selection (a tap) whose point hits a
  lit range — `threadAtPoint`, which re-locates ranges at click time and hit-tests the
  caret — sets a `focusThread` target the rail scrolls to and pulses. A **non-collapsed**
  selection (a drag) is left to the select-to-comment toolbar, untouched.
- **Why:** The Custom Highlight API never intercepts pointer events, so the click falls
  through to the underlying text — the tap/drag split is the only signal distinguishing
  "focus this thread" from "select to comment", and resolving it this way avoids a
  gesture clash. Ranges are re-located per click (never cached as live `Range`s) so the
  hit-test stays correct across revision re-renders. Hit-testing uses the standard
  `caretPositionFromPoint` with a WebKit `caretRangeFromPoint` fallback (the only one
  Safari ships).
- **Revisit when:** Touch devices want a distinct long-press gesture, or lit spans should
  carry a hover/focus affordance of their own rather than relying on the rail card pulse.

## UI tests that need the DOM typecheck under a dedicated DOM + bun config

- **Decision:** `src/ui/tsconfig.test.json` (the UI tsconfig plus bun's types) typechecks
  every UI `*.test.ts`; the root node config no longer includes them, and `bun run
  typecheck` runs it as a third pass.
- **Why:** `anchor.ts` re-locates quotes over real `Range`/`TreeWalker`/`querySelector`,
  so its unit test pulls the module into the typecheck and needs the **DOM** lib — which
  the node-only root config lacks. The UI config has the DOM lib but carries no `bun:test`
  types, so neither alone fits a DOM + bun test file; the dedicated config is their union.
  `bun test` only transpiles, so this gap was invisible until a UI test imported a
  DOM-dependent module — every prior UI unit test covered pure string logic.
- **Revisit when:** UI tests need jsdom/happy-dom globals registered process-wide (a bun
  preload), or the runner grows its own type story that subsumes this config.

## Optional H2 sections are linted-when-present, not a second required tier

- **Decision:** The linter's section list (`ORDERED_SECTIONS` in
  `src/daemon/linter/rules.ts`) grows an `optional` flag and stops being a flat required
  list. Optional sections (`## Contract` after Summary, `## Impact` after Decisions) sit at
  fixed positions in the canonical order; they are linted for budget/visual caps **when
  present** but never trigger `E_SECTION_MISSING`. The order check filters the canonical
  order to the sections actually present (`knownIds.filter(seen.has)`), so dropping an
  optional never trips `E_SECTION_ORDER`. Each carries its own line budget
  (`budgets.contractLines` 12, `budgets.impactLines` 10) and shares the existing
  per-read-path-section fence (1) and visual (2) caps — so an Impact section's dependency
  mermaid rides the one-fence allowance. The
  rejected alternatives were new *required* sections (ceremony on trivial plans) and
  block-types-inside-existing-sections (couples interface surface to Decisions/Phases).
- **Why:** The redesign's thesis is **review altitude** — lead with the contract and blast
  radius so the human reviews intent and risk, not steps. A trivial plan should not pay for
  a Contract section it doesn't need, and a complex one should be able to add one without a
  schema fork; optional-when-warranted is the only shape that serves both (q3). Threading
  `optional` through the existing order machinery (rather than a parallel code path) keeps
  the one ordering algorithm authoritative and means every existing plan still lints
  identically — the regression surface the broad lint tests guard. Placing Contract right
  after Summary matches the read order (what it *is* before why/how) and the §1 brainstorm
  flow (lead → contract → … → phases).
- **Revisit when:** A third optional section makes the fixed-position list unwieldy and a
  general "optional section registry" (id → budget → position) earns its keep, or optional
  sections want their own tier label in the normative/informative contract (§4) rather than
  inheriting read-path-normative. Impact sits after Decisions (the blast radius reads after
  the tradeoffs that chose it, just before the phases that act on it); its 10-line budget is
  tighter than Contract's 12 because a dependency list is terser than an interface surface.

## Behavioral assertions are a shared-tokenizer ```gwt fence under Verification

- **Decision:** Given/When/Then scenarios live in a ` ```gwt ` fence inside a phase's
  Verification, not as prose, a GFM table, or a new section (q7). The grammar lives in one
  shared module, `src/shared/gwt.ts` (`parseGwt`), imported by both the daemon linter
  (`rules.ts`, shape + scenario-count budget) and the UI scenario cards
  (`src/ui/plan/scenario-card.tsx`). The daemon line parser tokenizes the fence body **once**
  (calling `parseGwt` at parse time) and stores the resulting scenarios plus the active field
  as a `GwtBlock` (budget-exempt — it does **not** spend the phase's one-fence allowance), so
  the linter's three verdicts read one shared parse instead of re-tokenizing per check. A gwt
  fence inside a phase lands on that phase; a stray one in a non-phase section's read path
  (e.g. Summary) is captured on the *section* with a null field rather than silently counted
  as an ordinary budgeted fence — because the UI dispatcher renders **any** `gwt` fence as
  scenario cards regardless of location, so the linter must judge it everywhere or producer
  and consumer drift. The linter then errors on placement outside Verification
  (`E_GWT_PLACEMENT` — for a stray-section block too), an empty block (`E_GWT_EMPTY`), a
  scenario missing/disordering Given-When-Then (`E_GWT_MALFORMED`), and too many scenarios
  (`E_BUDGET_GWT`, default 6). The UI renders cards in `plan-view`'s block dispatcher (the
  fence reaches it as a `FenceBlock`, never `marked`), degrading to a plain fence if parsing
  yields no scenarios.
- **Why:** Scenario cards that *are* the approve checklist (Test-Driven Review) need a
  structured, machine-checkable shape — prose can't be linted, a table fights long clauses,
  a whole new section is ceremony for something that belongs to one phase's verification.
  A fence keeps the plan plain renderable markdown and inherits the existing budget-exempt
  treatment. The grammar is **new** (unlike the line grammar, whose daemon/UI duplication is
  deliberate per "Review screen renders via a ported line grammar"), so a single shared
  tokenizer is the simpler, drift-proof choice — the agent's required shape and the
  reviewer's rendered cards come from the same code. Exempting gwt from the one-fence cap is
  load-bearing: it is the verification surface, so making it compete with a phase diagram
  for the single fence slot would force a false choice. Keeping the keyword in the rendered
  clause text (inking only the label) preserves comment-anchoring onto a scenario line.
- **Revisit when:** Scenarios need richer structure (tables of examples, tags, data tables)
  that the line grammar can't carry, or reviewers want to *check off* individual scenarios
  on approve (state the linter/daemon would then have to persist), or gwt earns a place
  outside Verification (e.g. a Contract-level acceptance block).

## Lead diagram is a strongly-recommended nudge, not a required section

- **Decision:** A lead diagram is a ` ```mermaid ` fence in the existing `## Summary`
  section — not a new required section and not a forced one-line TL;DR (q6, D6). The
  daemon line parser counts mermaid fences per section (`Section.diagramCount`) and
  records an HTML-comment opt-out (`Section.leadDiagramOptOut`); a new advisory rule
  `checkL7` (`src/daemon/linter/rules.ts`) emits exactly one **warning**
  (`W_LEAD_DIAGRAM_MISSING`, rule L7) when Summary has no diagram and no opt-out — never
  an error, so it can never block a submit. The escape hatch is the directive
  `<!-- no-lead-diagram: <why> -->` in Summary, recognized by the parser and exempt from
  the line budget like a callout marker. The UI marks the Summary section `plan-lead` and
  inks its diagram as the first-screen figure (a 2px accent top rule); no reorder is
  needed, since Summary already leads the column and the diagram already follows the
  headline.
- **Why:** The redesign's first-screen goal (§1, §10) is "see the shape before the prose,"
  but a *mandated* diagram turns decorative — an auto-mermaid that restates the summary
  adds reading load (a named risk). Strongly-recommended-with-an-escape-hatch is the only
  shape that pushes the diagram rate toward ~90% without forcing a useless chart onto a
  trivial change. A warning (not an error) is what keeps the linter's "presence, never
  usefulness" honesty: the linter cannot judge whether a diagram helps, so it must not
  block on one. Reusing Summary rather than a `## Diagram` section keeps the schema spine
  unchanged and the diagram budget-free under the one-fence rule. Making the opt-out
  budget-exempt means declining a diagram never silently costs a Summary content line, so
  the agent is never nudged toward a worse headline just to dodge the nudge.
- **Revisit when:** Real plans show the nudge mis-firing (e.g. a Contract- or preamble-level
  diagram should satisfy it too), the ~90% target proves wrong, or a forced TL;DR /
  collapse-all altitude control earns its keep after all (both were considered and dropped
  — D6, D12).

## Approve & Implement: the same live agent orchestrates per-phase native subagents

- **Decision:** **Approve & Implement** keeps the planning agent on the line after
  approve and has *it* orchestrate the build — it commits the plan, opens a worktree,
  and walks the phases, spawning a fresh **native in-session subagent** (Task tool) for
  each phase's implement+test and a separate one for `/code-review --fix`. The
  orchestrator only coordinates and narrates (`otacon progress`); it does not write code
  itself. The rejected alternatives: a **detached fresh-spawn** that the daemon launches
  unattended (the old `spawn-sessions-from-web` plan, now removed), and a **daemon/SDK-
  driven** build.
- **Why:** Same-agent continuity means the builder already holds the full planning
  context and the grill rationale, with no handoff; per-phase subagents solve the "one
  long session degrades, gets lazy, stops following the plan" failure (DESIGN.md §1.4) by
  giving every phase fresh context while the orchestrator's own context stays lean. Native
  subagents are subscription-covered exactly like the parent, so the build keeps the
  zero-API-spend invariant (§13) the daemon-/SDK-driven option would break. The detached
  fresh-spawn bought phone-only/unattended runs but at the cost of a disconnected fire-and-
  forget process with no live reviewer in the loop — against otacon's whole identity of
  keeping you on the codec.
- **Revisit when:** Truly unattended phone-only builds become a real need (then the
  detached `snake` variant, DESIGN.md §14, comes back as a sibling, not a replacement), or
  native subagents stop being subscription-covered.

## Pause-and-ask on the FIRST blocked phase, no auto-retry

- **Decision:** When a phase is blocked — tests stay red, `/code-review` still flags, or
  a subagent is stuck — the orchestrator stops on the **first** blocker, posts an
  `otacon ask` (retry | skip | abort | guidance), parks in `wait`, and acts on the answer.
  It does **not** auto-retry a few times before surfacing. `/code-review` effort is a
  config knob, started moderate.
- **Why:** otacon's identity is keeping the human in the loop from the phone; max control
  beats max autonomy here, and surfacing immediately is the honest move for a tool whose
  point is review. Bounded auto-retry was the considered alternative (fewer
  interruptions), but it spends time and tokens guessing at a fix the human might resolve
  in one tap, and an auto-retry that "succeeds" by drifting from the plan is exactly the
  laziness the per-phase split exists to prevent. The moderate review effort keeps
  false-positive findings from turning into needless pauses.
- **Revisit when:** Real builds show the first-blocker pause interrupting too often on
  transient/flaky failures a single retry would clear (then a *bounded* retry-then-ask),
  or the review-effort default proves wrong.

## A distinct terminal `implement_failed`, not folding abort back to `approved`

> **Note (terminal is now reopenable):** See "Reopen a terminal session to amend
> it, keyed on the build worktree" below: terminal states are no longer strictly
> one-way. A finished session (`approved`/`implemented`/`implement_failed`) can be
> reopened back to `revising`. This does not change the terminal *set* or the
> open-verb guard; it only adds a reverse edge.

- **Decision:** An aborted/failed build lands in its own terminal status
  `implement_failed` (via `otacon implement-done --failed`), distinct from `implemented`
  and from `approved`. The terminal *set* is `{approved, implemented, implement_failed}`;
  `implementing` is non-terminal. **Provisional.**
- **Why:** The home card's status chip (D4) assumes a visibly-distinct failed state, and
  folding a failed build back to `approved` would erase that a build was attempted and
  abandoned — the card would read identically to a never-built approved plan, hiding a
  half-finished worktree/branch on disk the user still has to clean up. A separate state
  keeps "approved, never built" and "built, failed" legibly apart for both the chip and
  the open-verb guard.
- **Revisit when:** The terminal-state naming settles (it is flagged provisional in the
  plan's Open Questions) — e.g. if a single `done`/`closed` state with an outcome field
  proves cleaner than two sibling terminal statuses.

## Reopen a terminal session to amend it, keyed on the build worktree

- **Decision:** A finished (terminal) session can be **reopened** back to `revising`
  via `POST /api/sessions/:id/reopen`, instead of terminal being strictly one-way. The
  reopen pins the diff baseline at the approved revision (`lastReviewedRevision =
  revision`) and keeps `prUrl` + `impl` intact. To make this discoverable, the session
  records an **`impl` field** (`{worktree, branch}`, deterministic from the title slug +
  `worktree.dir`) the moment it flips to `implementing`, in the same registry write as
  the status flip. A later `/otacon` run from inside that worktree matches `impl.worktree`
  and reopens the same session.
- **Why:** After an Implement build, the user often needs to iterate on the implemented
  plan (fix a phase, adjust scope) without spawning a *second* otacon session and a
  second build worktree for what is the same piece of work. Reopening the same session in
  place keeps the plan history, transcript, threads, and PR link as one continuous
  record, and pinning the baseline at the approved revision means the next submit diffs as
  a clean amendment rather than re-surfacing the whole plan. Recording `impl` at
  **approve** time (not at build start) means detection survives an aborted build: even an
  `implement_failed` session knows its worktree, so a `/otacon` from there still finds and
  reopens it. The reverse edge is narrow (one explicit endpoint), so the terminal *set*
  and the open-verb guard (`E_SESSION_OVER`) are unchanged: terminal still means "over"
  for every implicit path; it just stops meaning "forever".
- **Revisit when:** Worktree paths stop being deterministic from the slug (e.g. a
  collision-suffixed worktree dir), or reopen needs to fan out to more than the
  build-worktree trigger (a UI "reopen" button, reopening a Save-approved session from an
  arbitrary checkout), at which point matching may need to persist more than `{worktree,
  branch}`.

## Build layout: worktree under .otacon, one commit per green phase, PR vs default branch

> **Superseded in part** by "otacon manages no `.gitignore`; build worktrees live in
> `~/.otacon`" below: the build worktree now defaults to `<worktree.dir>/<slug>` with
> `worktree.dir = ~/.otacon/worktrees` (outside the repo), not `.otacon/worktrees`. The
> per-phase-commit + PR-vs-default-branch parts are unchanged.

- **Decision:** The build runs in a git worktree at `.otacon/worktrees/<slug>`
  (gitignored, like the rest of `.otacon/`) on branch `otacon/impl-<slug>` rooted at the
  plan-doc commit; each clean+green phase is its own commit; the finish is a `gh pr
  create` against the repo's **default branch**, with a fall back to noting the local
  branch + path when there is no remote. `otacon clean` should prune the worktree and
  branch of a finished/aborted build.
- **Why:** A worktree isolates the build from the user's working tree (the planning
  session's checkout stays untouched), and putting it under the already-gitignored
  `.otacon/` needs no new ignore rule. Rooting the branch at the plan commit ties the
  implementation to exactly the approved artifact. Per-phase commits make the build
  legible and bisectable and give the pause-on-blocker flow a clean rollback point; the
  local-branch fallback keeps the loop working in a repo with no remote. **Open question:**
  per-phase commits vs a final squash, and whether the PR bundles the plan-doc commit, are
  not yet settled — easy to flip since they only affect the finish step, not the protocol.
- **Revisit when:** The commit-granularity / squash question is decided, builds want to
  target a non-default base branch, or worktree-under-`.otacon` collides with the build's
  own tooling.

## A successful build archives its plan via a PR commit; the agent owns the move

> **Superseded** by "Dropped the docs/plans archive step from the Implement loop" —
> the plan is no longer committed to `docs/plans/`, so there is nothing to `git mv`
> into `docs/plans/archive/`. The build branches off the default-branch HEAD and
> reads the plan from the home copy; no archive commit rides in the PR.

- **Decision:** On a successful Approve & Implement build, the implementing agent
  `git mv`s the committed plan `docs/plans/YYYY-MM-DD-<slug>.md` into `docs/plans/archive/`
  as a commit on the impl branch — so the move lands in the implementation PR. An aborted
  build (`implement-done --failed`) and a plain Approve (no `implement`) both leave the plan
  in `docs/plans/`. `otacon clean` is unchanged: it still never rewrites `docs/plans/`.
- **Why:** `docs/plans/` reads as a live backlog of not-yet-implemented plans, with shipped
  ones filed under `archive/` (matching the layout that was previously curated by hand).
  Doing the move as a PR commit makes archival **atomic with the merge** — if the PR never
  lands, the plan stays active on the default branch with no drift and no cleanup pass; and
  it keeps the daemon out of it (clean only ever touches gitignored working state, so the
  agent, which already holds the git worktree, is the natural owner of a committed-file move).
- **Revisit when:** A flat `archive/` grows unwieldy (consider per-month subdirs), or plain
  Approve should archive too (right now an un-built approved plan stays in `docs/plans/`).

## Unsent drawer drafts gate Approve client-side; Send & commit reuses the fold-in

- **Decision:** Drawer comments are browser-only until **Send all** flushes them, so a
  server-side approve cannot see them. Rather than block Approve or change a protocol the
  daemon never knew about, the gate is **client-side** (D5): when a commit variant is picked
  with `pendingCount > 0` unsent drafts, `ApproveDialog` enters a new `drafts` stage before
  any `postApprove` fires (D1). `pendingCount` counts only non-blank drafts, so a half-typed
  blank neither arms the gate nor poisons the flush. It offers **Send & commit** /
  **Discard & commit** / **Cancel**. **Send & commit** flushes the non-blank batch through a
  gate-local `flushDrafts` (`POST /comments`) that shares the drawer's "remove exactly what was
  sent" set but keeps its OWN busy/error channel: the dimmed drawer behind the approve scrim
  must not flash "sending…"/"send failed" for a batch its own Send never started, and blank
  drafts are skipped because the daemon 400s a whole batch with any empty body. On the 202 it
  approves with `{sendOpenComments, implement}`, folding the now-open threads in through the
  existing comment & approve hop in one click (D2), no redundant second warn. **Discard & commit** clears the local drafts then
  fires the plain variant. The gate fires *after* the variant pick and carries the same
  `pendingImplement` the warn stage uses, so Send/Discard inherit Commit Plan vs Commit &
  Implement (D3). A `beforeunload` guard, registered in `ReviewLoop` only while
  `pending.length > 0`, covers reload/close-tab; navigate-away and half-typed composer text
  stay out of scope (D4). The pure `approveMove(result, force)` translation is shared by the
  direct fire and the Send & commit path (and unit-tested) so both read a 409/finalizing/error
  the same way.
- **Why:** The silent drop was a real loss: staged comments the reviewer believed counted
  vanished when the session ended. A client-side gate keeps the fix where the state lives (the
  daemon has no browser drafts to reason about) and leans on two unchanged daemon paths, so the
  blast radius is the approve sheet plus the unload listener: no server, CLI, or schema move.
  Routing Send & commit straight into `{sendOpenComments}` (the q4 choice: one click, agent
  always addresses them) matches "these should count" without a double warn, and reuses the
  audited `## Review notes` fold-in rather than a parallel path. Once the flush lands the drafts
  are real OPEN threads (not lost), so a later approve *error* drops back to confirm with the
  reason shown (retry the commit, nothing to re-send); a residual 409, the rare case where the
  open comments were resolved out from under the flush before approve read them, re-asks on the
  warn stage instead. Scoping the unload guard strictly to staged drafts is what keeps
  `beforeunload` (browser-controlled copy, fires on every unload) from nagging a clean session.
- **Revisit when:** Drafts ever grow long-lived enough that a reload warning feels too weak
  (consider `localStorage` draft-persistence), or navigate-away / composer text join the
  silent-loss set the gate must cover.

## Distribution: public npm `otacon`; GitHub is contributor build-from-source only

- **Decision:** otacon ships as the unscoped public npm package `otacon`
  (`npm install -g otacon`); `files: ["dist"]` publishes the prebuilt artifact.
  `npm i -g github:zeroliu/otacon` is **not** a supported user path — GitHub install is
  documented (README "Build from source") only as a contributor flow: clone, `bun
  install`, run `./bin/otacon` from source, or `bun run build && npm link`.
- **Why:** The published tarball is prebuilt static `dist/` bytes, so `npm install -g`
  pulls no native or UI build deps and `npm update -g otacon` is the whole upgrade
  story (the version handshake restarts the daemon). A GitHub install would have to
  build on the user's machine — pulling the full vite/react/mermaid devtree through a
  `prepare`/postinstall step we deliberately did not wire — to turn `src/` into a
  runnable `dist/`. Reserving GitHub for contributors keeps the user path trivial and
  dep-light. (← grill q1, q7.)
- **Revisit when:** The npm name is squatted before first publish (fall back to scoped
  `@zeroliu/otacon`), or a build-on-install GitHub path becomes worth wiring.

## Release flow: local bump+tag+push, CI publishes on the tag

- **Decision:** `bun run release [patch|minor|major]` (`scripts/release.sh`) runs
  preflight gates (clean tree, default branch, test/typecheck/build), `npm version` to
  bump+commit+tag, then `git push --follow-tags` — it **never** publishes. The pushed
  `v[0-9]*` tag triggers `.github/workflows/release.yml`, which re-runs the gates and
  `npm publish`es from a clean CI checkout. `--dry-run` rehearses without mutating.
- **Why:** Splitting "decide to release" (local, no credentials) from "publish" (CI,
  OIDC trusted publishing) means no npm secret lives anywhere — not on a maintainer's
  machine, not in repo secrets — and every publish is a clean-room, reproducible build.
  Re-running the gates in CI before the
  publish step makes a red gate stop the publish; the tag-vs-`package.json` guard stops
  a mismatched version; npm rejecting a duplicate version makes a re-pushed tag a no-op.
  (← grill q2.)
- **Revisit when:** The release wants a non-default base branch. (Prerelease dist-tag
  publishing is now wired, see "Staging channel" below.)

## `package.json` is the single version source; `version.ts` is generated

- **Decision:** `package.json`'s `version` is authoritative; `src/shared/version.ts`
  (the `VERSION` the daemon version handshake reads) is generated from it by
  `scripts/gen-version.ts`, run by the `npm version` lifecycle hook (which also
  `git add`s the regenerated file). `version.test.ts` asserts the two stay equal.
- **Why:** A hand-maintained second copy of the version is a dual-write footgun — the
  mirror would silently drift from `package.json` and break the handshake's meaning. A
  generated mirror makes `npm version` the entire bump (one command, both files), and
  the equality test backstops the generator. Same generated-file discipline as the
  dogfood SKILL.md / protocol card. (← grill q3.)
- **Revisit when:** Another consumer needs the version in a form a flat constant can't
  provide.

## Ship `skillMd()` as a packaged file via build-time codegen

- **Decision:** The `build` chain runs `scripts/gen-skill-asset.ts` after `tsc` to
  write `skillMd()` into `dist/skills/otacon/SKILL.md`, shipped via `files: ["dist"]`.
  `packagedSkillPath()` (`src/cli/install/wrapper.ts`) resolves that file's absolute
  path from the installed package, or `undefined` when no stable copy exists (running
  from source, or an `_npx` ephemeral cache). A test asserts the shipped file equals
  `skillMd()`.
- **Why:** `otacon install` copies the wrapper text today, so it goes stale when the
  binary auto-updates. The fix is to SYMLINK the installed wrapper to a real in-package
  file, so a binary upgrade refreshes the skill for free. A symlink needs a stable
  on-disk target, but `skillMd()` is a function, not a file, so the build emits its
  output once. Source/npx paths are unstable (the source asset never exists; an npx
  cache may be pruned), so `packagedSkillPath()` returns `undefined` there and callers
  copy instead. Mirrors the gen-version pattern, with the same equality test as a
  backstop against the generator drifting from `skillMd()`.
- **Revisit when:** The symlink install path lands (later phases consume
  `packagedSkillPath()`), or a consumer needs the asset in a form the flat file can't
  provide.

## Self-heal installed wrappers on start (fallback + migration path)

- **Decision:** `otacon start` calls `refreshInstalledWrappers()`
  (`src/cli/install/wrapper.ts`) right after the auto-update gate: for every wrapper
  that is ALREADY installed at a managed location, it re-asserts the desired state via
  `ensureWrapper`: promoting a user-scope copy (or repairing a dangling/wrong-target
  symlink) to a symlink to the packaged file, and rewriting a drifted project-scope
  copy to the current `skillMd()`. It never creates a wrapper that does not already
  exist, never touches a foreign (unmarked) file, skips entirely on a source run, and
  is best-effort and fail-open (a refresh never blocks `start`); notices go to stderr.
- **Why:** Once the install path symlinks user-scope wrappers, a fresh `otacon install`
  is already correct, so the only installs that go stale on a binary upgrade are the
  ones that could not symlink in the first place: copy-fallback installs
  (Windows/npx), committed project copies, and legacy pre-symlink installs from before
  this landed. A reinstall would fix them, but users do not reinstall; piggybacking a
  re-assertion on `start` (which they run constantly) migrates those installs with zero
  user action, while staying a true no-op for the common correct symlink. It is skipped
  on a source run because this checkout's committed `otacon-dev` dogfood wrapper is
  generated and test-guarded, so a source-mode `start` must never rewrite it. It fires
  only on real drift (each wrapper is converged idempotently), and it heals only what
  it owns (the managed marker, or a symlink at our own location) so a hand-written
  SKILL.md is left alone. A project-scope rewrite **mutates the working tree** of the
  repo the agent is in (accepted by design): a committed project wrapper that drifted
  from the current protocol is stale and should be refreshed, and the change is an
  ordinary tracked diff the user can see and commit or discard.
- **Revisit when:** A project rewrite surprising a user (an unexpected working-tree
  change) becomes a real complaint (then: gate project-scope heals behind a flag or a
  prompt), or the fallback set shrinks to nothing because every install platform
  symlinks reliably (then this pass can become install-only).

## npm trusted publishing (OIDC), no stored token; provenance + SHA-pinned actions

- **Decision:** The release workflow publishes with `npm publish --access public` and
  **no npm token** — authentication is npm **trusted publishing** via the job's
  `permissions: id-token: write` OIDC token, against a Trusted Publisher (repo + the
  `release.yml` workflow file) configured once on npmjs.com. This needs npm CLI
  ≥ 11.5.1 / Node ≥ 22.14, so the workflow runs on Node 22 and `npm i -g npm@latest`.
  Provenance is attached automatically (still requires `package.json`'s `repository`
  field); every third-party action is pinned to a commit SHA. Because a Trusted
  Publisher can only attach to an existing package, the very first publish is a manual
  `npm publish` from a maintainer's `npm login` session (see RELEASING.md).
- **Why:** A long-lived `NPM_TOKEN` automation secret is the highest-value thing in the
  repo — it can publish at any time and must be rotated and guarded. OIDC removes it
  entirely: the credential is minted per-run, scoped to this repo+workflow, and expires
  immediately, so there is nothing to leak or rotate. The job still wields publish
  rights via `id-token: write`, so SHA-pinning every action stays essential — a moved
  tag could otherwise inject code into a run that can publish. Provenance gives
  installers a verifiable link from the tarball back to the exact repo + workflow run —
  supply-chain integrity for a package run with `-g`.
- **Revisit when:** npm supports configuring a Trusted Publisher for a not-yet-published
  package (removes the manual first-publish bootstrap), npm changes its OIDC/provenance
  contract, or a pinned action needs a SHA bump (update the SHA + its version comment).

## Staging channel: branch-detected `bun run release`, timestamp build id

Supersedes the prior staging design (a separate `bun run release:staging` /
`scripts/release-staging.sh` with a `staging`-branch *guard* and `npm version prerelease
--preid staging` `-staging.N` counter).

- **Decision:** Preview builds publish to a `staging` npm dist-tag from
  `-staging.<UTC timestamp>` prerelease versions. There is **one** branch-detected command:
  `bun run release [patch|minor|major]` (`scripts/release.sh`) inspects the current branch:
  on the default branch (`main`) it cuts a prod build exactly as before; on the long-lived
  **`staging`** branch it cuts a staging build; on any other branch it aborts (a `--dry-run`
  downgrades that to a warning). The staging build version is
  `<base-bumped-by-kind>-staging.<stamp>` where `stamp` is a numeric UTC timestamp
  (`date -u +%Y%m%d%H%M%S`) and the base is bumped by the kind (default `patch`;
  `minor`/`major` move the base line first), assembled by `scripts/staging-version.ts`. It
  runs `npm version <exact-version>`, which commits the bump **on the `staging` branch** and
  creates the `vX.Y.Z-staging.<stamp>` tag, then `git push --follow-tags`. The **same**
  `release.yml` workflow runs on the pushed tag (the existing `v[0-9]*` trigger already
  matches), derives the dist-tag from the version suffix (`-staging.` → `staging`, else
  `latest`), publishes `npm publish --tag <tag>`, and skips the GitHub Release for staging
  tags. Testers run `npm i -g otacon@staging` (newest) or `@0.1.4-staging.<stamp>` (pinned);
  re-cutting yields a newer (higher) timestamp that moves the dist-tag. The staging **base**
  is the version of `origin/<default-branch>` (remote main), resolved after a **required**
  `git fetch` (a real run aborts on fetch failure; a `--dry-run` warns and falls back).
  `release.sh` reads it from `origin/<default>:package.json` and passes it to
  `staging-version.ts` as the explicit `current` arg, so the TS stays pure (no remote
  knowledge). Reading the local (staging) package.json was the bug: the prior cut already
  committed a bumped `<core>-staging.<old>` there, so each re-cut stripped the suffix and
  bumped the staging core again (0.1.4 → 0.1.5 → 0.1.6). origin/main's package.json equals
  the latest prod tag by construction, so the base holds at the published prod line and only
  the timestamp advances on re-cut.
- **Why:** A dist-tag is npm's native opt-in preview channel: it never moves `latest`, so
  regular users are untouched, while testers point at `@staging`. Routing by version suffix
  inside the **one** existing workflow reuses the single npm Trusted Publisher (configured
  per workflow filename) with **zero new npm setup**; a second workflow file would need its
  own Trusted Publisher entry. A timestamp build id is **stateless, monotonic, and unique**:
  there is no counter to scan from prior tags or retain, and no reset when `main` advances.
  This is what makes it scale (and is why the earlier tag-counter design was rejected in
  review, since computing the next `-staging.N` means inspecting existing tags and the count
  resets relative to the base). Folding staging into the one branch-detected command (rather
  than a separate `release:staging` script that duplicated `release.sh`) reduces surface:
  one script, one set of guards. The build id stays **numeric** and uses the literal
  `-staging.` dot so the channel-aware auto-updater keeps working: `channelOf` keys on
  `/-staging\./` and `isNewer` orders staging builds by the digits in `/-staging\.(\d+)/`; a
  git SHA or a `-staging-` hyphen would break both. Keeping the bump commit on the `staging`
  branch keeps prerelease history off `main`. No GitHub Release for staging keeps the
  Releases page a clean record of shipped stable versions.
- **Revisit when:** Cadence needs CI-assigned build numbers (a build counter handed out by
  CI rather than a local timestamp), or sub-second cuts collide (two builds in the same
  second share a stamp, so extend the stamp to milliseconds), or a third channel is needed
  (e.g. `next` for release candidates) that justifies splitting into its own workflow +
  Trusted Publisher. (The CLI auto-updater is channel-aware, see "Channel-aware auto-update"
  below, so a staging install tracks `staging` rather than pinning `@latest`.)

## Channel-aware auto-update: derive the channel from the installed version suffix

- **Decision:** The CLI auto-update gate (DESIGN §16) is channel-aware. `channelOf(VERSION)`
  returns `staging` when the installed version carries a `-staging.` prerelease, else
  `latest`. The start-time gate (`maybeAutoUpdate`) and the standalone `otacon update`
  command both fetch the registry version for that channel (`fetchDistTag(channel)`, a
  generalization of the old `fetchLatest`, GETs `registry.npmjs.org/otacon/<tag>`) and run
  `npm install -g otacon@<channel>` (`runNpmUpdate(tag)`). `isNewer` became prerelease-aware:
  at an equal major.minor.patch core a clean build outranks any staging build (so a stable
  user is never offered a `-staging` build), and two `-staging.N` builds order by their
  numeric `N`; different cores are still decided by the triple, and a malformed input on
  either side is still `false`. The channel is derived purely from the version string: no
  new config key, no new state file. The split is intentionally binary (staging vs latest),
  not a general preid lookup.
- **Why:** A staging tester must auto-update staging→staging and never be silently pulled
  back to stable, while a clean install must keep its exact prior behavior (track `latest`,
  same messages, same install command). Deriving the channel from the version suffix
  reuses the one fact that already distinguishes the two installs, the published version,
  so there is nothing extra to set, persist, or keep in sync, and a re-exec'd child stays on
  the same channel automatically. Making `isNewer` prerelease-aware (rather than ignoring the
  suffix as before) is what keeps a stable user off staging builds at the same core and lets
  one staging build supersede an earlier one; for two clean versions it is byte-for-byte the
  old core-triple comparison, so the stable path cannot regress. A binary split avoids
  speculative machinery for channels that do not exist yet.
- **Revisit when:** A third channel ships (e.g. `next`), an install needs to switch channels
  without reinstalling (today the only way off staging is an explicit clean install), or
  arbitrary preids must be supported (generalize `channelOf` beyond the staging/latest split).

## Maintainer release steps live in RELEASING.md; README stays user-facing

- **Decision:** README documents only the install/update/use surface; the release
  runbook (npm token setup, `bun run release`, what CI does, verify, rollback) lives in
  RELEASING.md. DESIGN.md stays product behavior; this file records the why.
- **Why:** The README's audience is people installing and using otacon — release
  mechanics are noise to them and a maintenance liability mixed into onboarding prose.
  A dedicated runbook keeps the maintainer steps in one skimmable place without
  diluting the user-facing entry point. (← grill q4.)
- **Revisit when:** Releasing gets automated enough that the runbook shrinks to a single
  command worth folding back into a CONTRIBUTING doc.

## Graphic OTACON wordmark + brand accent shifted to the logo's lime

- **Decision:** The index masthead's mono text wordmark (`otacon`) is replaced by a graphic
  **OTACON wordmark** (`src/ui/otacon.svg`, the gear-as-O mark). The source export was a 3-D
  extruded mark with a dark-green halo over a full-bleed dark background and outline strokes;
  we ship only the flat light-green face silhouette (the dark halo/background + strokes
  stripped), transparent. It renders in the masthead via a CSS `mask` painted in `--accent`,
  so it inherits light/dark and per-session hue instead of baking a fixed color. The UI brand
  accent (`--accent`, `--accent-on-ink`, `--live`, and the `var(--hue, …)` default) moves from
  the old true-green (hue ~131–152°) to the wordmark's **lime** (hue ~82°). Semantic state
  colors (approved/added green, await amber, revise blue, fail red) are deliberately left on
  their own hues. The inline favicon's green is recolored to the wordmark lime to match.
- **Why:** The export's gradient halo and 3-D depth are visual noise that fight the flat
  hairline-telemetry aesthetic, and its lime green clashed with the UI's true-green accent.
  Stripping to the flat silhouette keeps the codec-instrument identity sharp; unifying the
  brand accent on the wordmark's own green makes the logo *be* the brand color rather than a
  foreign mark sitting on a different green. Painting the masthead instance through a mask
  (rather than an `<img>` of the baked `#d9fb9e`) keeps it legible on the light "warm paper"
  background, where the raw light-green would be too low-contrast. Keeping semantic colors
  separate preserves the meaning system (green = approved/success is distinct from brand).
- **Revisit when:** The lime accent fails WCAG contrast on any surface, the brand mark
  changes, or semantic green and brand lime are judged too close on a live screen.

## Doc audience split: README + docs/ are user-facing; DESIGN/DECISIONS/AGENTS are internal

- **Decision:** README and the `docs/` directory are otacon's user-facing documentation
  surface; `DESIGN.md` / `DECISIONS.md` / `AGENTS.md` are internal-facing. Installation is
  lean enough to live inline in the README (prerequisites + `npm install`, then the
  `otacon install` skill step in Get started); there is **no** `docs/INSTALL.md`. Only the
  phone how-to keeps a focused user doc, `docs/PHONE-ACCESS.md`.
- **Why:** A value-prop-forward ("revolutionize agentic coding review") README should not
  route users into an internal product spec — DESIGN.md is a timeless behavior spec for
  contributors, not an onboarding guide. But a dedicated install guide turned out to be the
  wrong cut: it filled up with implementation detail (managed-file write locations, marker
  semantics, the Stop hook merge) that no installing user needs, while the install a user
  *does* need is two commands. So install collapses back into the README happy path and the
  detail-heavy `docs/INSTALL.md` is dropped; phone access stays split out because it is a
  genuinely optional, multi-step setup. (← q3, q4.)
- **Revisit when:** Install grows enough genuinely user-facing steps (new platforms, auth,
  multiple runtimes) that the README happy path can no longer hold it, or a generated docs
  site replaces the hand-written `docs/`.

## Codex moves to a `.codex/skills/` SKILL.md folder; `InstallScope` seams in project install

- **Decision:** Codex's wrapper is the same managed `SKILL.md` as Claude/OpenCode,
  written to `$CODEX_HOME/skills/otacon/SKILL.md` at user scope and
  `<root>/.codex/skills/otacon/SKILL.md` at project scope. The old `~/.codex/AGENTS.md`
  marker-delimited block is fully deleted — `codexBlock()`, the `CODEX_BEGIN`/`CODEX_END`
  markers, `codexAgentsPath()`, and the generic `upsertMarkedBlock()` are all removed
  (no other caller). The three skill-path helpers (`claudeSkillPath`, `codexSkillPath`,
  `opencodeSkillPath`) now take an `InstallScope = { kind: "user" } | { kind: "project";
  root }`; `claudeHookScriptPath`/`claudeSettingsPath` stay user-only. Call sites pass
  `{ kind: "user" }` for now.
- **Why:** Codex now natively supports the cross-agent SKILL.md skill convention at
  `~/.codex/skills/` (and `.codex/skills/` per repo), verified against OpenAI's docs
  (June 2026) — so a uniform skill folder replaces the AGENTS.md special case, dropping
  the only marker-block machinery in the tree. No migration or cleanup of installed
  files is needed: the marker-block install was never shipped or used. `InstallScope` is
  the seam the subsequent `--project` flag turns on without re-plumbing every helper;
  introducing it now (with only the user branch wired) keeps that later change tiny and
  keeps each helper's user/project split in one place. Note the base asymmetry the type
  encodes: codex's user base is `$CODEX_HOME` (default `~/.codex`) while its project
  base is `<root>/.codex`; opencode's user base is `$XDG_CONFIG_HOME/opencode` while its
  project base is `<root>/.opencode` (each then `/skills/otacon/SKILL.md`).
- **Revisit when:** Codex's skills path convention changes, or project scope needs a
  destination layout the two-branch `InstallScope` can't express (e.g. a third scope).

## `--project` resolves to the git repo root, erroring outside a repo

- **Decision:** `otacon install --project` resolves its install base to the current
  git repo root via `findRepoRoot(process.cwd())` (the same `git rev-parse
  --show-toplevel` helper session resolution uses). Outside any git repo it is a hard
  usage error (exit 2: "otacon install --project must run inside a git repo; none found
  at <cwd>"), never a fallback to cwd or home. There is no `--dir <path>` escape hatch.
- **Why:** "Install into the current project" means the repo a teammate clones and the
  wrappers get committed to — the repo root is the only base where `<root>/.claude`,
  `<root>/.codex/skills`, `<root>/.opencode` land where each agent looks per-repo.
  Falling back to cwd on no-repo would silently scatter wrapper dirs into arbitrary
  subdirectories or non-repos that can never be committed as intended; erroring makes
  the misuse obvious immediately. Reusing `findRepoRoot` keeps repo-root resolution
  defined once. `--dir` was declined (q1) as surface for a rarer case.
- **Revisit when:** A real need appears to install wrappers into an explicit
  non-repo-root directory (then add `--dir <path>` as a separate base, not a fallback).

## Stop hook deferred at project scope; `--hooks --project` rejected

- **Decision:** The Claude Code Stop hook is **not** installed at project scope. A
  `--project` install writes only the inert skill wrappers — no `.claude/hooks/`
  script, no `settings.json` registration — and `--hooks --project` is a usage error
  (exit 2). The hooks report (`applyStopHook`/`offerStopHook`) is gated on user scope,
  so a project install neither offers nor checks the user Stop hook; the wrapper write
  itself drops the hook-script write/chmod when `scope.kind !== "user"`.
- **Why:** A committed `.claude/` is inherited by every teammate who clones the repo,
  including those without otacon installed. A skill wrapper is inert for them — the
  agent acts on it only when they actually invoke otacon — but a registered Stop hook
  is a turn-blocking command that would fire on every stop and fail (or hang) pointing
  at `otacon-stop.sh` they don't have. Deferring the project hook is precisely what
  keeps the committed `.claude/` a fail-safe rather than a footgun (q3); the hook stays
  a user-machine opt-in via `--hooks` at user scope. `offerStopHook()` also reads the
  user `~/.claude/settings.json`, which is meaningless for a project install — gating
  it on user scope keeps the project JSON honest.
- **Revisit when:** Claude Code gains a portable, fail-safe project hook mechanism
  (e.g. a `$CLAUDE_PROJECT_DIR`-relative command that no-ops when the script is
  absent), at which point a committed project hook could be reconsidered.

## `otacon doctor` checks project wrappers when in a repo; "otacon protocol skill" wording

- **Decision:** Each per-agent wrapper check in `otacon doctor` now passes against a
  list of candidate paths and is `ok` if the managed `SKILL.md` (file present AND
  containing `MANAGED_MARKER`) exists at any of them. The candidates are the user path
  always, plus — when `findRepoRoot(process.cwd())` resolves — the project path
  (`<root>/.claude/...`, `<root>/.codex/skills/...`, `<root>/.opencode/...`). The
  satisfying scope is named in `detail` (`<path> (project)` / `<path> (user)`); the user
  candidate is listed first, so when both exist user wins the report. A miss stays a
  `warn` (never a failure — wrappers are optional), reworded from "wrapper not installed
  at <path>" to "otacon protocol skill not found for <agent> (looked in <paths>); run
  `otacon install --agent <agent>`" plus ", or add --project to install it into this
  repo" only when a project candidate was in play. The node/daemon/Stop-hook/Tailscale
  checks are unchanged — they are user-machine concerns with no project scope.
- **Why:** After `otacon install --project` (Phase 2), doctor checking only `~/` would
  cry wolf — warn "not installed" while a perfectly good committed wrapper sits in the
  repo. Accepting either scope and naming which one matched makes doctor honest about a
  project install and tells the user where the live wrapper actually is. The wording
  change answers the reviewer's literal question — "what does 'wrapper not installed'
  mean" (q4): "wrapper" is otacon jargon, so the message now names the concrete artifact
  (the otacon protocol skill, the `SKILL.md` that `otacon install` writes), shows the
  exact paths it probed, and surfaces `--project` as the in-repo fix. Keeping the miss a
  warning preserves today's contract that wrappers for unused agents never fail the run.
- **Revisit when:** Agents gain more wrapper search locations doctor should accept, or a
  per-agent "expected scope" makes listing every candidate path too noisy.

## Home-canonical plan store keyed by session id

> **Amended** by "Session working state lives in the home store" and "Delete permanently
> removes the home session folder; no archive": `~/.otacon/sessions/<id>/` is now the
> per-session working dir too (not just the approved plan), and it is NO LONGER permanent:
> `otacon clean` and UI delete `rmSync` the whole folder. The session-id namespacing
> and always-write-the-home-copy parts below still hold; the "never touched by clean /
> permanent archive" part is retired.

- **Decision:** Every approved plan is written to the home store at
  `~/.otacon/sessions/<id>/YYYY-MM-DD-<slug>.md`, always, on both Save and Implement.
  The session id (a globally-unique hash) is the namespace, so plans from different repos
  never collide and need no repo-basename/hash prefix. `homeSessionsDir()`/`homeSessionDir(id)`
  build the paths. (Originally the home store was kept out of `otacon clean` as a
  permanent archive; that no longer holds, see the Amended note above.)
- **Why:** "Default zero footprint" (q1, q9) means the target repo gets nothing unless
  the reviewer chooses Save, but otacon still needs one canonical, always-present copy
  while the session lives, which the agent (on Implement) and the UI read back. The home
  store is that copy. Keying by the existing session id reuses a unique namespace we
  already mint (q11 leaned toward repo-basename+hash, but the id is simpler and already
  unique, t1). The durable, post-delete record is the Save copy under `plans.dir` (or the
  PR for Implement), not the home folder.
- **Revisit when:** The home store grows unbounded enough to want pruning/retention, or a
  user wants the canonical location configurable (today it is fixed).

## Approve = Save vs Implement; otacon never git-commits a plan

- **Decision:** The approve action has two outcomes, both honoring the existing
  `{implement?}` POST flag. **Save** (implement=false) writes the artifact to the home
  store AND a project copy under the repo's `plans.dir`; the session ends (`approved`).
  **Implement** (implement=true) writes the home copy only and flips to `implementing`;
  the agent builds from the home copy. The `approved` event carries `home` (absolute
  home-copy path, always) and `path` (project copy on Save; home copy on Implement).
  **otacon runs no git for the plan** — it only chooses where the file is written; the
  user commits the project copy themselves if they want it tracked.
- **Why:** The grill (q7, q8) collapsed the earlier two-knob model (`dir` + `commit`,
  with `git check-ignore` footgun guards) into one question otacon actually owns: *where
  is the plan written?* Whether it lands in git is the user's call, not otacon's — so
  every `git add`/commit path and the ignore-check downgrade logic disappear. Save vs
  Implement maps cleanly onto "I want the plan in my repo" vs "build it now from the
  home copy," and matches Claude Code's instinct that plans live in a home store, not the
  project tree, by default (q6). Keeping `home` on the event lets the agent/UI always name
  the canonical copy even on Save.
- **Revisit when:** A workflow needs otacon to commit (e.g. an unattended `snake` that
  must land a tracked plan), or Save/Implement need a third outcome.

## `plans.dir` config leaf (project copy location)

- **Decision:** One new `CONFIG_SCHEMA` path leaf `plans.dir` (default `.otacon/plans`,
  repo-relative) governs where **Save** writes the project copy. It renders in the
  Settings UI and resolves via `otacon config get plans.dir` for free, like
  `worktree.dir`. The home store location is NOT configurable. otacon writes the copy
  and leaves tracking to the user (it manages no `.gitignore`, see below), so the default
  lands a file under `.otacon/plans` the user can commit or leave alone; a team that
  wants it grouped with tracked plans sets `plans.dir=docs/plans` in the committed
  `<repo>/.otacon/config.json`.
- **Why:** Reusing the schema-driven config (single source of truth, guard test) means a
  one-line leaf gets validation, the Settings third scope, and the CLI lookup with no
  bespoke code (q6, q7). Making only the project-copy dir configurable — not the home
  store, keeps the canonical home copy predictable while letting each repo choose its
  in-project convention. The default `.otacon/plans` keeps the copy under otacon's repo
  config dir; `docs/plans` is the opt-in committed contract.
- **Revisit when:** A repo wants per-session or templated plan paths, or the home store
  location itself needs to move.

## Dropped the docs/plans archive step from the Implement loop

- **Decision:** The Implement loop no longer commits the plan, branches off a "plan
  commit," or `git mv`s the plan into `docs/plans/archive/`. It branches off the repo's
  current **default-branch HEAD**, reads the phases from the home copy at the event
  `path`, and the finishing PR carries no plan file. The skill card (`assets.ts`) and the
  regenerated dogfood `SKILL.md` reflect this; DESIGN §6/§12 drop the archive narrative.
- **Why:** With otacon never committing the plan (see Save vs Implement above) and the
  plan living in the home store on Implement, there is simply no committed plan in the
  repo to archive — the `git mv → docs/plans/archive/` step (q2) became dead. Branching
  off default-branch HEAD replaces "off the plan commit" because there is no plan commit;
  the home copy is the agent's source of truth for phases.
- **Revisit when:** A workflow wants the plan to ride in the implementation PR after all
  (e.g. teams that require the plan as a reviewed artifact in the same PR).

## otacon manages no `.gitignore`; build worktrees live in `~/.otacon`

- **Decision:** `otacon start` no longer reads, writes, or migrates the repo's
  `.gitignore` — the `ensureGitignore` step (and its `.otacon/*` + `!.otacon/config.json`
  append) is gone. Whether `.otacon/` is tracked or ignored is entirely the user's call;
  otacon special-cases nothing on git's behalf, so `config.local.json` and the Save-time
  `.otacon/plans` copy are committable unless the user ignores them. To keep throwaway
  build trees out of the project regardless, `worktree.dir` now defaults to
  `~/.otacon/worktrees` (a `~`/absolute path **outside** the repo, alongside the home
  sessions store) instead of the repo-relative `.otacon/worktrees`. This supersedes the
  selective-ignore mechanism of "Two-tier project config" (#178) and the
  worktree-under-`.otacon` location of "Build layout" above; the config *layering* and
  the per-phase-commit build are unchanged.
- **Why:** Editing a user's `.gitignore` is a surprising side effect for a planning tool,
  and the selective `.otacon/* / !config.json` pair was subtle, easy to get wrong across
  CRLF/blank-line/pre-existing-line cases, and coupled otacon to the user's VCS policy.
  Not touching the file at all is the least-astonishing default and lets each team decide
  what to track. The one thing that genuinely must not land in the repo is a build
  worktree (a full second checkout); moving its default out to `~/.otacon/worktrees`
  removes the only hard reason `.otacon/` had to be ignored, so dropping the ignore
  becomes safe. A literal `~` is fine: the value is only ever interpolated into a shell
  `git worktree add` the agent runs, where the shell expands it; nothing in otacon
  resolves it as a path internally.
- **Revisit when:** Users ask otacon to scaffold `.gitignore` again (e.g. an opt-in
  `otacon install` flag), or `worktree.dir`'s `~` needs expanding somewhere otacon
  consumes it directly rather than handing it to a shell.

## Auto-update: 1h throttle + registry fetch, both fail-open

- **Decision:** The `otacon start` update check (DESIGN §16) throttles to once per hour
  via a `$OTACON_HOME/update-check.json` cache (`checkedAt`), and discovers the latest
  version by a direct GET to `registry.npmjs.org/otacon/<tag>` with a 1.5s
  `AbortSignal.timeout`, not by shelling out to `npm view` (the tag is the install's
  channel; see "Channel-aware auto-update"). Every failure path is
  fail-open: a malformed/absent cache counts as "due" rather than wedging the check off,
  and any fetch error (network, non-200, bad JSON, missing version, timeout) resolves to
  `undefined` so the caller proceeds on the installed version. `update.auto` (default
  true) is the only opt-out — no env var, no CI auto-skip. (Plan
  `docs/plans/2026-06-19-auto-update-outdated-version.md`, D3/D4/D5.)
- **Why:** A network round-trip on every start would tax the common case for a check
  that rarely changes anything; the 1h window keeps starts fast while still catching a
  release within the hour. A raw registry GET avoids spawning npm just to read a version
  (faster, no subprocess, easy to time-bound and mock in tests). Fail-open everywhere
  keeps the update path strictly additive — a flaky registry, an offline machine, or a
  corrupt cache can never block or slow a session, which is the whole point of running
  the check before any session exists.
- **Revisit when:** Releases need to propagate faster than an hour (shorten/parameterize
  the window), the registry endpoint or its JSON shape changes, or users want an env-var
  / CI auto-skip opt-out in addition to `update.auto`.

## Auto-update: re-exec at start, fail-open, never sudo

- **Decision:** When `otacon start` finds a strictly newer published version it runs
  `npm install -g otacon@<channel>` (the install's channel; see "Channel-aware
  auto-update") and then **re-execs** itself —
  `process.execPath [process.argv[1], "start", ...argv]` with `OTACON_UPDATED=1` — and
  exits with the child's status (`maybeAutoUpdate` never returns on this path). The
  re-exec reproduces the user's original flags exactly, so the new CLI mints the session
  and its `ensureDaemon` version handshake restarts the stale daemon; no separate
  daemon-update code exists (D7/D9). `OTACON_UPDATED=1` is the loop guard that stops the
  re-exec'd child from running the check a second time (D8). The check runs only at
  `start`, before any session exists, and the gate order is: loop guard → source-tree
  skip → `update.auto` → 1h throttle → fetch → `isNewer`. The throttle cache is stamped
  with `checkedAt: now` **before** the update is attempted, so a failed update still
  throttles the next hour rather than hammering npm. On ANY npm failure (non-zero exit,
  spawn ENOENT, non-writable global dir) otacon prints the manual `npm install -g
  otacon@latest` command and proceeds on the installed version — it **never escalates to
  sudo** (D1). (Plan `docs/plans/2026-06-19-auto-update-outdated-version.md`, D1/D7/D8.)
- **Why:** `start` is the one safe place to swap the binary — nothing is in flight, so a
  re-exec can hand the whole command to the new code without corrupting a live session.
  Re-exec + inherited stdio means the freshly-installed CLI (not the stale parent) prints
  the single JSON line, keeping the start contract intact, and reusing the existing
  version handshake means the daemon converges for free. Fail-open-never-sudo matches
  Claude Code's behavior and keeps auto-update strictly additive: a read-only global dir
  degrades to a notice instead of a prompt or a hang. Stamping the cache before the
  attempt guarantees a broken release can't turn every start into an npm install storm.
- **Revisit when:** A standalone `otacon update` command is wanted for manual/forced
  upgrades, a non-npm global install path needs supporting, or the re-exec needs to
  carry more than the `start` argv (e.g. a flag added to `start` that must survive the
  hop — it already does, since the full argv is forwarded).

## Auto-update: open tabs self-heal via a version in the SSE snapshot

- **Decision:** An update restarts otacond under any open review tabs, but a tab keeps
  running the JS bundle it already loaded — whose content-hashed lazy chunks (the plan
  renderer, mermaid) 404 against the rebuilt `dist/ui`. So the daemon stamps its
  `VERSION` onto every SSE `snapshot` frame (index and per-session, `src/daemon/ui.ts`),
  the Vite build bakes the same version into the bundle (`__OTACON_VERSION__` via
  `define`, `src/ui/vite.config.ts`), and `maybeSelfHeal` (`src/ui/self-heal.ts`),
  called from the snapshot handlers in `src/ui/api.ts`, reloads the tab once when the two
  differ. The reload is guarded by a `sessionStorage` key keyed to the **target** (the
  daemon's) version, set before reloading, so a version that can't converge reloads at
  most once and never loops. A snapshot rides the stream's open (and every EventSource
  reconnect, since there is no event-id replay), so a tab re-learns the version right
  after the restart. The review screen's renderer error boundary is the reactive
  backstop: it auto-reloads once per tab on a vanished chunk, then falls back to a manual
  "Reload" link. (Plan `docs/plans/2026-06-19-auto-update-outdated-version.md`, D10/D11.)
- **Why:** Without this, an open tab silently wedges the moment it next fetches a lazy
  chunk after an update — exactly the case auto-update makes common. The version already
  rides a frame the tab receives on every (re)connect, so no new endpoint or poll is
  needed; comparing it to the baked-in build version is a one-line, dependency-free check.
  The fix is forcing the reload, not changing caching: `index.html` is already served
  `no-cache` and the hashed assets `immutable`, so a reload fetches the fresh shell and
  its new chunks. Keying the guard to the target version (not a plain "reloaded" flag) is
  what makes a non-converging mismatch (CLI updated, daemon pinned, or vice versa)
  safe — it reloads once for that target and then sits still. The proactive version path
  is primary; the boundary's auto-reload is a belt-and-braces for a chunk that vanishes
  without a version frame arriving to trigger the proactive path.
- **Revisit when:** Snapshots stop being the universal reconnect carrier (e.g. event-id
  replay is added, so a reconnect might not re-deliver `version`), the SPA gains routes
  with no SSE stream that also need to self-heal, or a smoother in-place hot-swap (no full
  reload) becomes worth the complexity.

- **Decision:** `otacon update [--check]` (`src/cli/commands/update.ts`) is the manual/forced
  upgrade command, and it deliberately bypasses both suppressors of the start-time
  auto-update gate: the 1h throttle and the `update.auto:false` config. It shares
  `runNpmUpdate` (`src/cli/update.ts`) with `maybeAutoUpdate` so the install behavior is
  byte-identical, still fails open on a registry blip (`latest:null`, exit 0), refuses on a
  source checkout, and never escalates to sudo. After a successful install it does NOT call
  `ensureDaemon` to restart the daemon. (Plan `docs/plans/2026-06-19-auto-update-outdated-version.md`, D12.)
- **Why:** The throttle and `update.auto` exist to keep the *implicit*, every-start check
  cheap and pinnable; an *explicit* `otacon update` is the user asking for the upgrade right
  now, so honoring those gates would be surprising (a pinned shop still wants `otacon update`
  to work; a check 10 minutes ago should not make it a no-op). Extracting `runNpmUpdate`
  keeps the one mutating side effect in a single tested place rather than duplicating the
  spawn. Skipping the post-install daemon restart is correctness, not laziness: after
  `npm install -g`, the currently running process is still the OLD code, so its `VERSION`
  equals the running daemon's — `ensureDaemon` would detect no mismatch and could not pull
  the new version. The real restart (and the open tabs' self-heal) happens on the next
  `otacon` invocation, which runs the new binary and trips the version handshake. Reporting
  that plainly beats claiming a restart that did not occur.
- **Revisit when:** A non-npm install path is supported (so the "global package" assumption
  and the source-checkout refusal need rethinking), or `otacon update` should also be able to
  restart the daemon in-place to the new version without waiting for the next command (e.g. by
  re-exec'ing the freshly-installed binary the way `maybeAutoUpdate` does).

## Session nav shortcut: `[`/`]` walk the active sessions (mounted on the app shell)

- **Decision:** `[` steps to the previous session and `]` to the next, over the `active`
  list (the activity-ordered, non-over set, i.e. the exact sidebar / session-sheet order,
  §7), wrapping at both ends. The single `useSessionNav` mount lives on the **app shell**
  (`src/ui/shell.tsx`) — the one element present on every route — not on the switcher, so the
  shortcut is live everywhere (welcome / settings / review), not review-screen-only. The
  "don't steal keys from a focused text field" rule is a single shared guard,
  `isTypingTarget` (`src/ui/review/session-nav.ts`), which the session-screen keydown handler
  also calls instead of its old inline tag/contentEditable check.
- **Why:** `[`/`]` were free (j/k jump changed sections, c/q comment/ask) and read as the
  conventional prev/next pair, so they don't collide with the existing verbs or fight muscle
  memory; modified chords are left alone so Cmd+[ / Cmd+] stay browser back/forward.
  Navigating the `active` set (not the full registry) means the keyboard walks exactly what
  the eyes see, in the same order, with no surprise stops on hidden over sessions. The mount
  moved from the switcher to the shell when the shell became the persistent frame: keeping it
  there would have left it review-only and would have competed with the shell's own list, so
  there must be exactly one mount and the shell is the natural home. Collapsing the two copies
  of the typing-guard onto one `isTypingTarget` keeps the nav hook and the c/q/j/k handler
  from ever disagreeing about what counts as "typing".
- **Revisit when:** The navigable set should differ from the visible list, or wrap-at-ends
  becomes more annoying than convenient (clamp instead).

## L8 diagram check: headless render, not a heuristic

- **Decision:** The submit-time diagram gate (L8, `src/daemon/diagrams.ts`) verifies each
  `mermaid` fence by actually running mermaid's parser in a headless happy-dom DOM, not by
  a pure string/syntax heuristic. `mermaid` and `happy-dom` are accepted as runtime
  dependencies of the otherwise-thin CLI for this.
- **Why:** A heuristic can only approximate what mermaid accepts; running mermaid itself is
  faithful by construction — what passes L8 is exactly what the UI's renderer will accept,
  because it is the same parser. The cost is dependency weight (mermaid + happy-dom, ~tens
  of MB) on a CLI that otherwise carries almost nothing, which we accept because a
  diagram that renders blank in front of the human reviewer is precisely the failure the
  review loop exists to prevent.
- **Revisit when:** The dependency weight starts to hurt install time or footprint enough
  to matter, or a lighter mermaid-equivalent parser (no DOM) becomes available.

## L8 uses `mermaid.parse()`, not `mermaid.render()`

- **Decision:** The gate calls `mermaid.parse()` (syntax validation) rather than
  `mermaid.render()` (full SVG layout).
- **Why:** `parse()` needs no SVG layout, so it runs robustly headless. `render()` relies
  on `getBBox()` for layout, which happy-dom stubs to 0 — that produces false failures on
  diagrams that would render fine in a real browser. The tradeoff is that `parse()`
  validates syntax, not layout: a syntactically valid diagram that lays out badly still
  passes L8. The UI's own "failed to render" fallback remains the backstop for that
  residual case.
- **Revisit when:** A headless layout engine faithful enough to trust `render()` exists, or
  layout failures (valid syntax, broken layout) show up often enough to need server-side
  catching.

## A broken diagram is a blocking submit error, not a warning

- **Decision:** An unrenderable fence is an `error` (`E_DIAGRAM_UNRENDERABLE`) that 422s the
  submit, merged into the same response shape as the structural linter — not a warning the
  agent may ignore.
- **Why:** It joins the existing fix-and-resubmit loop, which is the machinery that
  guarantees nothing broken reaches review. A warning would let an unrenderable diagram
  through to the human, which is the exact outcome the check exists to prevent. Running it
  alongside `lint()` and merging errors means the agent gets structural + diagram failures
  in one pass, fewer round-trips.
- **Revisit when:** Diagram-render failures prove common enough on valid-looking input that
  blocking is more annoying than the dead-diagram it prevents.

## L8 fails open on headless-setup failure

- **Decision:** If the headless mermaid setup itself can't be stood up (bad import, missing
  DOM globals, init throw), `validateDiagrams` returns `[]` — no L8 errors — rather than
  block the submit.
- **Why:** A diagram that won't render is a nuisance; a linter that won't let anyone submit
  is a brick wall. A mermaid- or DOM-side infra problem should degrade to today's behavior
  (no diagram check), never wedge every submit in the repo. The setup promise is also
  cleared on failure so a later submit can retry rather than being poisoned permanently.
- **Revisit when:** A way exists to distinguish a transient setup blip from a permanent
  break, so a hard break could be surfaced loudly instead of silently skipping the check.

## Worktree-keyed resume: detect by stored `impl.worktree`, match in the resolver, own verb

- **Decision:** A `/otacon <request>` run from inside an Implement build worktree reopens
  the SAME finished session to amend it rather than starting a new one. Three coupled
  choices make that work: (1) the owning session is found by the `impl.worktree` recorded
  on the registry entry when the build was approved (not recomputed from the slug at
  resume time); (2) `resolveSession`'s implicit default now matches an active session by
  repo root OR build-worktree root, so once a session is reopened to `revising` every
  command (submit, wait, ask, ...) resolves it from inside the worktree even though its
  `.repo` is the main repo where planning happened (no per-command changes); (3) reopening
  is its own verb, `otacon resume`, not an overload of `otacon start`.
- **Why:** The stored worktree is authoritative: the agent stands in the worktree, but the
  session's `.repo` is the main repo, so a repo-root match alone would always miss, and
  recomputing the path from the slug would drift the moment the slug, worktree base, or
  branch naming changes. Matching in the single resolver (one lever) keeps every verb
  worktree-aware without touching submit/wait/ask, which already route through
  `resolveSession`. `resume` stays separate because `start` mints + registers a brand-new
  session: folding "reopen the old one" into it would make `start` guess from the cwd
  whether the user meant fresh or amend, exactly the kind of unrecoverable wrong-plan guess
  the resolver refuses elsewhere. `otacon status` surfaces the candidate (`resumeCandidate`)
  over ALL sessions, not the repo-scoped list, for the same `.repo` ≠ worktree reason.
- **Revisit when:** Build worktrees can host more than one session at a time (the
  `worktreeOwners` length>1 refusal would need a smarter tiebreak), or `start` grows a flag
  that should also reopen (so the two verbs reconverge).

## Resume bootstrap: agent-judged relatedness + a terminal confirm, and amend-in-place

- **Decision:** The protocol card teaches the agent, before `otacon start`, to check
  `otacon status` for a `resumeCandidate` and decide whether to amend the finished plan
  or plan fresh. The decision is the agent's: it reads the candidate plan, and if the
  request is clearly unrelated it just starts fresh; if related (or it is unsure) it asks
  the user in the terminal whether to resume and amend or start new. That terminal
  question is the single, explicit exception to the "every question goes through
  `otacon ask`" rule. On resume the build **amends in place**: it reuses the existing
  worktree and `otacon/impl-<slug>` branch, builds on top of the existing commits scoped
  to the phases this revision changed, and pushes to update the SAME PR rather than
  opening a second worktree, branch, and PR.
- **Why:** Relatedness is a judgment the daemon cannot make (it would need to read the
  request and the plan), so the card hands it to the agent, which already has both. A
  silent auto-resume would risk amending the wrong plan from a stale cwd; a silent
  auto-fresh would throw away the in-place amend whenever the user actually wanted it, so
  a one-line terminal confirm (the only point with no session open to route an `ask`
  through) splits the difference cheaply. Amend-in-place keeps a revised plan's code on
  the branch the original PR tracks, so a reviewer sees one evolving PR instead of two
  competing worktrees, branches, and PRs for the same feature, and the existing commits
  stay as history.
- **Revisit when:** The relatedness call wants tooling (an `otacon`-side hint or a
  similarity check) instead of pure agent judgment, or amendments need to diverge onto a
  new branch/PR (a large pivot that should not pile onto the original PR).

## Live-activity stream: daemon-side, ephemeral, JSONL (not the JSON activity feed)

- **Decision:** The automatic, cross-agent live-activity stream is a separate
  append-only **JSONL** file (`~/.otacon/sessions/<id>/stream.jsonl`), distinct from the existing
  `activity.json` feed. It holds normalized `StreamEvent`s (the daemon assigns a
  monotonic per-session `seq`, redacts + truncates every event before storing), is
  capped by rewriting to the newest N only when it overflows, tolerates corrupt lines by
  skipping them (never quarantines the whole file), and is ephemeral working state —
  never archived to the home store. `otacon progress` notes land in this stream as
  `highlight` events *in addition to* the legacy `activity.json` feed.
- **Why:** The stream is a high-frequency, append-heavy surface (future phases tail an
  agent's transcript), so JSONL's cheap per-line append beats the whole-file
  rewrite-on-every-write that the small `activity.json` feed uses — and a single torn or
  hand-edited line should cost one line, not the whole stream (so line-skip, not the
  JSON files' quarantine-the-file recovery). It stays a *separate* file from
  `activity.json` because the draft chip still reads `latestActivity` from the feed (a
  small, capped, human-shaped list) and changing that store's shape/cap would churn an
  unrelated, load-bearing surface; routing `progress` into both keeps the chip working
  while the new stream becomes the single normalized activity record. Daemon-side
  normalization (redact + truncate + label) is mandatory and shared so no capture source
  can leak a secret or a 5 KB body into a review screen. Ephemeral because it is live
  telemetry about *how* a plan was built, not part of the approved artifact.
- **Revisit when:** The stream needs to survive into the archived plan (then it must move
  to the home store and gain a retention policy), the capture volume outgrows
  rewrite-on-overflow capping (then rotate by file segment), or the activity feed and the
  stream converge enough that the draft chip can read the stream directly and
  `activity.json` can be retired.

## cwd+recency transcript discovery (no per-agent hook dependency)

- **Decision:** The tailer discovers a coding agent's live transcript by *locating* it
  on disk — the freshest transcript file whose recorded working directory equals the
  session's repo root — not by any hook, env handshake, or cooperation from the agent.
  Each agent's `TranscriptAdapter.locate(repoRoot)` owns the format-specific search
  (e.g. the Claude adapter encodes `repoRoot` into `~/.claude/projects/<dash-encoded-cwd>/`,
  picks the newest `.jsonl` there by mtime, and confirms the match by reading the file's
  recorded `cwd`). The registry tries adapters in order; the first with a located handle
  wins, and **no match returns `null`** — the session then runs only on the manual
  `otacon progress` floor. Both `locate` and `parse` are fail-soft: a throwing `locate`
  counts as no match, and a malformed/vanished transcript is skipped, never fatal.
- **Why:** A hook or wrapper would require installing into every agent and would break the
  moment an agent is launched outside otacon's wrapper (the common case — otacon is "drive
  it from your Bash tool", not a launcher). The transcript already exists on disk for any
  agent worth supporting, so reading it needs zero buy-in and works retroactively for a
  session that started before otacon attached. Matching on the *recorded cwd* (not just the
  dir-name encoding) is authoritative and tolerant: the encoding is lossy (a literal `-` in
  a path is indistinguishable from a separator), so the recorded cwd disambiguates and
  guards against a stale/foreign transcript in a colliding directory. Recency (mtime)
  picks the *live* session when a repo has several historical transcripts. The hard `null`
  floor is the graceful-degradation guarantee: an unsupported agent loses automatic capture
  but never the manual progress feed, and a new agent is one adapter + one registry line
  away — no change to the daemon, the pipeline, or the UI.
- **Revisit when:** An agent has no on-disk transcript (then that adapter needs a different
  capture path — a hook or an API), two live sessions share one repo root and must be told
  apart by more than recency (then `locate` needs a stronger key than cwd+mtime, e.g. a
  session id handshake), or transcript formats churn often enough that fail-soft skipping
  hides real capture gaps (then add a per-adapter health/coverage signal).

## Live activity is an always-on now-playing bar, not a buried collapsible fold

- **Decision:** The review screen surfaces the live-activity stream as a slim, always-on
  "now-playing" bar pinned under the sticky header that expands into a full console. It
  replaces the old `<section className="activity">` collapsible, which was default-closed,
  rendered only once a plan existed, and easy to miss. The bar is shown whenever the agent
  is active OR any stream event exists (so it appears during pre-plan research, not gated on
  `hasPlan`); the console starts collapsed and the user expands it via the toggle (see the
  later "console starts collapsed" entry, which superseded the original
  auto-expand-on-`draft`/`implementing` behavior). The bar carries a `live`/`notes` **mode badge**,
  reading `live` once any captured (tool/text/thinking) event exists and `notes` while only
  `highlight` progress notes do, making the adapter-attached-vs-floor distinction (§10a)
  visible.
- **Why:** "What is the agent doing right now?" is the exact question a reviewer asks while
  waiting through research and drafting, and the old fold answered it only if you knew to
  open it. An always-visible one-liner answers at a glance with the firehose one click away;
  pinning it under the header (sticky, just below z20) keeps it a fixed instrument while the
  plan scrolls. Showing it pre-plan is the whole point: that is when the wait is longest and
  the old fold (gated on a plan) showed nothing. The mode badge is cheap honesty: without it
  a `notes`-only session looks identically "quiet" to a broken adapter, so the badge tells
  the user whether rich capture is even attached. Thinking is hidden behind an off-by-default
  toggle because it is the noisiest kind and would drown the concrete tool/text activity; the
  Thinking *filter* force-shows it (selecting it is strong intent). Newest-at-the-bottom with
  pin-aware auto-scroll matches a terminal's mental model and never yanks a user reading
  history. Pairing a running event with its outcome and same-label run-collapsing ("Read ×5")
  keep a dense captured stream legible instead of a thousand-row wall.
- **Revisit when:** The bar's "latest meaningful event" heuristic misleads on some agent's
  label vocabulary (then the now-playing selection needs per-kind weighting, not just
  "skip trailing thinking"), the 500-event client cap proves too small for a long
  `implementing` build's console (then window/virtualize the row list rather than render the
  capped tail), or a future surface needs the stream off the review screen (then the
  now-playing/console pair lifts out as a standalone component over the same `useSession`
  field).

## The now-playing console starts collapsed and no longer auto-expands (2026-06-23)

- **Decision:** The expanded live console now defaults to collapsed and never auto-expands.
  The original behavior (above) opened the console automatically on `draft`/`implementing`
  and re-applied that default on every status crossing; that is removed. The console opens
  only when the user clicks the toggle, and that choice sticks for the life of the session.
  The one-line now-playing bar and its toggle button are unchanged: the bar is still always
  shown while there is activity.
- **Why:** Users found the auto-expanded console noisy. The always-on one-line now-playing
  bar already signals activity at a glance, so the full firehose does not need to be forced
  open. The status-crossing auto-open also trapped or overrode a manual choice (collapsing a
  console the user had opened, or reopening one they had closed) whenever the phase changed,
  which felt like the UI fighting the user.
- **Revisit when:** Users report missing the live build firehose during long `implementing`
  runs (then consider an opt-in "auto-expand while implementing" preference rather than a
  hardwired default, so the choice is the user's, not the status machine's).

## The console's fold/select logic is a pure module; its components are thin views

- **Decision:** All non-trivial console behavior lives in `console-model.ts` as pure,
  React-free functions: pairing a tool `running` event with its later `ok`/`error` outcome,
  collapsing consecutive same-(kind,label,tool) runs into a counted row, the kind filter plus
  thinking toggle, the `live`/`notes` mode, and the now-playing label/timer/dim selection.
  They are exhaustively unit-tested in `live-console.test.tsx` with `bun:test`. The React
  components (`now-playing.tsx`, `live-console.tsx`, `console-rows.tsx`) own only chrome,
  toggles, and scroll behavior.
- **Why:** This mirrors the existing `group.ts`/`group.test.ts` (rail grouping) and
  `compact.ts` (header scroll state) split. The repo carries no React test renderer
  (no `@testing-library`), and its DOM tests use happy-dom only for low-level Range work
  (anchor.test.ts), never component rendering. Pushing the logic into a pure module makes the
  required behavioral assertions testable directly and fast, with no rendering harness to add:
  a running Bash call yields its label plus a running flag plus a timer, and a noisy
  repeated-read-plus-thinking stream collapses the repeats, hides thinking, and narrows under
  the filter. (Also: `src/ui/tsconfig.json`'s test exclude was widened from `**/*.test.ts` to
  also cover `**/*.test.tsx`, since the new test is the repo's first `.tsx` test and
  `bun:test` files must compile only under the bun-typed `tsconfig.test.json`.)
- **Revisit when:** The components grow logic worth asserting through real rendering (then
  add `@testing-library/react` plus a happy-dom register, and the pure split stays as the fast
  inner layer), or a second surface needs the same fold so the model gains a non-UI consumer
  (it already takes plain `StreamEvent[]`, so that is a lift, not a rewrite).

## `otacon progress` stays as the universal floor + curated highlights

- **Decision:** Now that the transcript tailer (§10a) auto-streams a supported agent's
  tool calls, text, and thinking to the now-playing console, `otacon progress` is *not*
  retired. It is reframed to two roles: (a) the **universal floor**, the one activity
  signal that works on ANY agent, including the long tail with no transcript adapter
  (hermes, pi, gemini-cli, and whatever ships next), where it is the *only* thing keeping
  the now-playing bar alive; and (b) occasional **curated highlights / chapter markers**
  (milestones, phase boundaries, "what I'm about to do next") that read as emphasized
  dividers in the console. The managed wrapper (`assets.ts`) and DESIGN.md §6/§10 ask for
  it SPARINGLY on supported agents (the firehose covers routine work) but still require it
  on the floor. The verb, the `POST /progress` endpoint, the `highlight` stream event, and
  the activity feed are all unchanged; this is a guidance reframe, not an API change.
- **Why:** Auto-capture is per-agent and optional by construction (cwd+recency discovery,
  one adapter per agent, `null` floor), so a signal that depends on it can never be
  *universal*, and the floor is exactly what guarantees every agent shows *something*.
  Retiring `progress` would strand every adapter-less agent on a dead bar and throw away a
  cheap, zero-API, human-authored highlight track that no transcript can synthesize (the
  agent saying "I'm about to do X" before it does). Reviewer noise from the firehose is the
  real concern auto-capture introduced, but that is handled in the *display* (run-collapsing,
  the thinking toggle, the now-playing "latest meaningful event" pick, §10a), not by
  suppressing capture or leaning back on manual narration. Telling the agent to narrate
  every step on top of the firehose would double-report routine work; telling it to stop
  narrating entirely would blind the floor; "sparingly, but always on the floor" is the
  only framing that holds for both the supported and the unsupported agent.
- **Revisit when:** Every agent otacon targets has a transcript adapter (then the floor is
  vestigial and `progress` could collapse to highlights-only), or auto-capture grows a
  reliable cross-agent fallback (an API/hook handshake) that removes the adapter-less long
  tail this floor exists for.

## Codex adapter: walk the date-partitioned rollout tree; map the real `exec_command` shape

- **Decision:** The Codex `TranscriptAdapter` locates by recursively walking
  `$CODEX_HOME/sessions/` (default `~/.codex/sessions/`, CODEX_HOME-aware), collecting every
  `rollout-*.jsonl`, sorting newest-first by mtime, and returning the first whose leading
  `session_meta.payload.cwd` equals the repo root. It does **not** derive a per-repo
  subdirectory the way the Claude adapter does. `parse` reads the envelope
  `{ timestamp, type, payload }` and maps only `type:"response_item"` payloads: `reasoning`
  → thinking (flattening `summary[].text`; encrypted-only reasoning yields nothing),
  assistant `message` → text (user messages skipped), `function_call`/`custom_tool_call` →
  a `running` tool event, `function_call_output`/`custom_tool_call_output` → its `ok`/`error`
  outcome (error inferred from a non-zero exit code or `success:false` in a JSON output,
  else ok). Shell tools (`exec_command` and the older `shell`) render as `Bash: <command>`,
  pulling the command from `arguments.cmd` (a string) or a `command` array (unwrapping a
  `bash -lc <script>`); `apply_patch` renders as `Edit <file>` when a path is recoverable.
- **Why:** Codex's on-disk layout is date-partitioned by session start (`<YYYY>/<MM>/<DD>/`),
  not keyed by cwd like Claude's dash-encoded project dirs, so there is no cheap directory to
  jump to — the recorded `session_meta.cwd` is the only authoritative repo key, and reading it
  per candidate (newest-first, short-circuiting on the first match) is the correct and still
  cheap discovery. Inspecting real rollouts on disk showed the *current* Codex CLI diverges
  from the older documented shape: the shell tool is `exec_command` with a string `arguments.cmd`
  (not the `shell` tool with a `["bash","-lc",…]` array), reasoning is frequently
  `encrypted_content`-only with an empty `summary`, and `function_call_output.output` is usually
  plain text rather than a JSON envelope. The adapter handles both the documented and the
  observed shapes defensively so it survives version churn, and emits nothing (not a noisy
  empty event) for encrypted-only reasoning. Mapping the running call and its outcome as two
  appended events preserves the append-only store invariant the pipeline already relies on.
- **Revisit when:** Walking the whole sessions tree per `locate` becomes a hot path on a
  machine with thousands of historical rollouts (then index by mtime/most-recent-day first, or
  cache the meta-cwd scan), Codex moves the session cwd off the leading `session_meta` record,
  or a future Codex build encrypts assistant/tool content too (then capture needs an API or a
  decrypt path, not transcript reading).

## OpenCode adapter: tail the local SQLite store read-only, not the `opencode serve` stream

- **Decision:** The OpenCode `TranscriptAdapter` reads OpenCode's **local on-disk storage**,
  not its `opencode serve` HTTP event stream. On a real install (storage migration 2) that
  storage is a **SQLite database** at `$XDG_DATA_HOME/opencode/opencode.db` (default
  `~/.local/share/opencode/`), *not* the documented `storage/{session,message,part}/*.json`
  tree — most session data now lives in the DB and only `session_diff/*.json` remains as
  loose files. `locate` opens the DB **read-only** (Node's built-in `node:sqlite`, zero new
  npm deps) and runs `SELECT id FROM session WHERE directory = ? ORDER BY time_updated DESC`
  to find the freshest session whose recorded cwd is the repo root, encoding the resolved
  session id into the handle path as `<db>#<sessionId>` (the `TranscriptHandle` has only a
  `path`). `parse` queries `part WHERE session_id = ? AND time_created >= watermark ORDER BY
  time_created`, maps `data.type` `text` → text, `reasoning` → thinking, and `tool` → a
  `running` event plus, when `state.status` is `completed`/`error`, a SEPARATE `ok`/`error`
  outcome event. Tool labels mirror the Claude verbs over OpenCode's lowercase tool names
  (`bash` → `Bash: …`, `read`/`edit`/`write` → `Read/Edit/Write <file>`, `grep`/`glob`,
  etc.). The whole adapter is fail-soft: a missing `node:sqlite`, a locked/absent/corrupt DB,
  or a torn `data` JSON is swallowed and the session falls to the floor.
- **Why:** The HTTP stream would require otacon to spawn and own a long-lived `opencode
  serve` process per repo — exactly the extra-process, cooperation-required coupling the
  Claude/Codex adapters were designed to avoid (they read files the agent already writes,
  no daemon of the agent's needed). Reading the same on-disk store the agent already
  persists keeps the file-based, no-extra-process, read-only model uniform across all three
  adapters and survives the agent not running a server at all. Inspecting a real install
  showed the *current* OpenCode keeps that store in SQLite, not the older JSON-file tree, so
  the adapter reads the DB directly rather than globbing a `part/` directory that no longer
  exists. `node:sqlite` is a built-in (no dependency, no native build) and we open it
  read-only so we never touch the agent's DB.
- **Cursor — watermark, not byte offset.** The JSONL adapters advance a byte `offset` into a
  growing file; a SQLite source has no such offset (rows are inserted and tool parts are
  *mutated in place* as a tool settles). So the OpenCode cursor leaves `offset` unused and
  carries a high-water `time_created` watermark plus the set of part ids emitted *at exactly*
  that watermark. Each `parse` asks for `time_created >= watermark` (`>=`, not `>`, so a part
  inserted in the same millisecond as the prior frontier is not missed), skips any id already
  in the tie set, emits the rest in `time_created` order, then advances the watermark to the
  newest time seen and resets the tie set to just the ids at that new frontier — bounded to
  the frontier, never the whole session. The tailer round-trips this carry untouched, exactly
  as it does the byte offset, so a dir/DB-tree adapter drops into the same poll loop with no
  tailer change. A part re-surfaced by a later `time_updated` bump (its tool finishing) is
  *not* re-read by this watermark — that is acceptable: a tool's outcome detail is a nicety,
  not a correctness requirement, and re-emitting the running event would violate append-only.
- **Freshest-by-`time_updated`.** `locate` returns the session with the newest
  `time_updated` for the cwd, which is the one being actively worked — the right target for a
  live tailer, even though a cwd with a long history can carry many *empty* abandoned
  sessions whose `time_updated` is older. (Observed on a real install: the newest session for
  a repo was an empty 0-part shell; the session with content was a few seconds older. That is
  fine — an active session accrues parts as work happens and stays the freshest; a dormant
  repo with only empty sessions has no activity to capture and runs on the floor regardless.)
- **Revisit when:** OpenCode reverts to (or also writes) the loose JSON-file tree and we want
  to support both shapes; or `node:sqlite` is unavailable on a runtime otacon must support
  (it is Node-22+; under bun the test runner lacks it and the adapter degrades to the floor —
  fine for the daemon, which ships as `node dist/daemon/main.js`, but it means OpenCode
  capture needs a Node ≥ 22 daemon); or we decide the streamed tool *outcome* matters enough
  to also watch `part.time_updated` (then the cursor needs an updated-watermark dimension and
  a dedupe of the already-emitted running event).

## `revised`/`prior` on re-answer events

- **Decision:** Overwriting an already-answered grill question stamps the queued `answer`
  event with `revised:true` and `prior` (the previous answer's content, no `answeredAt`);
  a first answer omits both fields, leaving its event shape byte-for-byte unchanged.
- **Why:** Re-answering already overwrote the stored answer silently, so an agent that had
  cited the old value in a Decision (`← q<n>`) had no signal to reconcile. Carrying the
  prior content on the event lets the agent treat the new answer as a correction and
  rewrite the affected entries; making it additive keeps every first-answer consumer
  untouched.
- **Revisit when:** Reconciliation needs more than the prior value (e.g. a full answer
  history), or the daemon should drive the rewrite rather than hand it to the agent.

## App shell: a persistent frame replaces the list-page / detail-page split

- **Decision:** Every route renders inside one `AppShell` (`src/ui/shell.tsx`): a left
  sidebar (wordmark home-link, settings, collapse toggle, live `SessionList`)
  beside a content track holding the routed screen. `app.tsx` resolves the route to a screen
  and returns `<AppShell>{screen}</AppShell>` — the chrome lives outside the route switch.
  The old index page is gone; `/` is now a welcome pane in the track.
- **Why:** Before the shell, the session list lived only on `/` and the only way to switch
  was the review header's switcher or a trip home — the list vanished the moment you opened a
  plan. A persistent sidebar keeps the whole queue one click away from anywhere (review,
  settings, welcome), which is the model every multi-item review tool converges on, and gives
  the `[`/`]` shortcut a single always-mounted home. Wrapping at the `App()` level (not inside
  each screen) means the chrome is written once and can't drift between routes.
- **Revisit when:** A route needs to escape the shell (a full-bleed surface), or the shell
  grows enough that a real router earns its keep over the hand-rolled one.

## Fixed left column + centered content, not a third review-grid column

- **Decision:** The shell is a two-track grid (`240px minmax(0, 1fr)`); the review content
  keeps its own centered `.page-review` measure and the existing two-column
  `.review-main` + `.rail` layout *inside* the content track. The sidebar is not a third
  column of the review grid — `.app-content` only sets `min-width: 0` so the inner page keeps
  centering, and touches nothing about its max-width or the rail.
- **Why:** Folding the session list into the review grid would have entangled two unrelated
  layouts — the rail sticks at `top: 60px` under the review header, the sidebar sticks at
  `top: 0` over the full viewport, and they collapse at different breakpoints. Keeping the
  shell a layer *outside* the content lets the welcome and settings panes reuse the same
  centered `.page` with zero review-specific CSS, and leaves the review layout (and its
  sticky offsets) exactly as shipped.
- **Revisit when:** The content track needs to react to the sidebar's presence beyond simple
  reflow, or a full-width review surface wants the rail and sidebar to share a grid.

## Sidebar ↔ mobile threshold at 960px (above the review grid's 721px)

- **Decision:** The sidebar shows at `≥960px` and is hidden below it; the review grid's own
  one-column → two-column switch stays at its existing `721px`. So 721–959px is a band where
  the review screen is two-column (main + rail) but the sidebar is still hidden and the ☰
  overflow-menu sheet is the session-switching face.
- **Why:** A 240px sidebar plus the ~720px reading measure plus the rail needs more room than
  the rail alone — reusing 721px would have crushed the content the moment the sidebar
  appeared. 960px is the conventional "comfortable three-zone desktop" line and leaves the
  reading measure intact once the sidebar lands. The sub-960 band is covered by the ☰ sheet
  (which replaced the interim header switcher — see "Retire the switcher…"), so nothing is lost
  there.
- **Revisit when:** The sidebar/content widths are tuned enough to move the threshold, or the
  sheet ↔ sidebar handoff wants a different crossover than the chrome's 960px line.

## Collapsible sidebar, persisted in localStorage

- **Decision:** The desktop sidebar collapses to a one-column content view via a `«`/`»`
  toggle; the flag persists per-device in `localStorage` (`otacon-sidebar-collapsed`, key
  set only when collapsed), default expanded. The pure `read/writeSidebarCollapsed` helpers
  tolerate an absent or throwing store (return the expanded default, never throw), and
  `useSidebarCollapsed` seeds from the read and writes through on toggle
  (`src/ui/sidebar-state.ts`).
- **Why:** A reviewer who wants maximum reading width shouldn't re-collapse on every reload,
  so the choice persists — and it's a pure view preference the daemon has no business
  knowing, so it lives in the browser like the unread badges (seen.ts) and the renderer-reload
  guard, with the same "storage may be hostile" guard. Defaulting to expanded means a
  first-time visitor sees the session list, not a mystery handle.
- **Revisit when:** The collapse state should sync across devices (it would move to daemon
  config). The remembered-width follow-up is now its own decision below.

## Drag-resizable sidebar, width persisted in localStorage

- **Decision:** The desktop sidebar's width is reader-adjustable: a `role="separator"` handle
  on its right edge drags the column (pointer + ←/→ keyboard, persisted), bounded to
  `[200, 480]px`, default 240. The grid track reads a `--sidebar-width` custom property set
  inline on `.app-shell`; the width persists per-device in `localStorage`
  (`otacon-sidebar-width`) via `read/writeSidebarWidth` + `clampSidebarWidth` in
  `sidebar-state.ts`, which clamp on both write and read so a stored value from a wider
  monitor can never widen the column past the current max, and tolerate an absent / throwing
  store like the collapse flag.
- **Why:** Reviewers split between wanting long titles legible (wider) and wanting maximum
  reading measure (narrower); a fixed 240px served neither well, and collapse is too blunt (all
  or nothing). It is a pure per-device view preference the daemon has no business knowing, so
  it lives in the browser beside the collapse flag, with the same hostile-store guard. The
  clamp bounds keep the reading column + threads rail from being crushed at the wide end and
  the rows readable at the narrow end. A fixed-position handle at `left: var(--sidebar-width)`
  tracks the boundary without a wrapper, and escapes the sidebar's own `overflow-y` scroll.
- **Revisit when:** The width should sync across devices (move to daemon config), or the
  resize wants snap points / a double-click-to-reset affordance.

## Retire index-screen.tsx in favor of welcome + sidebar

- **Decision:** `src/ui/index-screen.tsx` is deleted. Its two roles split: the session list
  became the sidebar's `SessionList` (Phase 1), and its `/` role became `welcome.tsx` — the
  empty-state copy (lifted verbatim, offline hint included) when the registry is empty, a
  short "pick a session from the sidebar" prompt otherwise.
- **Why:** Once the sidebar owns the live list on every route, a separate index page would be
  a second, divergent copy of the same list that only shows on `/` — exactly the kind of
  duplicate surface the shared `partitionByApproval` / `stateOf` split exists to prevent.
  Collapsing it to a thin welcome pane leaves one list implementation and a `/` that orients
  rather than re-lists. Below 960px the sidebar is hidden; the welcome pane reaches the list
  through the shell's ☰ overflow-menu sheet (see "Retire the switcher…"), so `/` is never a
  dead end on a phone.
- **Revisit when:** `/` should carry more than a welcome (a dashboard / activity overview), or
  a mobile list surface distinct from the sidebar/sheet is wanted.

## Index stream is shared via a provider (one `/api/stream` per client)

- **Decision:** A single `SessionsProvider` at the React root (`main.tsx`) owns the one
  `/api/stream` EventSource and the registry state; `useSessions()` is a context read that
  returns the same `{ sessions, connected }` shape it always did. Every face — the app shell,
  the sidebar `SessionList`, the mobile session sheet's `SessionList`, the welcome pane, the
  settings repo picker — reads that one stream. The hook throws if used outside the provider (a
  wiring bug, caught loud at the root, not a silent fallback to a second stream).
- **Why:** `useSessions()` used to open its own EventSource per call, so a single review route
  ran three concurrent index streams (shell + sidebar list + switcher) and the welcome route
  three (shell + sidebar list + welcome) — each one replays the full snapshot and gets every
  fan-out frame, multiplying the daemon's per-client SSE cost for identical data. The
  persistent app shell made this strictly worse by adding an always-mounted consumer on every
  route. Hoisting the connection into a provider collapses N duplicate streams to one with no
  behavior change (same snapshot-first sync, same self-heal, same EventSource auto-reconnect)
  and no call-site change beyond wrapping the root once.
- **Revisit when:** A consumer needs a *filtered* or differently-scoped registry view (it
  would select off the shared state, still one stream), or the provider's single state object
  causes spurious re-renders broad enough to warrant splitting `sessions` from `connected`.

## Retire the switcher for one session list reached by an overflow-menu sheet (<960px)

- **Decision:** `src/ui/switcher.tsx` is deleted. Below 960px the session list is no longer a
  per-review header strip (a `<select>` + accent chips that only existed on an open plan) but
  the same `SessionList` the sidebar uses, surfaced through an **overflow menu**: a ☰ "show
  sessions" button opens a bottom-docked sheet (scrim, `useScrollLock`, `--kb-inset`, dismiss
  on row tap / scrim tap / Esc / route change). The ☰ button lives in the review header on a
  plan; the welcome / settings panes instead carry a slim shell mini top-bar (wordmark +
  settings gear), and the home route renders the list inline below 960px (see "Mobile home
  renders the session list inline"), so the list is reachable from **every** route. The shell hosts the one sheet and
  publishes its opener through `SessionSheetContext` (the review header is the shell's
  `children`, so context beats threading a prop down); the open/close logic is a pure
  `shouldCloseSheet` / `isDesktopWidth` unit (`session-sheet-state.ts`, tested) and the React
  skin is `session-sheet.tsx`. At ≥960px the sheet is never opened — the sidebar is the list,
  and the `»` collapsed-sidebar handle is the equivalent "show sessions" control, sharing the
  affordance's intent so mobile and desktop read as the same control.
- **Why:** The switcher and the sidebar were two divergent renderings of the same active-session
  set — exactly the duplication the shared `partitionByApproval` / `stateOf` split exists to
  kill — and the switcher only appeared on a review screen, so the welcome and settings panes
  had **no** way to the list below 960px (a real gap, not just redundancy). Reusing the one
  `SessionList` in a sheet collapses both surfaces to a single list implementation and closes
  the gap on every route. A sheet (not the desktop sidebar slid in) keeps the mobile face a
  thumb-range, scrim-backed surface consistent with the composer / section-menu / approve
  sheets already in the review UI, and pulling the breakpoint/route-change decision into a pure
  function lets the strand-open-across-resize and close-on-navigate rules be tested without a
  render (the same split as `nextCompact` / `keyboardInset`).
- **Revisit when:** The list grows a mobile-only affordance the sidebar lacks (search, sort,
  multi-select) and the sheet needs its own list variant, or the sheet should become a fuller
  navigation drawer (settings / docs links beside the sessions) rather than just the list.

## Drop the browser↔daemon link dot from the sidebar header

- **Decision:** The `LinkState` "link" dot is removed from the app shell sidebar header; the
  header row is now just the wordmark (left) plus the settings gear + `«` collapse toggle
  (right). The dot is kept only in the review header's status row, beside the status chip and
  the agent-presence dot, where it reads in context. The `LinkState` component and the
  `connected` flag are unchanged (the welcome pane still uses `connected` for its offline hint).
- **Why:** A persistent green dot in the top-left chrome, present on every route, read as a
  generic "online" light and competed with the agent-presence dot for the same "is it live"
  meaning — two pulsing dots that mean different things (browser↔daemon link vs agent on the
  line) are more confusing the more prominent the weaker one is. The link is rarely down on a
  local daemon, and when it matters (an open review) the review header still shows it next to
  the signals it belongs with. Folding the header to wordmark + actions also makes room for the
  one-row furniture layout.
- **Revisit when:** The shell gains a non-local / remote daemon mode where the link genuinely
  drops often, and a global connectivity indicator earns its place back.

## Mobile home renders the session list inline (not a welcome prompt)

- **Decision:** Below 960px the `/` welcome pane renders the live `SessionList` (the condensed
  cards) inline instead of the "pick a session" prompt; the prompt is desktop-only (where the
  sidebar already holds the list). A shared `useDesktopWidth()` hook (`viewport.ts`, off the
  same 960px media query the shell + sheet use) picks the face. The mobile mini top-bar carries
  the wordmark + settings gear (no ☰); the ☰ overflow sheet is now a review-screen affordance.
- **Why:** With the sidebar hidden on a phone, a `/` that only said "open a session from the
  sidebar" pointed at a list the phone couldn't show — the home route felt broken. The home
  screen has always been the session index on a phone, so rendering the cards there restores
  that and makes the list the page rather than something hidden behind a menu that duplicates
  it. Settings stays reachable through the mini-bar gear (the prior gap where the mini-bar's ☰
  reached the list but nothing reached settings). One `SessionList` still backs all three
  placements (sidebar, sheet, inline), so there is no divergent mobile list.
- **Revisit when:** The phone home wants more than the list (a dashboard / activity overview
  above it), or the inline list and the sheet diverge enough to warrant separate components.

## The Interview panel is the single grill surface; the pinned queue is removed (2026-06-23)

- **Decision:** The "agent on the line" pinned card queue (`GrillQueue`, rendered
  above the plan) is deleted. The collapsible **Interview** panel is now the only
  grill surface: two labeled zones, each ordered oldest-first (q1 -> qN, the
  order the questions were asked), an "open" group on top where unanswered
  questions are answered inline (the same interactive card the queue used) and an
  "answered" group below, with a divider between them when both are non-empty.
  Answering, undo, and the deep-link flash all happen in the panel. (The zones
  were originally newest-first; the reviewer asked for ask-order so live questions
  read q1, q2, q3 down the panel - see `orderZones` in `interview.tsx`.)
- **Why:** With both surfaces live, an answered card was duplicated (once settled
  in the queue and again in the Interview panel), so a reviewer saw the same Q&A
  twice and had to learn two layouts that did the same thing. One surface is
  clearer, removes the per-mount "did this card settle here or only in the panel?"
  ambiguity that the old `watched` set existed to manage, and keeps the interactive
  card (its look and one-tap answer flow) the user already likes, now in a single
  place.
- **Revisit when:** Users want live questions pinned above the plan again (e.g. an
  open question that must not be missed while reading a long plan deep below the
  fold), at which point a pinned mirror of the panel's open zone could return.

## Answered interview cards hide the option list, revealing it only on undo (2026-06-23)

- **Decision:** An answered card in the Interview panel shows ONLY the answer
  (the chosen choice(s) and/or free text), with no full list of the options that
  were offered. The chips reappear only when the reviewer clicks **undo**, which opens
  the `AnswerForm` in edit mode prefilled with the current answer.
- **Why:** undo is the only reason to see the other options (to pick a different
  one), so an always-on option list is redundant: it adds a row of dead chrome to
  every settled card and competes with the answer for the eye. Hiding it keeps the
  answered zone a quiet, scannable record (question + what you said), and the undo
  control already advertises that the options are one tap away.
- **Revisit when:** Reviewers need to see the offered options at a glance without
  entering edit mode (e.g. to judge whether the agent framed the choice well), at
  which point a collapsed-by-default "options offered" disclosure could return.

## The Interview panel auto-expands during draft and collapses after, keyed on draft only (2026-06-23)

- **Decision:** The panel is default-expanded while the session status is `draft`
  (the grill phase) and auto-collapses the moment the status leaves `draft`. The
  crossing is ref-guarded so it fires only on the transition, leaving a manual
  toggle to stick within a phase; a decision citation (or the ❓ jump) still opens
  it regardless of phase.
- **Why:** During the grill the panel IS the action surface, so it should be open
  without a tap; once drafting/review begins the plan is the focus and the answered
  transcript is reference material that belongs folded away. Keying on `draft`
  alone matches the grill phase exactly and is derivable from the live `session`
  frame, with no new state to persist or keep in sync.
- **Revisit when:** Questions asked in later phases (review-time grilling) need the
  panel to auto-open too, at which point the trigger would key on "an open question
  exists" rather than on the `draft` status.

## The managed wrapper has a hard implementation gate before `implement:true` (2026-06-24)

- **Decision:** The protocol card now explicitly forbids project file edits,
  formatting, code-modifying commands, and implementation work until `wait` returns an
  `approved` event with `implement:true`. Before then, the wrapper permits only otacon
  loop commands, read-only research, and session plan/resolution files; if the agent
  violates the gate, it must stop and ask whether to revert or keep the changes.
- **Why:** Agents can otherwise treat a user request like "fix this" as ordinary
  implementation approval after starting an otacon session, using otacon only as a
  progress stream. The product contract is review-before-build: approval is represented
  by the daemon event, not by the initial user wording.
- **Revisit when:** Agents provide a native enforceable pre-edit permission hook for
  otacon sessions, or the CLI gains a daemon-side lease that can block write-capable
  phases until the review UI sends Implement.

## The wrapper teaches tree-shaped content as a mermaid diagram, by prose (2026-06-24)

- **Decision:** The protocol card's `## Visuals` block now tells the agent that
  hierarchy- or tree-shaped content (a taxonomy, a doc or file structure, a nested option
  space, a state hierarchy, a decision tree) should be drawn as a `mermaid` diagram, not
  a monospace nested outline in a `text` fence. It ships as prose guidance, not a
  tree-detection lint rule; the agent picks the diagram type (`graph TD` by default).
- **Why:** The renderer already supports and validates `mermaid` trees (budget-exempt,
  L8-checked), so the gap was purely guidance: agents reached for indented monospace
  outlines that force the reviewer to reconstruct the shape line by line. A lint
  heuristic for "this text is a tree" is too fuzzy to be reliable, and a hard rule would
  block legitimate plain-text fences; prose in the card is the lowest-cost lever that
  moves the behavior without false positives.
- **Revisit when:** Agents keep shipping monospace-outline trees despite the guidance, at
  which point a soft lint nudge (warning, never blocking) on indented-outline fences in
  read-path sections is the next step up.

## A 12px type-scale floor, enforced by a unit guard (2026-06-24)

- **Decision:** The React UI's stylesheet honors a hard type scale: 12px floor for the
  mono telemetry labels (`--fs-label`), 14px norm for readable and interactive text
  (`--fs-body`), 16px for the prose reading column (`--fs-prose`). Nothing renders below
  12px, text or glyph; icon-only controls keep an adequate hit box. The three sizes are
  CSS custom-property tokens defined once, and `src/ui/styles.test.ts` reads styles.css
  and fails if any `font`/`font-size` declaration specifies a px size below 12.
- **Why:** Legibility. The earlier "hairline telemetry" sizing let labels and icon
  glyphs fall as small as 9px, which is hard to read and a poor tap target. This revises
  only the sizes: the codec character now comes from mono plus uppercase plus tracking
  plus color, not from sub-12px size, so the look holds while the floor lifts. The guard
  keeps a future edit from silently reintroducing a sub-12px literal.
- **Revisit when:** The codec density needs rebalancing (e.g. a denser desktop layout
  wants a smaller label tier), at which point the tokens and the guard's floor move
  together.

## A 5-role semantic type scale (2026-06-25)

- **Decision:** The three size tokens (`--fs-prose` 16 / `--fs-body` 14 / `--fs-label`
  12) are replaced by a fully wired 5-role semantic scale, assigned by READING ROLE
  rather than by mono/sans visual treatment: `--fs-meta` (12px) labels and telemetry,
  `--fs-ui` (14px) controls plus monospace code and diff, `--fs-body` (16px) primary
  reading content, `--fs-title` (18px) headings, `--fs-display` (22px) the one masthead
  title and the big phase numeral. Size follows reading role, so the same content reads at
  the same size whether it is set in sans or mono. All five roles are now in use:
  - Headings take title: card titles, phase names, grill questions, and markdown h1/h2
    (h3/h4 stay body), each keeping its own weight and tracking.
  - The masthead session title takes display and is the one element that compacts,
    shrinking display→title on scroll and on the phone, never below a heading size; the
    big phase numeral takes display and does not compact.
  - Icon-only glyph BUTTONS that need presence take title (the section ⋯ menu, the gear,
    the ☰ hamburger, the sidebar « collapse and » expand handles); small inline status
    glyphs take meta (the tally mark, the grill star); text controls take ui (the
    dropdown menu item, the phone-bar tally button, the drawer whole-word toggle).
  - Reading content that historically wore the mono telemetry treatment is promoted into
    the body tier and switched to the sans face where it is prose: the anchored comment
    quotes (composer/pending/thread) and the empty-rail copy now read as body-16 sans,
    while their accompanying slugs/ids/timestamps stay meta-12 mono. Genuine
    labels/ids/timestamps/chips/badges/eyebrows are NOT promoted.
  The 12px floor still holds, and the scale is now the single source of truth for size:
  outside the `:root` token block(s), NO `font`/`font-size` declaration carries a px size
  literal: every size is a `var(--fs-*)` token or an intentional `max(12px, …)` inline
  clamp. `src/ui/styles.test.ts` carries four guards: the 12px floor, the exact-five-token
  scale (retired names `--fs-prose`/`--fs-label` must never reappear and `--fs-body` must
  stay 16), the em-relative `max(12px, …)` clamp on sub-1em sizes, and a final guard that
  the font SIZE position outside `:root` is always a token or a `max(12px, …)` (a px in a
  `font:` shorthand's `/<line-height>` slot is out of scope; only the size must be
  tokenised).
- **Why:** From a grill (q1-q4). The old three-token scale keyed size off visual
  treatment, which dumped real reading content (mono field values, callout bodies, table
  cells, anchored quotes) into the 12px telemetry tier simply because it was set in mono,
  so genuine content read as hairline labels. Keying size off reading role instead lets
  the same content sit at body size whether it is sans or mono, while labels stay at meta
  and the one masthead earns a display tier. Splitting headings (title) and the
  masthead/numeral (display) out of the old prose tier gives hierarchy the prior scale
  could not express. Normalizing icon glyphs by role (presence buttons at title, status
  glyphs at meta, text controls at ui) stops a per-glyph px from drifting and keeps the
  controls visually coherent. Promoting the telemetry-styled quotes and empty copy into
  the sans body face matches their reading role to their rendered size and face (they are
  sentences the user reads, not identifiers). The final no-px-outside-`:root` guard makes
  the five roles the literal single source of truth: a stray `font-size: 17px;` can no
  longer silently fork the scale.
- **Revisit when:** A new surface needs a sixth role (e.g. a distinct caption or a larger
  hero), at which point a token is added and the scale-pinning guard's expected set is
  updated in the same commit; or the code-one-notch-down convention stops reading well at
  some density, at which point code rejoins body; or `--fs-body` is ever lowered below
  16px. Because the mobile anti-zoom override now rides `var(--fs-body)` (see "Preserve
  pinch-zoom; kill only the iOS input auto-zoom"), dropping it under 16 would reinstate
  the iOS Safari focus-zoom, so the two must move together.

### Sub-note: unifying the dossier reading column on body, and a real em floor (2026-06-25)

- **Decision:** The Phase 1 rename was value-preserving, which left `--fs-ui` (14)
  doing double duty: genuine controls AND in-dossier reading text that historically
  rendered at 14. This phase splits them. Every substantive reading element in the plan
  dossier moves up to `--fs-body` (16): the Given/When/Then clause text (`.gwt-step`),
  the markdown table cells (`.md table`'s `font-size`, which the `td` cells inherit, plus
  the mono-uppercase header cells `.md th`, which keep their weight/tracking but share the
  body size), and the mono Files list
  (`.field-files .field-value .md`). Prose, field values, and callout bodies already
  flowed through `.md` (body 16) and so needed no change. Monospace code and diff stay
  one notch below at `--fs-ui` (14): `.fence pre`/`.fence code` (code blocks) and
  `.dline` (diff lines), the documented code-one-notch-down convention. The two inline
  sub-1em sizes (inline `code` at 0.92em, scope `.pill` at 0.8em) plus the inline
  citation chip (`.q-cite` at 0.94em) are now clamped with `max(12px, …)`, and a third
  guard in `src/ui/styles.test.ts` fails on any unclamped sub-1em-multiplier or
  sub-100%-percentage `font`/`font-size`.
- **Why:** Pill at 0.8em rendered ~11px in body context, below the 12px floor, and the
  other inline em sizes could drop below it when nested in a smaller context; absolute-px
  and var() floors were already guarded, but em/percent multipliers were not. Clamping
  with `max(12px, …)` keeps the inline-relative scaling while pinning the floor, and
  guarding it keeps a future edit from reintroducing a sub-floor multiplier. Unifying the
  reading column on body completes the role-not-treatment intent: mono file paths and
  table cells are content, so they read at content size, while code/diff stay one notch
  down to read as operational.
- **Revisit when:** A mono reading element needs to read as operational rather than
  content (then it joins code at ui), or the `max(12px, …)` clamp pattern needs a
  different floor (then the guard's `12px` literal moves with it).

### Sub-note: mono control labels join the meta (12px) tier (2026-06-25)

- **Decision:** Mono CONTROL labels render at `--fs-meta` (12px), not `--fs-ui` (14px):
  buttons (`.btn`, `.sel-btn`, `.seg-btn`, `.ctrl-approve`, `.bar-approve`/`.bar-quest`,
  the delete actions `.card-delete`/`.session-delete`/`.sl-delete`), tabs (`.scope-tab`),
  toggles and action labels (`.grill-note-toggle`, `.ctrl-changelog`,
  `.thread-followup-open`, `.drawer-whole`/`.drawer-tally`, `.approving-escape`,
  `.grill-undo`, `.pending-act`), the section menu item (`.sec-item`), and the mono form
  controls (`.field-input`, `.field-reset`, `.repo-picker-select select`). Mono *content*
  stays at ui (14): code (`.fence pre`), diff (`.dline`), live-changelog/status text
  (`.lc-main`, `.lc-detail-body`, `.lc-empty`, `.now-playing`), and path/hint/error labels
  (`.path-banner-path`, `.sec-hint`, `.field-error`, `.settings-save-error`). All sans
  rules are unchanged. No new token: this reuses `--fs-meta`, so the five-role scale and
  its four guards in `src/ui/styles.test.ts` are untouched (12 sits on the floor, not
  below it).
- **Why:** A control label and the reading text beside it, both set at `--fs-ui` (14),
  looked unequal — the button read distinctly larger. Both are genuinely 14px; the
  difference is optical, from the control's uppercase (cap-height fills ~35% more than a
  lowercase x-height), the mono face (wider, slightly larger glyphs than the sans), and
  the 600 weight plus tracking. An uppercase-mono-tracked label cannot read the same as
  lowercase sans body at the same px, so it drops one notch. We land on meta (12) rather
  than a bespoke 13px because mono control labels already wear the exact uppercase + mono
  + tracking treatment the telemetry labels wear, so they belong in that tier — reusing
  the token avoids a sixth role and the scale drift it would invite. This narrowly revises
  the "5-role semantic type scale" entry's "text controls take ui" claim: that holds for
  *sans* text inputs; *mono* control labels now take meta. Scoped to controls so mono
  code/diff content keeps its legibility at 14.
- **Revisit when:** A mono control needs more prominence than the 12px label tier gives
  (then it earns its own size, and the guard's expected token set is updated in the same
  commit), or the 12px floor moves (then mono controls move with it).

## Reuse an existing open tab: daemon-wide live-tab heartbeat + TTL (2026-06-24)

- **Decision:** The daemon tracks its live browser tabs with an explicit SPA heartbeat
  rather than an SSE-connection count. Each tab mints one clientId per page load and
  POSTs `/api/viewers/heartbeat` ({clientId, gone?}) once on mount, on a ~30s interval,
  and on becoming visible again; on tab close it sends a `gone:true` beacon. The daemon
  keeps an in-memory `Viewers` map of clientId -> lastSeen and counts the ids seen
  within a 90s TTL, exposed as `viewers` on `GET /api/health`. `otacon open` (Phase 2)
  reads it: `viewers >= 1` means a tab from this daemon is live, so it skips launching a
  duplicate. The tracker is daemon-wide (not per session) and is not visibility
  `Presence`. No `SessionSummary` / `shared/types` field: it lives only on
  `/api/health`. The field name and number type are unchanged from the gauge it
  replaces, so the CLI dedup is untouched.
- **Why:** A TTL heartbeat is used INSTEAD of counting live SSE connections because the
  dogfood daemon runs under Bun (`bin/otacon` execs `bun run`, and the daemon is spawned
  with that same runtime), and Bun's `node:http` emulation does not fire a request's
  abort signal on client disconnect (nor throw on a write to a dead socket), so `sse()`'s
  cleanup never runs and a connection count only ever climbs (it leaks). The heartbeat +
  TTL self-heals under BOTH Node and Bun: a closed or crashed tab simply stops pinging
  and lapses on the TTL, and a `gone` beacon drops a cleanly-closed tab immediately, so
  the next `open` launches again. The 90s TTL comfortably exceeds the 30s interval even
  when a background tab's timers are throttled (browsers clamp background intervals but
  stay well under 90s), so a visible-then-backgrounded tab is not falsely reaped. One
  otacon tab, via the app-shell sidebar, reaches every session, so the dedup only needs
  to know whether ANY tab from this daemon is live; keying per session would re-launch
  for a different session and add state to every summary.
- **Revisit when:** A use case needs per-session tab awareness (e.g. focusing or
  counting the tabs watching one specific session), at which point `Viewers` becomes a
  per-session map and likely moves onto the session summary; or Bun's `node:http` gains
  reliable disconnect detection (then a server-side count could return, though the
  heartbeat is robust regardless).

## Reuse an existing open tab: `otacon open` dedup, no focus (2026-06-24)

- **Decision:** `otacon open` reads `viewers` from the health response that
  `ensureDaemon()` already returns (the daemon-wide heartbeat tracker above) and, when `viewers >= 1`,
  skips launching a browser tab (dedup only, with no attempt to focus, raise, or
  navigate the existing tab, D1). The skip applies to whichever url it would have opened,
  session or index (any open tab from this daemon, via its sidebar, already reaches every
  session). It is scoped to `otacon open` alone: `otacon config` always opens the Settings
  UI (D3). No `--new` / `--force` escape hatch is added (D4). Under `OTACON_NO_BROWSER` the
  printed JSON gains `reused: true` (skipped) or `reused: false` (launched); interactively
  the skip emits one stderr notice and prints nothing, mirroring the spawn path. `viewers ??
  0` treats an absent field (an older daemon) as "open as today".
- **Why:** D1, dedup-only avoids the unreliable parts. An in-page `window.focus()` does not
  reliably raise a backgrounded tab across browsers, and OS-level focusing (AppleScript and
  friends) is fragile and platform-specific; the user's intent ("don't pile up duplicate
  tabs") is fully served by just not spawning another, so we stop there. D3, `config` opens
  a different surface (Settings) that a review tab does not stand in for, and the live-tab
  signal is about review tabs, so leaving `config` untouched keeps each verb's contract clear.
  D4, the signal self-corrects (close the tab and the count drops to 0, so the next `open`
  launches again), which makes a manual override redundant and keeps the CLI surface minimal;
  a real need for "open another anyway" can add the flag later.
- **Revisit when:** Browsers gain a reliable cross-platform way to focus an existing tab (then
  reuse could raise instead of merely skip), or a concrete workflow needs a second tab badly
  enough to justify a `--new` flag.

## Update-channel tests inject the installed version, not the build-time VERSION (2026-06-24)

- **Decision:** `AutoUpdateDeps` and `UpdateCommandDeps` carry an `installedVersion` seam
  (default `VERSION` in each module's `REAL_DEPS`); `maybeAutoUpdate` and `updateCommand`
  derive the channel and compare against `deps.installedVersion`, never the module-level
  `VERSION`. The update-channel tests pin a clean `INSTALLED` version and add positive
  staging-channel coverage to both modules. Production is byte-for-byte unchanged because
  the default is `VERSION`. Builds on the channel-aware auto-update decision above.
- **Why:** A staging release runs `npm version <base>-staging.<stamp>`, whose `version`
  lifecycle hook regenerates `src/shared/version.ts`, so in CI the checked-out tag builds
  against a `-staging.` `VERSION`. `channelOf(VERSION)` then returns `staging`, and tests
  that hardcoded the `latest` channel went red at the workflow's Test gate and blocked the
  publish (run 28103822140). Reading the installed version through a seam lets each test
  assert a channel against a pinned version instead of the ambient build, so the suite is
  green on both clean and staging builds, and the staging route finally has its own
  coverage, the gap that let this ship.
- **Revisit when:** A non-version input begins to drive the channel (the seam should then
  carry that instead), or the release stops stamping `version.ts` before the gates run (the
  coupling would no longer exist).

## Symlink user-scope wrappers to the packaged file; project-scope copies (2026-06-25)

- **Decision:** `otacon install` SYMLINKS a user-scope wrapper to the packaged
  `SKILL.md` shipped in the npm package (`dist/skills/otacon/SKILL.md`, materialized
  from `skillMd()` at build time by `scripts/gen-skill-asset.ts`). It falls back to
  COPYING the current text in two cases: the symlink call throws (filesystem/privilege
  unsupported, e.g. Windows or a cross-device link), or there is no stable packaged file
  to point at (`packagedSkillPath()` is `undefined`: a source run, or an ephemeral npx
  cache it already rejected). A project-scope wrapper (`otacon install --project`) ALWAYS
  copies. `ensureWrapper(path, scope, pkgPath?, symlink?)` owns the decision, converges
  idempotently (a correct symlink or a matching copy is a no-op; a scope/availability
  change self-heals by removing what is in the way first), and returns the resulting
  `mode` for the install JSON. The injected `symlink` argument is a test seam to force the
  copy fallback without a real unsupported filesystem.
- **Why:** Copy-only wrappers go stale silently when the binary auto-updates: the
  installed text keeps teaching an old protocol until the user happens to reinstall.
  Pointing the wrapper at a real file the new build overwrites refreshes every user-scope
  skill for free on upgrade (the gstack-style "install a pointer, not a snapshot"
  rationale). But that only works when the target is a stable, machine-local path, which
  rules out two surfaces: a committed/shared `--project` wrapper must be machine
  INDEPENDENT, so it cannot symlink to a global path a teammate or CI lacks; and there is
  nothing durable to link to from source or a transient npx cache. In all three the copy
  is the correct artifact, and a later install self-heals it back to a symlink once a
  stable package path exists, so the wrapper still ends up fresh.
- **Revisit when:** A packaged-asset hash or version stamp lets us detect a stale COPY and
  rewrite it on the next command (closing the gap that copy-mode users do not auto-refresh
  on upgrade), or the package ships the wrapper at a path stable enough that even
  project/npx installs could safely link to it.

## Side-nav status indicators are lucide-react icons (2026-06-25)

- **Decision:** The session list's leading status indicator (`session-list.tsx` →
  `SessionRow`, the `.sl-glyph` span) renders a lucide-react icon (`MessageCircleQuestion`,
  `Eye`, `LoaderCircle`, `TriangleAlert`, `Check`, `CheckCheck`, `CircleX`) instead of the
  old unicode glyph from `GLYPHS`. lucide-react is a devDependency (build-time only, like
  react/react-dom), imported by name so Vite tree-shakes the unused set out of the bundle.
- **Why:** The unicode glyphs (`✎ ✋ ⏳ ⚙ ✓ ✔ ✕`) rendered inconsistently across platform
  fonts and read as a wall of similar marks; recognizable, uniformly-weighted icons make
  the scan-the-list-and-know-state job legible. Named imports keep the cost to the seven
  icons actually used (verified: the names minify out of the index bundle entirely). Pulling
  the icon mapping into the row (not `session-status.ts`) keeps the derivation file
  React-free and icon-free: it returns a `NavIcon` name + word, the row maps name → component.
- **Revisit when:** The icon count grows enough to justify a sprite/font over per-icon
  modules, or a second surface needs the same name→component map (then lift it to shared).

## The working spinner is live-gated; an offline working session warns (2026-06-25)

- **Decision:** A working session (`draft` / `revising` / `finalizing` / `implementing`)
  shows the spinning `LoaderCircle` only while `agentLive(parked, lastContactAt, now)` is
  true; when the agent has gone quiet it shows `TriangleAlert` (the `stalled` icon, no
  spin) instead. `navState` takes `now` so the row's ticking clock keeps this honest, the
  same clock the agent-presence dot already reads.
- **Why:** A perpetual spinner on a session whose agent has actually stopped calling is a
  lie: it implies progress that is not happening. Reusing the existing `agentLive` 5-min
  presence threshold (the dot's source of truth) means the spinner and the dot can never
  disagree about whether the agent is on the line, and the warning gives the reviewer a
  real "this one is stuck, go look" signal instead of false reassurance.
- **Revisit when:** The presence threshold is retuned (the gate follows `agentLive`
  automatically), or a working status gains a "queued, agent not expected yet" sub-state
  where a warning would be wrong (then distinguish stalled from not-yet-started).

## Only attention rows get a brighter background, with a neutral tint (2026-06-25)

- **Decision:** Only the two attention states (`answer needed`, `review needed`) carry
  `attention` on the row, which lifts the background via a neutral wash off `--surface`
  (`color-mix(--ink 5% --surface)`), NOT the per-session `--accent`. Working, stalled, and
  terminal rows keep the plain row background. The `.sl-row.attention` rule is declared
  before `.sl-row.current` so the equally-specific current-row highlight still wins.
- **Why:** "Your turn" sessions are the ones a reviewer must act on, so they earn a visual
  lift the rest do not; widening it to working/terminal rows would dilute the cue back to
  noise. A neutral tint (not accent) lets the attention set read as one group across rows
  that each carry a different per-session accent; an accent-based wash would make each
  attention row look like its own thing. Hover/current still win by token strength and
  rule order, so the lift never fights the "you are here" anchor.
- **Revisit when:** A third state proves it also needs to pull the eye (re-weigh which
  states are "act now"), or the neutral tint reads muddy against a future surface palette.

## Socratic mode plumbs end-to-end like `quick` before any enforcement (2026-06-26)

- **Decision:** A session can be born "socratic": a `socratic` boolean rides the registry
  session, the `CreateSessionInput`, the `POST /api/sessions` body, and the printed `start`
  JSON — mirroring the existing `quick` flag at every layer. A `socratic.default` config
  field (default false) lets a repo opt every new session in. `otacon start --socratic`
  declares the flag with no CLI default, so an omitted flag sends nothing and the daemon
  resolves the effective value from `socratic.default`; an explicit `--socratic` wins. The
  first phase is pure plumbing: the flag carries no behavior yet (the free-text grill and
  linter enforcement it gates land later). The UI surfaces it as a quiet badge (review
  header) and an "S" marker (session list).
- **Why:** Landing the mode as a typed, tested boolean that flows through every seam first
  keeps the later enforcement phase small and reviewable — the wiring is already proven
  green before any behavior hangs off it. Modeling it on `quick` (an existing mode flag
  with the same shape) means the two modes share one mental model and one set of integration
  points, so neither can drift. Omitting the CLI flag rather than sending `false` is what
  lets `socratic.default` apply server-side, exactly as a config default should.
- **Revisit when:** The enforcement phase needs the flag to carry more than a boolean (e.g.
  a grill intensity), or `quick` and `socratic` turn out to be mutually exclusive and want a
  single `mode` enum instead of two independent booleans.

## Socratic mode is enforced at the grill/submit layer, not a new approve gate (2026-06-26)

- **Decision:** The socratic guarantee is delivered by two existing seams: `otacon ask`
  refuses answer-revealing chips (`--options`/`--recommend`) and the L3 linter bans
  `[assumed]` and untraced citations. There is **no** new approve-time check, no
  explain-back step, and no extra UI gate.
- **Why:** We considered an approve-time "explain-back" gate (make the agent restate the
  user's reasoning before approval). It is redundant once the grill itself is socratic:
  if every question is free-text and every decision must trace to the user's own words,
  the reasoning is already captured in the transcript and the plan by the time review
  opens. A second gate would only re-check what the grill+submit layer already
  guarantees, while adding a surface that can reject a plan the user is happy with.
- **Revisit when:** Real use shows agents satisfying the letter of L3 (a free-text answer
  exists) while the decision does not actually follow from it (the trace is present but
  hollow), which a server-side, zero-cost linter cannot catch and might justify a
  human-facing comprehension prompt at approve time.

## Socratic `ask` is free-text only and `[assumed]` is banned (2026-06-26)

- **Decision:** In a socratic session `otacon ask` rejects `--options` and `--recommend`
  (single and batch) with `E_SOCRATIC_FREE_TEXT_ONLY`, and L3 turns two checks into
  always-errors: `E_ASSUMED_NOT_ALLOWED` (no `[assumed]` escape) and
  `E_DECISION_NOT_REASONED` (a cited `q<n>` must carry a free-text answer, not a bare chip).
  Non-socratic sessions are unchanged: chips are fine and `[assumed]` stays a valid escape.
- **Why:** The point of the mode is that the **user** reasons every decision. Chips and a
  recommended answer let the agent hand over the conclusion, and `[assumed]` lets it decide
  unilaterally; both defeat the posture. Forcing free text and banning the assume-escape
  makes the user's own words the only path to a traced decision, so the transcript that
  ships with the plan is genuinely theirs. Keeping non-socratic behavior untouched means
  the default fast path (lead with a recommendation) is preserved for everyone who has not
  opted in.
- **Revisit when:** Free-text-only proves too heavy for trivially-bounded questions (e.g. a
  yes/no), and a "free text required but chips allowed as a starting note" middle ground is
  worth the added rule surface.

## Socratic mode is immutable per session: no force, no downgrade (2026-06-26)

- **Decision:** Once a session is socratic it stays socratic for its whole life. There is
  no command to leave the mode and no override to push a plan past the socratic checks. To
  plan without the posture, the user starts a fresh (non-socratic) session.
- **Why:** A mid-session downgrade would let the agent escape the very enforcement the user
  opted into, after some decisions were already made under socratic rules, leaving a plan
  that is half-reasoned and half-assumed with no clean record of which is which. A session
  is cheap to start; immutability keeps the transcript coherent (every decision in a
  socratic session was reasoned by the user) at the cost of one new session when intent
  changes. It also matches `quick`, which is likewise fixed at mint.
- **Revisit when:** A real workflow needs to start loose and tighten partway (or vice
  versa) often enough that a guarded, audit-logged mode switch beats starting over.

## Grill questions render at body (16px), not the title heading tier (2026-06-27)

- **Decision:** The open grill question renders at `--fs-body` (16px), not the `--fs-title`
  (18px) heading tier; the answered/"settled" state stays at `--fs-ui` (14px).
- **Why:** A grill question is reading content the user reads and answers, not a heading; at
  title (18px) it out-shouted its own option chips, answer field (both `--fs-ui` 14px), and
  answered state. Body-16 sits it in the reading tier and makes the open→settled step a
  deliberate 16→14 de-emphasis carried by size, weight, and ink-soft color. (Originally
  requested as "14px"; on review the body-16 reading tier was chosen over the ui-14 input
  tier.)
- **Revisit when:** The type scale gains a tier between body and title, or grill questions
  need to visually outrank surrounding dossier prose again.

## PR merge detection by polling GitHub via the `gh` CLI (2026-06-27)

- **Decision:** The daemon learns a session's PR fate (`prState`: open / merged / closed)
  by polling GitHub through the `gh` CLI (`gh pr view <url> --json state`), reusing the
  user's existing `gh auth`. It tracks open/merged/closed only (no CI or review status),
  and when `gh` is missing, unauthenticated, or the probe fails, it degrades to leaving
  `prState` absent (the UI falls back to a plain link). Chosen over (a) no detection at all,
  which leaves the implemented section a graveyard of stale links, and (b) a manual
  mark-merged button, which is easy to forget and drifts from reality.
- **Why:** Live PR status (like Conductor's) lets the home UI section a build by what
  actually happened to it. The `gh` CLI reuses the user's auth, so otacon stores no token
  and manages no OAuth, and the call is a local OS invocation, never a model API (the
  zero-API-spend invariant holds). open/merged/closed is the smallest signal that answers
  "is this still in flight?" without dragging in checks/reviews complexity.
- **Revisit when:** GitHub rate limits bite the poll cadence, or users want richer status
  (CI passing, review approved, draft) surfaced alongside the merge state.
