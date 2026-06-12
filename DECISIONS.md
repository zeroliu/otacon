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
  reject, no/ambiguous/unknown session, port conflict, daemon won't start, daemon
  unreachable mid-command — `E_DAEMON_DOWN`); exit 2 is bad flags or an internal
  error. Always exactly one JSON line on stdout; notices on stderr.
- **Why:** Agents branch on exit codes before parsing: 1 means "fix your input or
  environment and retry", 2 means "you invoked the tool wrong or it is broken — stop
  and report". Timeout exits 0 because re-parking is the normal loop (DESIGN.md §6),
  not a failure.
- **Revisit when:** A consumer needs finer-grained codes than the JSON `error.code`
  already provides.

## Session resolution precedence: explicit, then pointer, then lone active session

- **Decision:** `--session` always wins (even over a pointer). Otherwise the
  `.otacon/current-session` pointer at the repo root decides; a pointer naming a
  session the registry does not know is a hard refusal (`E_STALE_POINTER`), never a
  fall-through to the registry scan, and one naming an approved session refuses too
  (`E_SESSION_OVER`) — implicitly submitting would resurrect a finished plan, so an
  ended session is reachable only via explicit `--session`. Only with no pointer at
  all may the repo's single *active* (non-approved) registry session be assumed; two
  or more refuse with the candidate list attached (`E_AMBIGUOUS_SESSION`).
- **Why:** The never-guess rule (DESIGN.md §7) exists because cross-posting feedback
  to the wrong plan is unrecoverable confusion. A stale pointer silently resolving to
  "the other session in this repo" is exactly that failure, so it refuses even when a
  scan would find one candidate. Approved sessions are excluded because they are
  over by definition (§6) — a finished plan should never block starting work on the
  next one. The refusal carries the machine-readable list so the agent's very next
  call can pass `--session`.
- **Revisit when:** `otacon clean` starts managing pointers, or archived-but-active
  states appear.

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

- **Decision:** `ui/` is a Vite root built by `vite build ui` into `dist/ui`;
  react/react-dom/vite/@vitejs/plugin-react are devDependencies; runtime deps stay
  hono + @hono/node-server. `ui/` has its own tsconfig (DOM libs, JSX, bundler
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

- **Decision:** The UI has its own plan parser (`ui/src/plan/parse.ts`) implementing
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
  whole-file rewrites notable.

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
