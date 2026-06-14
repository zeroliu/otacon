# Decisions

Why, not what — the *what* lives in [DESIGN.md](DESIGN.md). One entry per decision a
future reader could not reconstruct from the code alone. Format: **Decision / Why /
Revisit when**. Every tradeoff made in a change gets its entry here in the same commit
(see [AGENTS.md](AGENTS.md)).

## Storage: plain JSON files, not SQLite

- **Decision:** All daemon state is plain JSON files (`~/.otacon/registry.json`,
  `.otacon/<session>/{session,events}.json`), written atomically (tmp + rename).
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

## `.otacon/` lives at the git repo root

- **Decision:** `otacon start` resolves `git rev-parse --show-toplevel` and puts
  `.otacon/` there (the daemon writes session state under `.otacon/<id>/`); in non-git
  directories it warns and uses the cwd, skipping the `.gitignore` append.
- **Why:** Subdirectory invocations must resolve to the same repo root the registry
  records, so the cwd's single active session is found from anywhere under it; separate
  worktrees have distinct roots, which preserves worktree-parallel planning for free.
  The non-git fallback keeps temp-dir testing trivial.
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

- **Decision:** Comment and question threads persist in `.otacon/<id>/threads.json`
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

## L5 scope: every unresolved comment thread at submit time

- **Decision:** L5 requires a resolution reply for every comment thread that has no
  stored resolution when the submit arrives — not just the latest batch. Unknown
  thread ids and question ids in `threads` are errors (questions are answered via
  `otacon answer`, never resolved); blank replies are errors; re-resolving an
  already-resolved thread is allowed and overwrites.
- **Why:** Under normal operation the two scopes are identical — each accepted
  revision resolves everything open, so what is open at the next submit is exactly
  the batches delivered since the last accepted revision (DESIGN.md §9). The
  "every open thread" formulation is what makes that invariant *self-healing*:
  after a quarantine, a crash between writes, or a hand-edited threads.json, stray
  open threads block the next submit instead of silently rotting. Overwrite-on-
  re-resolve mirrors answerQuestion: at-least-once delivery makes duplicate submits
  legitimate.
- **Revisit when:** Threads gain a user-side "withdraw comment" verb (an open
  thread the agent *cannot* resolve would deadlock submits).

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
  implementation. The selection toolbar and the c/q shortcuts are disabled in diff
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

- **Decision:** Agent grill questions persist in `.otacon/<id>/transcript.json`
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

## Approve: unresolved = open comments + unanswered questions; force bypasses

- **Decision:** POST /approve counts comment threads without a resolution plus
  question threads without an answer; a non-zero count answers 409
  `E_UNRESOLVED_THREADS` with `unresolved: n` unless the body is exactly
  `{"force": true}` — the UI warns with the count and retries with force on
  confirm. A session with no revisions answers 409 `E_NO_REVISION`. The artifact
  is written before the status flips (write, flip, enqueue `approved`) so a crash
  can leave an orphan file but never an approved session without its artifact.
  After the flip, submit/comments/questions/question-answers/ask/answers/approve
  all answer 409 `E_SESSION_OVER` — the daemon enforces the terminal state, not
  just the CLI's pointer rules.
- **Why:** §9 says Approve *warns* on unresolved threads — a hard refusal would
  make the daemon override the human's judgment, and silence would make dangling
  feedback invisible; 409-unless-force encodes "warn then allow" in one round
  trip and leaves the count machine-readable for the confirm sheet. Unanswered
  questions count because they are visibly open in the rail; approving past them
  is the same conscious shrug as an open comment. Daemon-side enforcement exists
  because curl/UI/--session callers never pass the CLI's pointer guard.
- **Revisit when:** A "withdraw question" verb appears (open-question deadlock
  stops being theoretical), or approve wants per-thread acknowledgment.

## Approve archives logically; the artifact appends an "## Interview" section

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
  marker; Codex's shared `AGENTS.md` gets a BEGIN/END-marked block that is replaced in
  place (user content outside the markers survives verbatim). User edits inside
  managed content are not preserved.
- **Why:** The wrapper is product behavior — it must track the CLI version exactly
  (`npm update -g` then reinstall, §16), and a three-way merge with user edits would
  fork the protocol invisibly: an agent following last month's card against this
  month's linter is a support nightmare. The marker makes the policy legible at the
  point of temptation. Codex is block-scoped (not whole-file) only because its file is
  a shared instructions surface other tools and humans also write to.
- **Revisit when:** Wrapper customization becomes a real need (then: a user-content
  slot outside the managed region, never merge).

## Wrapper destinations: claude skills dir, codex AGENTS.md block, opencode config skills dir

- **Decision:** Claude Code `~/.claude/skills/otacon/SKILL.md` + the hook script
  `~/.claude/hooks/otacon-stop.sh`; Codex a marked block in `$CODEX_HOME/AGENTS.md`
  (default `~/.codex/`); OpenCode `$XDG_CONFIG_HOME/opencode/skills/otacon/SKILL.md`.
  All three are fully implemented; one protocol card is the single source for all of
  them.
- **Why:** Verified conventions (June 2026): Codex reads global instructions from
  `~/.codex/AGENTS.md` and has no stable global skills contract, so the shared
  instructions file with a managed block is the honest integration; OpenCode reads
  Claude-compatible SKILL.md skills from `~/.config/opencode/skills/` (it also reads
  `~/.claude/skills/`, so the Claude install alone would work — the dedicated copy
  exists so installing/uninstalling one agent never silently depends on another's
  files). One card for all three because the protocol is agent-agnostic by
  construction (§13: "can run shell commands + can edit files").
