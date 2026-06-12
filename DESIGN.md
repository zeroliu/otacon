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

### Anchoring (for comments)

Comments anchor to **section ID + text quote** (exact text + prefix/suffix context),
W3C-annotation style. Section IDs derive from heading slugs (`phase-2`, `decisions`).
Fuzzy re-anchoring across revisions; if the quoted text disappears, the thread lands
in an **orphaned tray** — never silently dropped. Whole-plan (non-anchored) comments
are also supported.

---

## 5. Linter

Runs in the daemon on every `otacon submit`. Failure = non-zero exit + machine-readable
errors on stdout; the agent fixes and resubmits. Invalid revisions never reach the user.

| Rule | Check                                                                                                                                            | Severity                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| L1   | Schema completeness: required sections present, in order; phases have Goal/Files/Verification                                                    | error                                  |
| L2   | Read-path budgets (Summary ≤5 lines, Goal ≤3, etc.)                                                                                              | error                                  |
| L3   | Decision traceability: every `D<n>` cites a `q<n>` or `[assumed]`                                                                                | error (warning in `--quick` sessions)  |
| L4   | Detail containment heuristics: file paths in Details must appear in that phase's Files; new dependency names in Details must appear in Decisions | warning                                |
| L5   | Thread resolutions: a resubmit after a comment batch must include a resolution reply for every thread in that batch                              | error                                  |
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
| `otacon start --title <t> [--quick]`                                        | Mint session, register it, print review URL. Writes `.otacon/current-session` |
| `otacon submit [plan.md] [--resolutions res.json]`                          | Lint → reject with errors, or store revision N, notify UI                     |
| `otacon wait [--timeout 540] [--session <id>]`                              | Long-poll this session's queue; print next event as JSON                      |
| `otacon ask --question "…" [--options "A\|B\|C"] [--recommend A] [--multi]` | Post agent question card to UI; answer arrives via `wait`                     |
| `otacon answer <question-id> (--body "…" \| --file f.md)`                   | Answer a user question; no revision                                           |
| `otacon status [--all]`                                                     | Session state + undelivered event count (crash/resume entry point)            |
| `otacon open`                                                               | Print/open the review URL (human convenience)                                 |
| `otacon clean`                                                              | Archive/remove working state for ended sessions                               |

### Event types (stdout of `wait`)

```json
{"event":"comments","session":"otc_a1b2c3","batch":"b7","items":[
  {"thread":"t12","anchor":{"section":"phase-2","exact":"…","prefix":"…","suffix":"…"},"body":"…"}]}
{"event":"question","session":"otc_a1b2c3","id":"q12","anchor":{"section":"decisions"},"body":"…"}
{"event":"answer","session":"otc_a1b2c3","question":"q7","choice":"A","text":"…"}
{"event":"approved","session":"otc_a1b2c3","path":"docs/plans/2026-06-12-auth-refactor.md"}
{"event":"timeout"}
```

Every payload carries `session` so the agent can sanity-check it is handling its own plan.

### HTTP API (daemon, 127.0.0.1 only)

```
GET  /api/health                            daemon identity + version (CLI handshake)
POST /api/shutdown                          clean daemon exit
GET  /api/sessions                          index (registry)
POST /api/sessions                          mint + register a session (otacon start)
GET  /api/sessions/:id                      session detail (+ revision, pending events)
GET  /api/sessions/:id/events?wait=540      agent long-poll
POST /api/sessions/:id/submit               lint; reject 422 with issues, or store revision N
POST /api/sessions/:id/comments             flush a comment batch
POST /api/sessions/:id/questions            user question (instant)
POST /api/sessions/:id/questions/:qid/answer  agent's answer to a user question
                                            (otacon answer); 404 E_UNKNOWN_QUESTION
                                            on ids that are not open questions
GET  /api/sessions/:id/threads              comment + question threads (the UI's rail)
POST /api/sessions/:id/answers              answer to an agent question
POST /api/sessions/:id/approve              approve (daemon writes final artifact)
GET  /api/sessions/:id/revisions/:n         raw revision markdown; with Accept:
                                            application/json, {markdown, warnings}
                                            (the lint warnings it was accepted with)
GET  /api/sessions/:id/diff?from=&to=       computed diff
GET  /api/sessions/:id/stream               SSE for the UI (one session)
GET  /api/stream                            SSE for the index (all sessions)
GET  /                                      index page (the SPA)
GET  /s/:id                                 review page for a session (same SPA)
```

