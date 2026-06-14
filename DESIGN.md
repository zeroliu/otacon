# Otacon — Design

> Otacon: mission support over codec. Snake is in the field; Otacon is on the line
> helping him think it through. This tool plays Otacon to your coding agents:
> it owns the planning conversation so the agent does the job right.

**Status:** design approved; implementation in progress (milestone overview: Roadmap in [README.md](README.md)).
**Owner:** Zero (personal tool, optimized for one user's workflow, freely customizable).

This document describes product behavior — what otacon is and how it behaves. It carries
no implementation sequencing. Tradeoff rationale lives in [DECISIONS.md](DECISIONS.md);
working conventions for agent sessions in [AGENTS.md](AGENTS.md).

---

## 1. Problem

Native plan modes in coding agents (Claude Code, Codex, OpenCode) fail in four ways:

1. **Wall of text.** Plans are verbose; reviewing them in a terminal leads to giving up
   and rubber-stamping — surrendering cognition to the agent.
2. **Feedback is unanchored.** There is no way to highlight a specific passage and
   comment on it, no way to batch comments, and no way to see what changed after the
   agent revises — so re-review is as expensive as first review.
3. **Plans are text-only.** No diagrams, no examples, no visual structure.
4. **One long session implements everything.** A multi-phase plan executed by a single
   long-context session degrades — the agent gets lazy and stops following the plan.

Otacon solves 1–3 with a plan review surface. Problem 4 is solved by a **future,
separate implementer skill** (working name: `snake` — Otacon supports, Snake executes)
that consumes Otacon's approved plan artifacts. Otacon itself never implements anything.

---

## 2. Decision record

Every decision below was resolved deliberately; rationale follows in the relevant section.

| #   | Decision          | Choice                                                                                                                                                                            |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scope             | Plan review surface only. Implementation/orchestration = future `snake` skill                                                                                                     |
| 2   | Surface           | Local web UI served by a CLI daemon; built fresh (lavish-axi as pattern reference, no fork)                                                                                       |
| 3   | Plan format       | Schema'd markdown: frontmatter + fixed sections, stable IDs, phases first-class                                                                                                   |
| 4   | Conciseness       | Deterministic linter at submit + 2-tier schema (budgeted read path / unbudgeted collapsible detail)                                                                               |
| 5   | Re-review         | 3 layers: agent changelog, mandatory comment-resolution threads, diff vs last-reviewed revision                                                                                   |
| 6   | Agent integration | Replace native plan modes with one CLI protocol; thin skill wrapper per agent                                                                                                     |
| 7   | Approval          | Approve ends the session; output = approved plan file committed to the repo                                                                                                       |
| 8   | Phone access      | Tailscale Serve to the local daemon; plans never leave personal devices                                                                                                           |
| 9   | State topology    | Local-first. Daemon on the Mac is the single source of truth (hosted relay considered and rejected for privacy/simplicity; protocol stays plain HTTP so it remains a future lift) |
| 10  | Feedback grammar  | User comments (batched), user questions (instant, plan untouched), agent questions (`otacon ask`)                                                                                 |
| 11  | Mixed batch       | Questions answered first, then all comments applied as one revision with one changelog                                                                                            |
| 12  | Visuals v1        | Mermaid, code + before/after blocks, ASCII wireframes. Images deferred to v2                                                                                                      |
| 13  | Storage           | Working state in gitignored `.otacon/`; approved plan committed to `docs/plans/`                                                                                                  |
| 14  | LLM cost          | Zero API spend invariant: daemon/CLI/UI never call a model; all intelligence runs in the user's interactive subscription-backed session. No Agent SDK anywhere                    |
| 15  | Multi-session     | One daemon, many concurrent sessions; per-session event queues; UI session switcher                                                                                               |
| 16  | Grilling          | grill-me discipline is a mandatory protocol phase before drafting; decisions must trace to grill answers (linted)                                                                 |
| 17  | Name              | CLI `otacon`, daemon `otacond`. Future implementer: `snake` (suggestion, not locked)                                                                                              |
| 18  | Storage format    | Plain JSON files, written atomically; SQLite rejected (native dep, opaque state)                                                                                                  |
| 19  | Dev tooling       | bun for dev (installs + `bun test`); shipped artifact builds with `tsc` and runs on plain Node                                                                                    |

---

## 3. Architecture

```
┌─────────────┐  HTTPS (Tailscale)   ┌──────────────────────────────┐
│ Phone /     │ ───────────────────► │ otacond (local daemon)       │
│ Desktop UI  │  HTTP API + SSE      │ 127.0.0.1:4747               │
└─────────────┘                      │ • serves React UI            │
                                     │ • owns ALL state (sessions,  │
┌─────────────┐                      │   revisions, threads, queues)│
│ Claude Code │  Bash tool runs      │ • runs the linter            │
│ / Codex /   │ ───────────────────► │ • computes diffs             │
│ OpenCode    │  `otacon …` CLI      │ • writes final plan on       │
│ (interactive│  (blocking calls)    │   approve                    │
│  session)   │                      └──────────────────────────────┘
└─────────────┘                       state: <repo>/.otacon/ +
                                      ~/.otacon/registry.json
```

Three principles:

- **The daemon is dumb and stateful.** Pure TypeScript: state, validation, diffing,
  rendering. It never calls a model.
- **The agent is smart and stateless.** Every fact about a review lives on the daemon's
  disk. Any session — including a brand-new one after a crash or context compaction —
  can resume the role via `otacon status`.
- **Push ends at the daemon.** The phone pushes to the daemon; agents only ever pull
  (long-poll). No push channel to an agent exists or is needed.

### Components

| Component      | Description                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `otacon` CLI   | Thin client. Used by agents via their Bash tool, and by the human for setup (`otacon open`). Auto-spawns the daemon if not running        |
| `otacond`      | Single Node process (Hono). HTTP API + static React UI on `127.0.0.1:4747`. Per-session event queues, revision store, linter, diff engine |
| Web UI         | React + Vite SPA, mobile-first. Talks to the same HTTP API + SSE stream                                                                   |
| Skill wrappers | One thin markdown skill per agent (Claude Code, Codex, OpenCode) teaching the identical protocol                                          |

### Stack

TypeScript throughout. Node + Hono single process serving API and static UI. React +
Vite viewer, mobile-first CSS (the phone is a primary client). State as plain JSON
files under `.otacon/`. System fonts, light/dark via media query. ~720px max-width
reading column on desktop. Dev tooling is bun (installs, tests); the shipped artifact
builds with `tsc` and runs on plain Node.

---

## 4. Plan artifact schema

The plan is a markdown file the agent writes with its native Write/Edit tools at
`.otacon/<session>/plan.md`.

### Frontmatter

```yaml
---
title: auth-refactor
session: otc_a1b2c3
revision: 4
status: in_review # draft | in_review | revising | approved
created: 2026-06-12
---
```

### Sections (fixed order, H2)

| Section                    | Tier                           | Budget                  |
| -------------------------- | ------------------------------ | ----------------------- |
| `## Summary`               | read path (normative)          | ≤5 lines                |
| `## Decisions`             | read path (normative)          | each entry ≤3 lines     |
| `## Phases` (H3 per phase) | read path (normative) + detail | see below               |
| `## Risks`                 | read path (normative)          | ≤5 items, ≤2 lines each |
| `## Open Questions`        | read path                      | may be empty            |

Each `### Phase <n> — <name>` requires: **Goal** (≤3 lines), **Files** (list),
**Verification** (≤3 lines), optional **Out of scope**. Each phase may have one
`#### Details` block — collapsible in the UI, unbudgeted (soft cap: warn over 80 lines).

### The normative / informative contract

This is the rule that makes "I only carefully read the read path" a safe review posture:

- The **read path is normative**: decisions, scope, files touched, risks, verification —
  everything that changes what gets built MUST appear there.
- **Detail blocks are informative**: they may only _elaborate_ on something already
  stated in the read path, never _introduce_ it.
- Downstream consequence: the future `snake` implementer treats the read path as
  authoritative and detail as advisory.

### Decision traceability

Every entry in `## Decisions` must cite the grill question that produced it, or be
explicitly tagged as assumed:

```markdown
- D1: RS256 over HS256 ← q7
- D2: Sessions table stays until phase 3 [assumed]
```

`[assumed]` is a visible "I decided this without asking — veto me" sign. Enforced by
the linter (§5).

### Visuals (v1)

Allowed: ` ```mermaid ` diagrams, syntax-highlighted code blocks, paired before/after
code blocks (rendered side-by-side), ASCII wireframes in monospace fences. Fenced
blocks are exempt from line budgets but capped at one fence per read-path section
(tunable); unlimited inside Details. Images deferred to v2.

A before/after pair is two adjacent fences whose info strings carry `before` and
`after` tags after the language (` ```ts before ` … ` ```ts after `). The UI renders
them side-by-side on desktop, stacked on phones; an unpaired tag renders as an
ordinary fence. The plan stays plain renderable markdown everywhere else.

**Review visuals (markdown-native).** Beyond fences, a set of primitives the renderer
styles from plain markdown — so each stays comment-anchorable, diff-able, and degrades
to readable text if rendering ever fails:

- **Callouts** — a blockquote whose first line is `[!risk]`, `[!note]`, `[!decision]`,
  or `[!assumption]` renders as a flat semantic-ink panel (§10). Unknown types stay
  ordinary blockquotes.
- **Decision matrix** — a GFM table whose chosen row leads with a `✓` first cell; the
  renderer accent-inks that row so the winner reads at a glance (§10). Any table with no
  `✓` row degrades to a plain table.
- **Inline scope pills** — a closed set of bracket tokens (`[new]`, `[breaking]`,
  `[risky]`, `[deletes]`) renders as small mono tags inline in prose (§10). Markdown
  links and the `[assumed]` decision tag are left untouched.

The two block visuals are exempt from line budgets but counted against a
per-read-path-section **visual cap** (default 2, tunable — the same shape as the
one-fence rule, and uncapped inside Details), so a 2-line risk can _be_ a callout without
a section becoming a wall of widgets. **Inline pills are always free** (never counted).

### Anchoring (for comments)

Comments anchor to **section ID + text quote** (exact text + prefix/suffix context),
W3C-annotation style. Section IDs derive from heading slugs (`phase-2`, `decisions`).
Fuzzy re-anchoring across revisions: on every accepted revision the daemon re-locates
each thread's quote — exact match first, then prefix/suffix-disambiguated, then a
normalized match (whitespace collapsed, markdown emphasis markers ignored) that
rewrites the stored quote to the new revision's text. A unique match re-anchors
(following moved text across sections); no match or an ambiguous one sets the thread's
`anchorState` to **orphaned** and it lands in the **orphaned tray** — never silently
dropped, and automatically recovered if a later revision restores the text. Whole-plan
(non-anchored) comments are also supported and never orphan.

---

## 5. Linter

Runs in the daemon on every `otacon submit`. Failure = non-zero exit + machine-readable
errors on stdout; the agent fixes and resubmits. Invalid revisions never reach the user.

| Rule | Check                                                                                                                                            | Severity                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| L1   | Schema completeness: required sections present, in order; phases have Goal/Files/Verification                                                    | error                                  |
| L2   | Read-path budgets (Summary ≤5 lines, Goal ≤3, etc.)                                                                                              | error                                  |
| L3   | Decision traceability: every `D<n>` cites a `q<n>` (`← q7` or `← q7, q9`; `<-` accepted) or `[assumed]`; cited ids must exist in the grill transcript | error (warning in `--quick` sessions)  |
| L4   | Detail containment heuristics: file paths in Details must appear in that phase's Files; new dependency names in Details must appear in Decisions | warning                                |
| L5   | Revision accompaniment: a submit must include a resolution reply for every open comment thread, and every revision ≥ 2 must carry a changelog    | error                                  |
| L6   | Detail soft caps (>80 lines/section)                                                                                                             | warning, surfaced as a badge in the UI |

Budget numbers are config, expected to be tuned during the first week of real use.
Known residual risk: vacuous summaries pass L2 (no deterministic fix without an LLM,
which the zero-cost invariant forbids server-side) — mitigated by the human commenting
"this says nothing," which is cheap.

---

## 6. Protocol

### Core mechanism: the parked wait

The agent never receives pushed events. It runs a **blocking CLI command through its
ordinary Bash tool** and the command's stdout _is_ the event. While the command blocks,
the model is suspended — no inference, no token spend.

```
 you (phone)            otacond :4747             CLI process        agent session
     │                       │                        │                      │
     │                       │   GET /events?wait=540 │  Bash("otacon        │
     │                       │ ◄──────────────────────│   wait") spawns CLI ◄┤
     │                       │   (daemon HOLDS the    │                      │ model suspended —
     │                       │    request open…)      │  …blocked on HTTP…   │ no inference,
     │  tap "Send all"       │                        │                      │ no tokens
     ├──────────────────────►│                        │                      │
     │  POST /comments       │  responds with JSON    │                      │
     │   (over Tailscale)    ├───────────────────────►│                      │
     │                       │                        │  prints JSON, exit 0 │
     │                       │                        ├─────────────────────►│ stdout = tool result
     │                       │                        │                      │ model resumes
```

- Claude Code kills Bash calls at 600s, so the skill invokes with Bash timeout 600s and
  `--timeout 540` on the CLI. On nothing, the CLI exits **cleanly** with
  `{"event":"timeout"}` and the agent immediately calls `wait` again. A one-hour review
  is ~7 cycles, a few hundred tokens total.
- Events queue on the daemon until a `wait` picks them up — nothing depends on the
  agent being mid-wait when the user taps Send. Comments queued while a session is dead
  are delivered to the next `wait`, even from a brand-new session.

### CLI commands (agent-facing)

| Command                                                                     | Effect                                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `otacon start --title <t> [--quick]`                                        | Mint session, register it, print review URL                                   |
| `otacon submit [plan.md] [--resolutions res.json]`                          | Lint → reject with errors, or store revision N, notify UI                     |
| `otacon wait [--timeout 540] [--session <id>]`                              | Long-poll this session's queue; print next event as JSON                      |
| `otacon ask --question "…" [--options "A\|B\|C"] [--recommend A] [--multi]` | Post agent question card to UI (or a batch of independent questions via `--batch <file\|->`); answer arrives via `wait` |
| `otacon answer <question-id> (--body "…" \| --file f.md)`                   | Answer a user question; no revision                                           |
| `otacon progress "<note>" [--session <id>]`                                 | Append a narration note to the live activity feed (UI-only; non-blocking, never parks, never an event) |
| `otacon status [--all]`                                                     | Session state + undelivered event count (crash/resume entry point)            |
| `otacon open [--session <id>]`                                              | Print the review URL — the index URL when no session resolves; never launches a browser |
| `otacon clean [--all]`                                                      | Archive ended sessions' working state to `.otacon/archive/` and prune the registry (§12) |

The `--resolutions` file is the revision-accompaniment document:

```json
{
  "changelog": "Kept RS256; moved the table drop to phase 3 as asked.",
  "threads": { "t1": "Moved to phase 3.", "t2": "Kept — see the new D4." }
}
```

`threads` maps comment-thread ids to resolution replies — lint L5 requires one per
open comment thread; accepted replies land on the threads and mark them resolved
(re-resolving overwrites). `changelog` is the agent's summary of the revision,
required on every revision ≥ 2, stored per revision, and shown in the UI's revision
banner (§9). The CLI sends the file's content as the `resolutions` field of the
submit JSON: `{"plan": "...", "resolutions": {...}}`; unknown keys or non-string
replies are refused 400 before linting.

### Event types (stdout of `wait`)

```json
{"event":"comments","session":"otc_a1b2c3","batch":"b7","items":[
  {"thread":"t12","anchor":{"section":"phase-2","exact":"…","prefix":"…","suffix":"…"},"body":"…"}]}
{"event":"question","session":"otc_a1b2c3","id":"q12","anchor":{"section":"decisions"},"body":"…","replyTo":"q7"}
{"event":"answer","session":"otc_a1b2c3","question":"q7","choice":"A","text":"…"}
{"event":"approved","session":"otc_a1b2c3","path":"docs/plans/2026-06-12-auth-refactor.md"}
{"event":"timeout"}
```

Every payload carries `session` so the agent can sanity-check it is handling its own plan.
An `answer` to a `--multi` question carries `choices` (an array) instead of `choice`; an
answer to an optionless question carries only `text` (`text` may also accompany a choice
as extra context). An option question also accepts a **free-form custom answer** — a
non-empty `text` with no `choice`/`choices` (native-AskUserQuestion "Other" parity), so
the user is never trapped by the offered chips. A `question` event carries `replyTo`
when it is a **follow-up** on an earlier question (§9) — the agent skims that thread's
prior turns for context and answers the new `q<n>` the usual way. `approved.path` is
repo-relative — the agent commits that file.

### HTTP API (daemon, 127.0.0.1 only)

```
GET  /api/health                            daemon identity + version (CLI handshake)
POST /api/shutdown                          clean daemon exit
GET  /api/sessions                          index (registry)
POST /api/sessions                          mint + register a session (otacon start)
GET  /api/sessions/:id                      session detail (+ revision, pending events)
DELETE /api/sessions/:id                    deregister an ended session (otacon clean);
                                            non-approved sessions → 409 E_SESSION_ACTIVE;
                                            publishes a terminal `removed` SSE frame
GET  /api/sessions/:id/events?wait=540      agent long-poll
POST /api/sessions/:id/submit               lint; reject 422 with issues, or store revision N
POST /api/sessions/:id/comments             flush a comment batch
POST /api/sessions/:id/questions            user question (instant); optional
                                            {replyTo:"q<n>"} posts a follow-up on
                                            that question's conversation — it
                                            inherits the root's anchor (a client
                                            anchor is ignored), 404
                                            E_UNKNOWN_QUESTION on a non-question id
POST /api/sessions/:id/questions/:qid/answer  agent's answer to a user question
                                            (otacon answer); 404 E_UNKNOWN_QUESTION
                                            on ids that are not open questions
GET  /api/sessions/:id/threads              comment + question threads (the UI's rail)
POST /api/sessions/:id/ask                  agent grill question (otacon ask):
                                            {question, options?, recommend?, multi?}
                                            → 201 {id: "q<n>"}, or a batch
                                            {questions:[…]} of the same specs →
                                            201 {ids:[…]} minted atomically (a
                                            bad member fails the whole batch);
                                            persisted in the transcript, no
                                            agent event queued
GET  /api/sessions/:id/transcript           the grill transcript (asked + answered)
POST /api/sessions/:id/progress             agent narration (otacon progress):
                                            {note} → 200 {ok, session, note}; the
                                            note is trimmed to a configured max,
                                            appended to the capped activity feed,
                                            and pushed as an `activity` SSE frame
                                            (+ a `session` frame for the chip). No
                                            agent event is queued — UI-only telemetry
POST /api/sessions/:id/answers              user's answer to an agent question:
                                            {question, choice|choices, text?} —
                                            validated against the question's options
                                            and multi-ness; an option question also
                                            takes a non-empty text-only custom answer
                                            (no chip); queues the answer event
POST /api/sessions/:id/approve              approve: writes the final artifact, flips
                                            the session approved, queues `approved`.
                                            Unresolved threads (comments without a
                                            resolution + questions without an answer)
                                            → 409 E_UNRESOLVED_THREADS carrying the
                                            count, unless the body is {"force":true}
                                            (the UI warns, then forces on confirm);
                                            no revisions yet → 409 E_NO_REVISION
POST /api/sessions/:id/reviewed             mark a revision reviewed ({revision},
                                            default: latest) — the diff baseline;
                                            monotonic, also set by a comment flush
POST /api/sessions/:id/presence             review-screen visibility ping
                                            ({visible}); suppresses desktop
                                            attention banners only while a review
                                            is visible (below). Ephemeral, no
                                            status change — callable on any session
GET  /api/sessions/:id/revisions/:n         raw revision markdown; with Accept:
                                            application/json, {markdown, warnings,
                                            changelog} (lint warnings + the agent
                                            changelog it was accepted with)
GET  /api/sessions/:id/diff?from=&to=       computed structural diff (below)
GET  /api/sessions/:id/stream               SSE for the UI (one session)
GET  /api/stream                            SSE for the index (all sessions)
GET  /                                      index page (the SPA)
GET  /s/:id                                 review page for a session (same SPA)
```

The diff endpoint computes a structural diff between two stored revisions, segmented
into the same slug units the review screen renders (frontmatter excluded). `to`
defaults to the latest revision; `from` defaults to the last-reviewed one (0 = the
empty plan, so a never-reviewed session diffs as all-new; any `?from=` selects another
baseline). Unchanged units carry no hunks; added/removed ones carry their full body:

```json
{"session":"otc_a1b2c3","from":2,"to":4,"sections":[
  {"id":"phase-2","title":"Middleware","status":"changed","hunks":[
    {"fromStart":3,"fromCount":4,"toStart":3,"toCount":5,"lines":[
      {"op":"context","text":"Files:"},{"op":"del","text":"- src/auth.ts"},
      {"op":"add","text":"- src/middleware/jwt.ts"}]}]},
  {"id":"summary","title":"Summary","status":"unchanged","hunks":[]}]}
```

`status` is `added | removed | changed | unchanged` (the UI's gutter markers); hunk
line numbers are 1-based within the unit.

`/api` errors are machine-readable JSON — `{"error":{"code":…,"message":…}}` — except
a failed submit, which returns 422 carrying the linter's `errors`/`warnings` arrays.
Every state-mutating session verb (submit, comments, questions and their answers,
ask, answers, progress, approve) refuses an approved session with 409 `E_SESSION_OVER` — the
status machine's terminal state is enforced on the daemon, not just by the CLI's
session-resolution rules.
`/` and `/s/:id` serve the SPA shell (static assets under `/assets/`); an unknown
session id renders as a client-side not-found state. Each SSE stream opens with a
`snapshot` frame (the per-session stream's snapshot carries the thread list, the
grill transcript, and the activity feed), then pushes `session` / `revision` /
`queue` / `thread` / `grill` / `activity` / `removed` frames as state changes — a
`revision` frame carries the revision number and its changelog; a `thread` frame is
an upsert: a new comment/question thread (a follow-up question carries `replyTo`, the
root it continues), or an existing thread changing (a question gaining its answer, a
comment gaining its resolution, an anchor re-anchoring or orphaning); a `grill` frame is the transcript's upsert: a question asked via
`otacon ask`, or an entry gaining the user's answer; an `activity` frame carries one
new progress note appended to the per-session activity log (the draft chip rides the
`session` frame's `latestActivity` instead); a `removed` frame is terminal —
the session left the registry (`otacon clean`): the index and the session switcher
drop it live, an open review screen flips to a quiet "session cleaned" state and
closes its stream (a reconnect against the deregistered id could only 404), and the
daemon ends the per-session stream after the frame (nothing can be published for the
session again, so a client that ignored the frame must not pin the connection; the
index stream stays open) — with a comment heartbeat to keep idle proxies from
closing the stream.
Session payloads (snapshot, `session` frames, session detail) carry
`lastReviewedRevision` alongside `revision`, and `openQuestions` — the count of
transcript entries still awaiting the user's answer, from which the index's
"questions pending" chip derives (§10); every transcript change (ask, answer)
publishes a fresh `session` frame so that count is always live. They also carry
`latestActivity` (the newest progress note, driving the draft chip), plus the
agent-presence pair `parked` (a live `otacon wait` long-poll exists) and
`lastContactAt` (epoch-ms of the agent's last contact — any mutating verb or each
`wait` park bumps it). Presence is in-memory and ephemeral: the daemon keeps no
timer, the UI derives live/offline from `parked || recency`, and a daemon restart
reads offline until the next contact (correct). A `wait` park publishes a `session`
frame so the refreshed `lastContactAt` and `parked` reach the dot within one park
slice.
State-changing `/api` requests carrying
a foreign `Origin` header are refused 403: the loopback bind alone does not stop a
malicious webpage from firing `fetch()` at 127.0.0.1, and only browsers send `Origin`.
Event delivery over `/events` is at-least-once: an event is removed from the queue
only after its response is fully written; a dropped connection requeues it.

### Attention notifications

When the ball moves to your court, the daemon fires a **native macOS desktop
banner** — at two moments: the agent posts a grill question, and the agent submits
a revision awaiting review (a batch of questions coalesces to one banner). The
daemon already runs on the Mac, so it fires the banner directly (not Web Push);
with `terminal-notifier` on PATH the banner is clickable and opens the review URL,
otherwise it falls back to `osascript`. Phone (Web Push) is out of scope here and
deferred (§14).

A banner is **suppressed only while that session's review is actually visible** —
the review screen pings `POST /presence` with `document.visibilityState` (a
heartbeat while visible, an explicit hidden ping on blur/unload) and the daemon
holds a short TTL so a crashed or closed tab self-expires. A hidden, backgrounded,
or closed tab does NOT suppress (its SSE stream may still be connected — connection
is not attention). The agent's parked `otacon wait` hits `/events`, never
`/presence`, so a waiting agent never suppresses your banners.

On by default; toggle with a `notifications.desktop` boolean in
`~/.otacon/config.json` (repo `otacon.config.json` override allowed), mirroring the
budgets config. Off macOS the banner is a silent no-op.

### The full loop

1. **Start (first).** Skill triggers; `otacon start` mints the session and prints the
   review URL *before* research, so the user can watch from the first second. The
   agent then researches the codebase, narrating at checkpoints with `otacon progress`
   — each note feeds the live activity log and the draft chip (UI-only; never an event).
2. **Grill** (§8). Agent walks the design tree via `otacon ask` + `wait`, one question
   at a time. Skipped with `--quick`.
3. **Draft.** Agent writes `plan.md`, runs `otacon submit`; loops on lint errors until clean.
4. **Review.** Agent parks in `wait`. User reads, fires instant questions
   (agent answers via `otacon answer`, returns to `wait`), stacks comments, taps Send.
5. **Revise.** Agent edits `plan.md`, writes `resolutions.json` (changelog + thread →
   reply), resubmits. Daemon resolves the threads, re-anchors every quote in the new
   text (§4), computes diff vs the user's last-reviewed revision, pushes the
   changelog banner. Repeat 4–5.
6. **Approve.** User taps Approve (warned if unresolved threads exist — the daemon
   answers 409 with the count until the UI confirms with `force`). The **daemon**
   writes `docs/plans/YYYY-MM-DD-<slug>.md` with `status: approved` + the grill
   transcript appended, flips the session to `approved` (ending it — every further
   mutation refuses), queues the `approved` event. The agent's
   `wait` returns it; agent `git add` + commits the plan file, prints a one-line
   summary, stops. Session over — implementation is somebody else's job (`snake`, later).

---

## 7. Sessions & multi-session

Multiple concurrent planning sessions (different repos, worktrees, or features) against
one daemon.

**Identity & routing.** `otacon start` mints a session ID and registers it in
`~/.otacon/registry.json` (ID → repo path, branch, title, status). The registry is
the single source of truth — there is no local session pointer:

- Commands default to the repo's single active session: the CLI reads the registry
  and picks the one non-approved session whose repo is the cwd's git root. Different
  worktrees = different roots = parallel planning with zero flags.
- `--session <id>` overrides everywhere, and is the only way to reach an approved
  (ended) session. If a repo has two or more active sessions, the CLI **refuses** the
  implicit default and errors with the candidate list — never guesses. Zero active
  sessions for the repo refuses too (`E_NO_SESSION`).

**Event isolation.** One event queue per session. `otacon wait` long-polls only its own
session's queue; a comment on plan A wakes only plan A's agent. N parked waits = N open
HTTP requests, no contention.

**UI switching.** Index page is home (all sessions, status, unread badges). The review
screen header has a persistent session switcher — dropdown on desktop, horizontally
scrollable chips on phone: `auth-refactor ●2 │ search-index ✋awaiting │ miyo ⏳revising`.
The current session's chip leads the strip (the "you are here" anchor never scrolls
out of reach) and never wears an unread badge — you are reading it; `●N` counts the
revisions this device hasn't opened (unread state is device-local, §10). The switcher
rides the index SSE stream, so chips appear, re-badge, and vanish live.
Each session gets a stable **accent color** used on the header, comment composer, and
agent-question cards, so rapid phone switching can't post feedback to the wrong plan.

---

## 8. The grill phase

The grill-me discipline is a mandatory protocol phase, not a separate skill: before
drafting, the agent walks the design tree **dependencies first, one question at a
time**, recommended answer first, exploring the codebase instead of asking whenever
the code can answer. Independent sibling questions — ones whose answers don't shape
each other — may be posted together in one `otacon ask --batch` call; they render as
ordinary cards, each answered instantly, and the agent loops `wait` to collect them.

Transport is `otacon ask` → question card in the UI (option chips, recommended option
first, free text) → answer via `wait`. **Grilling works from the phone, one thumb,
while walking.** An option question is never a trap: every card also takes a free-form
custom answer — typed text alone (native-AskUserQuestion "Other" parity), or riding a
chosen chip as a note.

The transcript persists in `.otacon/<session>/transcript.json` — distinct from the
user-question threads in `threads.json` (different surface, different lifecycle: the
transcript ships with the artifact; threads stay review exhaust). Agent questions
mint their `q<n>` ids from the same counter as user questions, so citations and
deep links live in one unambiguous id space.

Structural integration:

- **Traceability** (§4, lint L3): plan decisions cite the grill Q&A that produced them
  (`D3 ← q7`) or wear `[assumed]`. No plan reaches review with silently-made decisions.
- **The transcript is part of the review UI**: a collapsible "Interview" panel shows
  the Q&A history; each decision deep-links to its originating answer ("why RS256?" —
  one tap, including what the user said at the time).
- **The transcript ships with the artifact**: archived with the approved plan so
  `snake` inherits not just decisions but their reasoning.
- Escape hatch: `otacon start --quick` skips the grill and downgrades L3 to a warning.
  The default is: no plan reaches review without surviving the interview.

---

## 9. Review loop semantics

**Three message types, three timings:**

| Type               | Default timing                                       | Effect                                                                                                             |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| User **question**  | instant                                              | Agent answers in-thread (`otacon answer`); plan untouched. **Follow up** to keep the conversation going (a linked question, same anchor); one-tap **Promote to comment** after reading the answer |
| User **comment**   | batched in a drawer; per-comment "send now" override | Flushed batch → exactly one revision, one changelog                                                                |
| **Agent question** | instant (during grill or anytime)                    | Card in UI; user answers with chips/text                                                                           |

**Mixed flush:** questions answered first (answers may inform further review), then all
comments applied as one revision. Keeps revisions chunky — the agent never thrashes on
every keystroke.

**Follow-up questions:** a question thread is a conversation, not a one-shot. After the
agent answers, a **Follow up** affordance on that card posts another question — one
direction, you ask and the agent answers. A follow-up is its own `q<n>` thread linked to
the root by `replyTo` (reusing the queue, `otacon answer`, and the shared q-id space),
and it inherits the root's anchor, so the rail groups the whole chain into one card that
jumps and orphans as a unit. Scope is question threads only; comment threads stay
one-shot resolutions.

**Re-review (3 layers):**

1. **Changelog** — agent-written summary at the top of each revision banner. Submitted
   in the resolutions document (§6), required on every revision ≥ 2 (lint L5), stored
   per revision.
2. **Threads** — every comment becomes a thread the agent MUST resolve with a reply
   (lint L5); unresolved threads are visible at a glance and warned on Approve.
3. **Diff** — toggle between clean-latest and inline diff **vs the revision the user
   last actually reviewed** (not merely the previous one; baseline selectable). Changed
   sections carry gutter markers even in clean view, so unprompted changes to sections
   the user never commented on still surface.

**Last-reviewed tracking:** the daemon keeps a per-session `lastReviewedRevision` —
the default diff baseline. It moves when the user flushes a comment batch on a
revision (commenting is reviewing) and when the UI explicitly marks a revision
reviewed (`POST /reviewed`, e.g. dismissing the new-revision banner). It is monotonic;
older baselines stay reachable through the diff endpoint's `?from=`.

---

## 10. UI/UX

Two screens only. No settings UI in v1 — config is a file.

**Visual language: hairline telemetry.** The codec identity — mono operational type,
the masthead, the faint scanlines, the per-session accent hue — stays, but surfaces
are *flat panels split by thin rules*, never rounded-rect cards with a fat painted
left-border and a soft drop-shadow. The session accent shows as a small mark — a 1ch
mono `▍` tag in a card's meta row, a 2px rule along a panel's top edge, an accent-inked
glyph or label — not a 3–4px blade down the side. Containers drop their corner radius;
in-flow cards (index rows, the grill card, the revision banner, threads, phases) carry
no shadow, while floating overlays (the composer, the section menu, the approve and
bottom sheets, the drawer) keep a shadow to lift off the page. Controls keep their own
treatment: chips (with the `★rec` star and on/off states), buttons, inputs, and pills
are hit targets, not container chrome, and are unchanged. The index is a top-ruled
telemetry list rather than a stack of boxes.

**Callouts** apply this vocabulary to plan prose: a `> [!risk]` blockquote becomes a
flat panel with a 2px top rule and a glyph+label inked in the type's hue — risk amber,
note blue, decision accent, assumption muted — no fill, no radius, drawn only from the
tested chip/accent palette so the codec discipline and light/dark contrast both hold.
The marker line is chrome (unselectable, never anchored); the body stays anchorable
markdown so a comment pins to one specific callout. A **decision matrix** is a plain
GFM table; the chosen row (first cell `✓`) gets a 2px accent rule on the marker cell
and a faint accent wash — the winner inked, the alternatives left as ordinary rows.
**Inline pills** are small mono tags hued by scope (new green, breaking/deletes red,
risky amber). They render the keyword without its brackets, so — like inline emphasis —
a comment quote that spans a pill may not survive a cross-revision re-anchor; it orphans
gracefully rather than misattaching.

### Index (the phone bookmark)

Card per session: title, repo + branch, status chip, agent-presence dot,
unread-change badge, last activity, accent color. Tap → review screen. The status
chip is `awaiting your review` / `agent revising` / `questions pending` /
`approved`, plus an **activity-driven draft chip**: while a session is in `draft`
(it sits there through research + drafting, before revision 1 exists) the chip
shows the latest `otacon progress` note (truncated), falling back to `agent
working` until the agent narrates — so the chip never claims "drafting" while the
agent is still reading. The **agent-presence dot** (live/offline) sits beside the
chip — a subtle "is the agent still on the line?" mark, distinct from the
browser↔daemon link dot (labelled `agent` vs `link`); the status chip stays the
primary "your turn" signal. The dot is live while the agent is parked in
`otacon wait` or its last contact is recent, and is hidden on approved sessions.

### Review screen — desktop (Google-Docs margin model)

```
┌──────────────────────────────────────────────────────────────────┐
│ auth-refactor  r4 · in review   [Clean|Diff]  [Changelog] ✓Approve│
├────┬────────────────────────────────────────┬────────────────────┤
│    │ # Summary                              │ ⊙ THREADS          │
│    │ Replace session auth with JWT…         │ ┌────────────────┐ │
│ ▌  │ ## Decisions                           │ │ "why RS256     │ │
│    │ D1: RS256 over HS256 ← q7              │ │  not HS?"      │ │
│    │                                        │ │ ↳ agent: …     │ │
│    │ ## Phase 1 — Token issuance            │ │ [Promote ↑]    │ │
│ ▌  │ Goal: … (≤3 lines)                     │ └────────────────┘ │
│    │ Files: src/auth/*, src/middleware/jwt  │ ┌────────────────┐ │
│    │ ▸ Details — 34 lines · 1 diagram       │ │ ✓ resolved     │ │
│    │ ## Phase 2 — …                         │ └────────────────┘ │
├────┴────────────────────────────────────────┴────────────────────┤
│               💬 3 comments pending · [Review] [Send all]         │
└──────────────────────────────────────────────────────────────────┘
    ▌ = gutter marker: changed since last-reviewed revision
```

- Select text → floating toolbar: **Comment** (→ drawer) | **Ask** (fires immediately;
  thread shows "answering…" until the reply lands). The toolbar only appears where the
  anchor can survive: selections touching renderer chrome (mermaid SVG labels, fence
  captions, slug anchors, size badges — text that exists only in the rendered DOM,
  never in the plan markdown the agent reads) get no toolbar.
- Drawer = bottom bar: review/edit/delete pending comments, per-comment **send now**,
  **Send all**; when nothing is pending it shrinks to the whole-plan comment
  affordance alone.
- Threads rail: clicking an anchored thread scrolls to its section and flashes the
  quoted text in the plan. A question and its follow-ups render as one **conversation
  card** — each turn with its answer (or the blinking "answering…" cursor) — with a
  collapsed **Follow up** button that reveals a reply box for the next question.
  Resolved comments collapse to their ✓ line (id, revision, section) and expand to the
  agent's reply. Orphaned threads leave the list for the rail's badge-counted **orphan
  tray**: an orphaned conversation travels as a unit, each entry keeping its dead quote
  (section slug struck through) and expanding to the full original anchor text.
- New revision → banner: _changelog / diff / dismiss_. Shown while the latest
  revision is newer than last-reviewed — derived state, so it survives reloads and
  shows on every device — and only from r2 on: the first read of a plan is a first
  review, not a re-review. Dismiss marks the revision reviewed; a header
  **Changelog** control re-opens the current revision's changelog afterwards.
- Diff mode renders the server's hunks inside the same reading column; a baseline
  picker ("vs r2 ▾") selects any prior revision and the clean view's gutter markers
  follow the same baseline. Unchanged sections collapse to status-tagged rails —
  the clean reading is one toggle away. Selection anchoring works only in clean
  view; diff lines are telemetry, not plan text an anchor could survive on. Markers
  (and the banner) wait for a first review: with no baseline everything is new, and
  marking every section says nothing.
- Agent questions: card queue pinned above the plan (chips + free text), session-colored.
- Collapsed Details show size badges ("▸ 34 lines · 1 diagram · 2 code blocks") —
  skipping is a conscious choice. L6 warnings render here.
- Collapsible "Interview" panel: grill transcript; decisions deep-link into it.
- Collapsible "Activity" log: the agent's `otacon progress` narration as an
  append-only feed (newest first), so work is visible during research + drafting.
  Compact and collapsed on the review screen; the pre-plan placeholder ("no
  revision yet") leads with it open, since before a plan exists it is the main
  thing to watch. The header also carries the agent-presence dot.
- Keyboard: `j/k` jump changed sections, `c` comment, `q` ask. **No shortcut for
  Approve, on purpose.** Approve warns on unresolved threads.

### Review screen — phone (one thumb, walking)

```
┌──────────────────────┐
│ auth-refactor   r4 ▌ │  ← header in session accent color
│ ──────────────────── │
│ # Summary            │
│ Replace session auth │
│ with JWT…       [⋯]  │
│ ## Phase 1      [⋯]  │
│ Goal: …       💬2    │
│ ▸ Details · 34 lines │
│ ──────────────────── │
│ ❓2  💬3 Send  ✓Appr │  ← sticky bar
└──────────────────────┘
```

- Selection-based anchoring is miserable on mobile, so anchoring goes coarser by
  design: every section and phase header has a `⋯` menu — _Comment on section / Ask
  about section_ — opening the composer with a **section-only anchor** (`{section}`,
  no exact quote; it survives revisions as long as the section does). The menu is
  always available — a popover on desktop, a bottom sheet in thumb range on phone —
  and long-press text selection still works for precision.
- Threads open as bottom sheets. Sticky bar = whole control surface: pending
  questions ❓ (tap → the question queue), drawer + Send, Approve (confirm sheet:
  "Finalize r4 → docs/plans/2026-06-12-auth-refactor.md and end the session"). The
  bar is the desktop drawer augmented at the phone breakpoint — approve and the
  question tally fold into it and leave the header strip, never shown twice.
- Agent question cards answerable with chips — designed for grilling on the move.

### Cross-cutting

UI updates over SSE (watch status flip from _revising_ to _new revision_, answers
stream into threads). Mobile-first CSS. Orphaned-comment tray reachable from the
threads rail. The review screen reports its visibility to the daemon
(`POST /presence`) so desktop attention banners (§6) fire only when you are not
already watching that review.

---

## 11. Remote access

**Tailscale.** `tailscale serve` exposes `otacond` at a stable HTTPS tailnet URL;
phone runs the Tailscale app. The tailnet IS the auth — zero auth code in v1. The app
itself stays loopback-bound; remote access is pure infra, so a Cloudflare Tunnel (or
the rejected hosted relay) remains a drop-in swap later without touching app code.

**HTTPS requirement & verification.** The tailnet URL is served over HTTPS, which
requires the tailnet to have HTTPS Certificates enabled (admin console → DNS → Enable
HTTPS). `tailscale serve --bg` writes its config and exits 0 even when certs are off —
the endpoint then resets every TLS handshake, so the phone just sees a dead URL. `otacon
expose` therefore does not trust that exit code: after configuring serve it GETs
`<url>api/health`, reports `verified: true|false`, and on failure points at the admin
DNS page (a foreign/unresolvable name fails fast; a TLS reset is retried briefly to ride
out cold-cert provisioning). Verification timing is `OTACON_EXPOSE_VERIFY_*`-overridable
so the e2e stays hermetic.

On the Mac App Store (sandboxed) Tailscale, `tailscale serve` proxies a port fine, but
the `tailscale` CLI must be launched from inside its `.app` bundle — a bare
`/usr/local/bin/tailscale` symlink crashes, so the launcher is a wrapper script that
`exec`s the bundle binary. otacon's discovery falls back to the bundle path regardless.

Operational requirement: the Mac stays awake while a plan is in review
(`caffeinate -i` guidance in the skill/docs).

---

## 12. Storage & lifecycle

| Location                                 | Contents                                                                                                       | Git                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `<repo>/.otacon/`                        | Working state under `<id>/`: `plan.md`, revision snapshots `r1.md…rN.md` (each with the lint warnings it was accepted with, `rN.warnings.json`, and its agent changelog, `rN.changelog.md`), threads (`threads.json`: comment + question threads with answers, resolutions, and anchor states inline), the grill transcript (`transcript.json`), the capped live-activity feed (`activity.json`: the newest ~N `otacon progress` notes), queues | **gitignored**                             |
| `<repo>/docs/plans/YYYY-MM-DD-<slug>.md` | Final approved plan (`status: approved` frontmatter + grill transcript)                                        | **committed** (by the agent, post-approve) |
| `~/.otacon/registry.json`                | Session registry: ID → repo, branch, title, status                                                             | n/a (global)                               |

The committed plan is the contract `snake` consumes — any fresh session, worktree, or
machine can find it. Review exhaust stays out of git. `otacon clean` archives ended
sessions' working state: for every **approved** session in the current repo (`--all`:
everywhere), the daemon drops the registry entry (`DELETE /api/sessions/:id`, refused
409 for active sessions), then the CLI moves `.otacon/<id>/` to
`.otacon/archive/<id>/` in the session's repo (name collisions get a numeric suffix).
Committed plans under `docs/plans/` are never touched; events still queued on an ended
session are archived with the directory rather than blocking the clean.

**The approved artifact** is the final revision's markdown with the frontmatter
`status` rewritten to `approved` and `revision` corrected to the daemon's count (the
daemon owns both), plus the grill transcript appended as an `## Interview` section —
one `### q<n> — <question>` per entry with an `- Options:` line (recommended option
tagged `(recommended)`, `(multi)` on the label for multi-choice) and an `- Answer:`
line (`choice`/comma-joined `choices`, ` — text` appended when both were given,
`_unanswered_` when the question was never answered). A `--quick` session's empty
transcript appends no section. The filename is dated with the approve day and slugged
from the session title; a taken name gets a `-2`, `-3`, … suffix — never overwritten.
The artifact is post-lint output: the closed plan schema (§4-5) governs submits, not
this file. Approve ends the session **logically** — `status: approved` excludes it
from implicit CLI resolution and every mutating verb refuses — while `.otacon/<id>/`
stays on disk (the parked `wait` still drains the `approved` event from it) until
`otacon clean` archives it.

Session status machine: `draft → in_review ⇄ revising → approved`.

---

## 13. Subscription invariant & failure modes

### Zero API spend, by construction

- **No process ever calls a model API.** Daemon, CLI, linter, UI are pure TypeScript.
  The daemon does make **local OS calls** — `osascript`/`terminal-notifier` for desktop
  attention banners (§6), `git`/`tailscale` for setup — which are not model APIs and
  leave the zero-API-spend invariant untouched; no plan content leaves the machine.
- **All intelligence runs inside the interactive session** the user already has open —
  the thing subscriptions price. `otacon wait` is indistinguishable from any other Bash
  call. No headless `claude -p`, no Agent SDK, no second metered surface. This makes
  the design immune to Agent-SDK-excluded-from-subscription policy changes.
- The protocol demands only "can run shell commands" + "can edit files" — why the
  identical loop works on Claude Code, Codex, and OpenCode subscriptions.
- **Forward constraint for `snake`:** same rule. Orchestration via instructions + this
  CLI + interactively-started sessions (or native in-session subagents, which are
  subscription-covered). Never SDK-spawned workers. The committed plan file is the sole
  handoff interface.

### Failure modes

| Failure                                                                 | Mitigation                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent lazily ends its turn mid-review                                   | Skill instruction ("never end your turn while the session is open") + **Claude Code Stop hook** (plain shell script): if an open session exists, block the stop with "plan session still active — run `otacon wait`". Codex/OpenCode start instruction-only; both have notify/plugin equivalents for later hardening |
| Agent bypasses the remote channel with native AskUserQuestion           | Skill forbids it; v1.5: PreToolUse hook blocks AskUserQuestion (and optionally Edit/Write outside `.otacon/`) while a plan session is active                                                                                                                                                                         |
| Session dies (crash, closed laptop, context compaction)                 | Agent is stateless; events queue on the daemon. Any new session: `otacon status` → open session, current revision, undelivered events → resume the loop                                                                                                                                                              |
| Detail-tier smuggling (load-bearing content hidden in collapsed blocks) | Normative/informative contract + lint L4 heuristics + size badges + diff gutter markers on detail changes                                                                                                                                                                                                            |
| Budget gaming (vacuous summaries)                                       | No deterministic fix; visible to the human, who comments "this says nothing." Accepted residual risk                                                                                                                                                                                                                 |
| Occupied terminal during review                                         | Inherent to the no-SDK constraint (the interactive session is the only allowed brain). Practice: open another tab/worktree for parallel work                                                                                                                                                                         |
| State file corrupt on disk (registry / session / events JSON)           | Quarantined, never fatal: the file is atomically renamed to `<name>.corrupt-<timestamp>` with a stderr log and the daemon continues with a fresh structure — session `revision` is recovered from the `r<N>.md` snapshots. Corruption can cost queued events or counters, never the ability to keep working          |

---

## 14. Out of scope (v2+)

- **`snake`** — the implementer skill: consumes approved plans, executes phase-per-fresh-session.
- Hosted relay (Cloudflare Worker + DO) — protocol is plain HTTP so this stays a clean lift.
- **Web Push (phone) attention notifications.** Desktop banners shipped (§6); the phone
  surface is deferred. Agreed future approach: zero-dependency hand-rolled VAPID
  (`node:crypto`) + a payload-less wake-up push — the service worker fetches the session
  detail over Tailscale to build the notification, so plan content never rides the push
  service. Tracked in TODOs.md.
- Image/screenshot embeds in plans.
- PreToolUse hardening hooks (v1.5).
- Multi-user anything.

---

## 15. Open items

- Budget numbers (L2/L6) and fence-per-section caps are config; expect a week of tuning.
- Activity feed cap and the note max-length are config (`activity.cap`,
  `activity.noteMaxChars`); the agent live/offline threshold is a UI constant that
  must exceed `wait`'s 240s park slice — all first-week tuning guesses.
- Lint L4 heuristics will grow from observed smuggle vectors.
- Wrapper text tuning from observed agent behavior (the protocol card is one shared
  text written by `otacon install`; see §16).
- `snake` naming/design — separate document when its time comes.

---

## 16. Installation & per-repo usage (future-user UX)

### One-time machine setup

```sh
npm install -g otacon        # one package: CLI + daemon (npm name verified free)
                             # until published: npm i -g github:zeroliu/otacon
otacon install --all         # write agent skill wrappers; or --agent claude|codex|opencode
                             # --hooks also registers the Claude Code Stop hook
otacon doctor                # verify: node ≥ 20, daemon boots + port free-or-ours,
                             # wrappers present, Stop hook registered, Tailscale status
                             # (hard failures exit 1; optional pieces are warnings)
otacon expose                # optional, phone access: checks the tailscale CLI exists
                             # and is logged in, runs `tailscale serve` against the
                             # daemon port, verifies the tailnet URL actually serves
                             # (needs HTTPS certs enabled), prints the URL to bookmark
```

`otacon install` writes the thin protocol wrapper — one protocol card teaching the
full loop (§6), grill discipline (§8), and the never-end-your-turn rule (§13) — into
each agent's skill location: Claude Code `~/.claude/skills/otacon/SKILL.md` plus the
Stop hook script `~/.claude/hooks/otacon-stop.sh`; Codex a marker-delimited block in
`$CODEX_HOME/AGENTS.md` (default `~/.codex/`, user content outside the markers
preserved); OpenCode `$XDG_CONFIG_HOME/opencode/skills/otacon/SKILL.md`. Wrappers are
managed files — reinstall overwrites them. The Stop hook registration in
`~/.claude/settings.json` is offered, applied only by `--hooks`: an additive,
idempotent merge that preserves every existing key and backs the file up before the
first change (unparseable settings are refused, never clobbered). `otacond` is never
installed or started by hand — any `otacon` command auto-spawns it if it isn't
running, and the CLI restarts a stale daemon on version mismatch (version handshake
on every call).

**Single source for the protocol card.** The card text is built once, parametrized
only by command prefix (`protocolCard(cmd)` in `src/cli/install/assets.ts`): the
installed wrappers use `otacon`, while this repo's own committed dogfood wrapper
(`.claude/skills/otacon/SKILL.md`) uses the run-from-source `./bin/otacon` prefix and
prepends a repo preamble. The dogfood file is **generated** from `dogfoodSkillMd()`,
not hand-edited, and a test (`assets.test.ts`) asserts the committed file equals that
output — so a protocol change can never silently drift between what `otacon install`
writes elsewhere and what this repo runs.

### Per-repo setup

**None.** Otacon works in any git repo with zero configuration. The first
`otacon start` in a repo creates `.otacon/` and appends `.otacon/` to the repo's
`.gitignore` if missing (with a notice). `docs/plans/` is created on first approve.
Budgets/lint config is global (`~/.otacon/config.json`); a committed
`otacon.config.json` at the repo root overrides it if present.

### Daily flow

1. In any agent session in the repo: *"plan \<feature\> with otacon"* (or `/otacon`).
2. The agent researches, runs `otacon start`, and grills you one question at a time —
   answer the cards in the browser (`otacon open`) or on your phone via the tailnet URL.
3. The agent drafts, passes the linter, submits. You review: questions fire instantly,
   comments stack in the drawer, **Send all** when done.
4. Agent revises; you re-review via changelog + threads + diff-vs-last-reviewed. Repeat
   until **Approve**.
5. The approved plan lands in `docs/plans/YYYY-MM-DD-<slug>.md`, committed by the
   agent. The planning session ends; hand the file to your implementer (future: `snake`).

### Updating

`npm update -g otacon` — the version handshake restarts the daemon on next use; no
other steps.