- **Revisit when:** Codex ships a real global skills dir, or the agents' conventions
  drift apart enough that one card stops fitting all.

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

## clean: daemon deregisters, CLI archives; undrained events leave with the dir

- **Decision:** `DELETE /api/sessions/:id` accepts only approved sessions (active →
  409 `E_SESSION_ACTIVE`), removes the registry entry, and evicts the session's queue
  instance without draining it; the CLI then moves `.otacon/<id>/` to
  `.otacon/archive/<id>/`. The response reports still-pending events; clean surfaces
  them as a notice and proceeds. The evicted queue instance is `close()`d: a delivered-but-unacked event's
  post-response ack callback firing after the CLI's dir move would otherwise recreate
  `.otacon/<id>/events.json` next to the archive (writeFileAtomic mkdirs).
- **Why:** The registry is daemon-owned in-memory state — a CLI editing
  `registry.json` directly would be overwritten by the next flush, so deregistration
  must be a daemon verb; the dir move stays in the CLI because the files live in the
  user's repo and the daemon stops knowing the session the moment the entry is gone
  (`require()` throws — nothing can race the move). Dropping undrained events is the
  conscious resolution of the M2-era eviction caveat (DECISIONS "One SessionQueue
  instance per session"): on an approved session the only loseable events are
  `approved` copies, and the artifact they announce is already committed on disk —
  blocking clean on them would make the common "approve, then tidy up" flow refuse.
- **Revisit when:** clean wants to cover non-approved states (abandoned drafts), which
  would need a real force/drain story.

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

## open prints, never launches; implicit failures degrade to the index URL

- **Decision:** `otacon open` only prints `{url}` JSON — it never spawns a browser.
  With `--session` it resolves strictly; implicit resolution failures (no session,
  ambiguous, stale pointer, ended session) print the index URL with a stderr notice
  instead of failing.
- **Why:** Agents run this command too, and stdout is the contract — a CLI that pops
  GUI windows out of an agent's Bash tool is a misfeature; the human pastes or taps
  the URL (on the phone it was never going to be the Mac's browser anyway). Lenient
  fallback because the never-guess rule (§7) guards *writes* — posting feedback to
  the wrong session — while the index is a read that is never the wrong screen and
  lists every session including the ones the refusals are about.
- **Revisit when:** A desktop "open in browser" convenience is actually missed
  (then: an explicit `--browser` flag, default off).

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
  `protocolCard(cmd)`, parametrized only by command prefix: installed wrappers
  (`skillMd`/`codexBlock`) use `otacon`; this repo's committed dogfood wrapper
  (`dogfoodSkillMd`, written to `.claude/skills/otacon/SKILL.md`) uses `./bin/otacon`
  and prepends a repo preamble. The dogfood file is generated, never hand-edited, and
  `assets.test.ts` asserts the committed file equals `dogfoodSkillMd()`.
- **Why:** Start-first is the whole point of live activity — minting the session only
  after research wastes the watch window the feature exists to provide. Single-source
  removes the standing risk that the dogfood wrapper and the installed wrapper drift:
  before, the dogfood SKILL.md was hand-kept "in sync" with `assets.ts` and a protocol
  edit could silently update one and not the other. The equality test turns that drift
  into a CI failure. `otacon install` into other repos is unchanged — it writes the
  plain-`otacon` wrapper, which already works anywhere; only this repo needs the
  source-mode variant, so no project-scoped install path is added.
- **Revisit when:** A second repo needs a source-mode wrapper (then generation should
  be a real CLI subcommand, not a test-guarded committed file), or the two wrappers
  need to diverge by more than the command prefix + preamble.

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

- **Decision:** The review screen's masthead is a single sticky header (`ReviewHeader`,
  `position: sticky; top: 0`) that subsumes the old `.topbar` (back + switcher) and the
  scroll-away `SessionHead` hero. It always renders the full content — title, revision,
  repo/branch, status, switcher, clean⇄diff toggle, Approve — and **compacts** to a
  one-line bar past a small scroll threshold (`nextCompact`, rAF-throttled in
  `useCompactOnScroll`), re-expanding at the top. The rejected alternative was a hero
  plus a separate condensed bar that fades in once the hero scrolls past. On phone the
  header is lean (title + switcher chips + the clean⇄diff toggle); the revision and
  Approve are CSS-hidden below 640px, with Approve living solely in the fixed bottom
  bar. (The plan's q3 settled the phone header as "chips only"; we keep the toggle
  because hiding it removed the only phone path into diff view — a regression an
  existing 375px e2e test caught — and the toggle, unlike Approve, carries no
  shown-in-two-places hazard.)
- **Why:** Two elements (hero + reveal bar) means an IntersectionObserver to gate the
  reveal and **two copies of the title/Approve** that can disagree or briefly both show
  — the exact double-render the §10 "Approve never shown twice" rule forbids. One
  element is always complete and consistent by construction: a dropped or coalesced
  scroll frame merely leaves it in its last state (it fails to *expanded*, fully usable),
  never to a half-rendered or duplicated bar. rAF-throttling matches the selection
  reposition so the compact transition never janks per scroll frame. Hiding Approve in
  the phone header (rather than duplicating it) preserves the never-twice rule while the
  bottom bar stays the one-thumb control surface.
- **Revisit when:** The header needs content that genuinely cannot fit a single morphing
  element, or scroll-driven compaction proves janky on a real low-end device (a
  scroll-timeline / `content-visibility` approach would be the next lever).