`/api` errors are machine-readable JSON — `{"error":{"code":…,"message":…}}` — except
a failed submit, which returns 422 carrying the linter's `errors`/`warnings` arrays.
`/` and `/s/:id` serve the SPA shell (static assets under `/assets/`); an unknown
session id renders as a client-side not-found state. Each SSE stream opens with a
`snapshot` frame (the per-session stream's snapshot carries the thread list), then
pushes `session` / `revision` / `queue` / `thread` frames as state changes — a
`thread` frame is an upsert: a new comment/question thread, or an existing question
thread gaining its answer — with a comment heartbeat to keep idle proxies from
closing the stream.
State-changing `/api` requests carrying
a foreign `Origin` header are refused 403: the loopback bind alone does not stop a
malicious webpage from firing `fetch()` at 127.0.0.1, and only browsers send `Origin`.
Event delivery over `/events` is at-least-once: an event is removed from the queue
only after its response is fully written; a dropped connection requeues it.

### The full loop

1. **Start.** Skill triggers; agent researches the codebase; `otacon start`.
2. **Grill** (§8). Agent walks the design tree via `otacon ask` + `wait`, one question
   at a time. Skipped with `--quick`.
3. **Draft.** Agent writes `plan.md`, runs `otacon submit`; loops on lint errors until clean.
4. **Review.** Agent parks in `wait`. User reads, fires instant questions
   (agent answers via `otacon answer`, returns to `wait`), stacks comments, taps Send.
5. **Revise.** Agent edits `plan.md`, writes `resolutions.json` (thread → reply),
   resubmits. Daemon computes diff vs the user's last-reviewed revision, pushes
   changelog banner. Repeat 4–5.
6. **Approve.** User taps Approve (warned if unresolved threads exist). The **daemon**
   writes `docs/plans/YYYY-MM-DD-<slug>.md` with `status: approved` + the grill
   transcript appended, archives the session, queues the `approved` event. The agent's
   `wait` returns it; agent `git add` + commits the plan file, prints a one-line
   summary, stops. Session over — implementation is somebody else's job (`snake`, later).

---

## 7. Sessions & multi-session

Multiple concurrent planning sessions (different repos, worktrees, or features) against
one daemon.

**Identity & routing.** `otacon start` mints a session ID and registers it in
`~/.otacon/registry.json` (ID → repo path, branch, title, status). Binding is
file-based because env vars don't persist across an agent's Bash calls:

- `start` writes `.otacon/current-session` in the cwd; all commands default to it.
  Different worktrees = different cwds = parallel planning with zero flags.
- `--session <id>` overrides everywhere. If a directory has two active sessions, the
  CLI **refuses** the implicit default and errors with the list — never guesses. The
  same never-guess rule covers the pointer itself: one naming a session the registry
  does not know, or an approved (ended) one, is refused — only explicit `--session`
  reaches an ended session.

**Event isolation.** One event queue per session. `otacon wait` long-polls only its own
session's queue; a comment on plan A wakes only plan A's agent. N parked waits = N open
HTTP requests, no contention.

**UI switching.** Index page is home (all sessions, status, unread badges). The review
screen header has a persistent session switcher — dropdown on desktop, horizontally
scrollable chips on phone: `auth-refactor ●2 │ search-index ✋awaiting │ miyo ⏳revising`.
Each session gets a stable **accent color** used on the header, comment composer, and
agent-question cards, so rapid phone switching can't post feedback to the wrong plan.

---

## 8. The grill phase

The grill-me discipline is a mandatory protocol phase, not a separate skill: before
drafting, the agent walks the design tree **one question at a time**, resolving
dependencies in order, recommended answer first, exploring the codebase instead of
asking whenever the code can answer.

Transport is `otacon ask` → question card in the UI (option chips, recommended option
first, free text) → answer via `wait`. **Grilling works from the phone, one thumb,
while walking.**

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
| User **question**  | instant                                              | Agent answers in-thread (`otacon answer`); plan untouched. One-tap **Promote to comment** after reading the answer |
| User **comment**   | batched in a drawer; per-comment "send now" override | Flushed batch → exactly one revision, one changelog                                                                |
| **Agent question** | instant (during grill or anytime)                    | Card in UI; user answers with chips/text                                                                           |

**Mixed flush:** questions answered first (answers may inform further review), then all
comments applied as one revision. Keeps revisions chunky — the agent never thrashes on
every keystroke.

**Re-review (3 layers):**

1. **Changelog** — agent-written summary at the top of each revision banner.
2. **Threads** — every comment becomes a thread the agent MUST resolve with a reply
   (lint L5); unresolved threads are visible at a glance and warned on Approve.
3. **Diff** — toggle between clean-latest and inline diff **vs the revision the user
   last actually reviewed** (not merely the previous one; baseline selectable). Changed
   sections carry gutter markers even in clean view, so unprompted changes to sections
   the user never commented on still surface.

---

## 10. UI/UX

Two screens only. No settings UI in v1 — config is a file.

### Index (the phone bookmark)

Card per session: title, repo + branch, status chip (`agent drafting` /
`awaiting your review` / `agent revising` / `questions pending` / `approved`),
unread-change badge, last activity, accent color. Tap → review screen.

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
  quoted text in the plan.
- New revision → banner: _changelog / diff / dismiss_.
- Agent questions: card queue pinned above the plan (chips + free text), session-colored.
- Collapsed Details show size badges ("▸ 34 lines · 1 diagram · 2 code blocks") —
  skipping is a conscious choice. L6 warnings render here.
- Collapsible "Interview" panel: grill transcript; decisions deep-link into it.
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
  design: every section header has a `⋯` menu — _Comment on section / Ask about
  section_. Long-press text selection still works for precision.
- Threads open as bottom sheets. Sticky bar = whole control surface: pending
  questions, drawer + Send, Approve (confirm sheet: "Finalize r4 →
  docs/plans/2026-06-12-auth-refactor.md and end the session").
- Agent question cards answerable with chips — designed for grilling on the move.

### Cross-cutting

UI updates over SSE (watch status flip from _revising_ to _new revision_, answers
stream into threads). Mobile-first CSS. Orphaned-comment tray reachable from the
threads rail.

---

## 11. Remote access

**Tailscale.** `tailscale serve` exposes `otacond` at a stable HTTPS tailnet URL;
phone runs the Tailscale app. The tailnet IS the auth — zero auth code in v1. The app
itself stays loopback-bound; remote access is pure infra, so a Cloudflare Tunnel (or
the rejected hosted relay) remains a drop-in swap later without touching app code.

Operational requirement: the Mac stays awake while a plan is in review
(`caffeinate -i` guidance in the skill/docs).

---

## 12. Storage & lifecycle

| Location                                 | Contents                                                                                                       | Git                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `<repo>/.otacon/`                        | Working state: `current-session`, `plan.md`, revision snapshots `r1.md…rN.md` (each with the lint warnings it was accepted with, `rN.warnings.json`), threads (`threads.json`: comment + question threads with answers inline), Q&A transcript, queues | **gitignored**                             |
| `<repo>/docs/plans/YYYY-MM-DD-<slug>.md` | Final approved plan (`status: approved` frontmatter + grill transcript)                                        | **committed** (by the agent, post-approve) |
| `~/.otacon/registry.json`                | Session registry: ID → repo, branch, title, status                                                             | n/a (global)                               |

The committed plan is the contract `snake` consumes — any fresh session, worktree, or
machine can find it. Review exhaust stays out of git. `otacon clean` archives ended
sessions' working state.

Session status machine: `draft → in_review ⇄ revising → approved`.

---

## 13. Subscription invariant & failure modes

### Zero API spend, by construction

- **No process ever calls a model API.** Daemon, CLI, linter, UI are pure TypeScript.
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
- Image/screenshot embeds in plans.
- PreToolUse hardening hooks (v1.5).
- Multi-user anything.

---

## 15. Open items

- Budget numbers (L2/L6) and fence-per-section caps are config; expect a week of tuning.
- Lint L4 heuristics will grow from observed smuggle vectors.
- Skill wrapper texts per agent (identical protocol, three thin files) — written during
  implementation.
- `snake` naming/design — separate document when its time comes.

---

## 16. Installation & per-repo usage (future-user UX)

### One-time machine setup

```sh
npm install -g otacon        # one package: CLI + daemon (npm name verified free)
                             # until published: npm i -g github:zeroliu/otacon
otacon install --all         # write agent skill wrappers; or --agent claude|codex|opencode
otacon doctor                # verify: daemon boots, port 4747 free, wrappers present, Tailscale status
otacon expose                # optional, phone access: checks Tailscale login,
                             # configures `tailscale serve`, prints the tailnet URL to bookmark
```

`otacon install` writes the thin protocol wrapper into each agent's skill location
(Claude Code: `~/.claude/skills/otacon/SKILL.md`, plus an offer to register the Stop
hook in `~/.claude/settings.json`; Codex and OpenCode: their skill/instructions
equivalents). `otacond` is never installed or started by hand — any `otacon` command
auto-spawns it if it isn't running, and the CLI restarts a stale daemon on version
mismatch (version handshake on every call).

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
