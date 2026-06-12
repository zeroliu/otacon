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
  resolved relative to its own module (`new URL("../daemon/main.js", import.meta.url)`).
  The `otacond` bin exists only as a manual-debugging convenience.
- **Why:** The CLI always spawns *its own package's* daemon — `npm i -g`, `npm link`,
  and local dev all behave identically, and "which otacond is on PATH" version skew
  cannot happen. This is what makes the version handshake meaningful.
- **Revisit when:** Never, realistically.

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
  `.otacon/` (and `current-session`) there; in non-git directories it warns and uses
  the cwd, skipping the `.gitignore` append.
- **Why:** Subdirectory invocations must find the same session; separate worktrees have
  distinct roots, which preserves worktree-parallel planning for free. The non-git
  fallback keeps temp-dir testing trivial.
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

## `/s/:id` serves a plain-text placeholder until the UI ships

- **Decision:** `otacon start` prints the review URL per spec; the daemon answers it
  with one line of text until the real UI lands.
- **Why:** The printed URL must not be a dead 404 — it anchors the protocol and lets
  smoke tests assert the route exists.
- **Revisit when:** The web UI replaces it (next milestone after M1).

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
  eviction must then drain in-flight events first.

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
  reject, no/ambiguous/unknown session, port conflict, daemon won't start); exit 2 is
  bad flags or an internal error. Always exactly one JSON line on stdout; notices on
  stderr.
- **Why:** Agents branch on exit codes before parsing: 1 means "fix your input or
  environment and retry", 2 means "you invoked the tool wrong or it is broken — stop
  and report". Timeout exits 0 because re-parking is the normal loop (DESIGN.md §6),
  not a failure.
- **Revisit when:** A consumer needs finer-grained codes than the JSON `error.code`
  already provides.

## M1 scope: CLI surface is `start`/`submit`/`wait`/`status` only

- **Decision:** M1 ships sessions, registry, submit + linter (L1/L2/L6), event queues,
  and status. `ask`/`answer`/`open`/`clean`/approve, diffs, SSE, and the web UI come in
  later milestones. Comment/question HTTP endpoints exist so curl can exercise queues.
- **Why:** The strict milestone reading keeps every change small and testable
  end-to-end via curl/CLI before any UI exists.
- **Revisit when:** M2+ planning starts (each milestone gets its own `.otacon/` plan).
