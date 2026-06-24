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

Otacon solves 1–3 with a plan review surface. Problem 4 is solved by **Approve &
Implement** (§6): the reviewer can carry an approved plan straight into implementation,
where the *same* agent that planned it builds it through per-phase native subagents — a
fresh implement+test subagent per phase, then a separate review subagent, pausing on the
first blocker, opening a PR at the end. (A future, separate implementer skill — working
name: `snake` — that consumes approved plan artifacts from a detached session remains on
the horizon, §14.)

---

## 2. Decision record

Every decision below was resolved deliberately; rationale follows in the relevant section.

| #   | Decision          | Choice                                                                                                                                                                            |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scope             | Plan review surface, plus **Approve & Implement**: the same agent can carry an approved plan into implementation via per-phase native subagents (§6). A detached `snake` skill stays future                          |
| 2   | Surface           | Local web UI served by a CLI daemon; built fresh (lavish-axi as pattern reference, no fork)                                                                                       |
| 3   | Plan format       | Schema'd markdown: frontmatter + fixed sections, stable IDs, phases first-class                                                                                                   |
| 4   | Conciseness       | Deterministic linter at submit + 2-tier schema (budgeted read path / unbudgeted collapsible detail)                                                                               |
| 5   | Re-review         | 3 layers: agent changelog, mandatory comment-resolution threads, diff vs last-reviewed revision                                                                                   |
| 6   | Agent integration | Replace native plan modes with one CLI protocol; thin skill wrapper per agent                                                                                                     |
| 7   | Approval          | Approve = **Save** or **Implement**. Save writes a project copy under `plans.dir` (you commit it if you want); Implement builds from the home copy. The canonical copy always lands in the home archive                |
| 8   | Phone access      | Tailscale Serve to the local daemon; plans never leave personal devices                                                                                                           |
| 9   | State topology    | Local-first. Daemon on the Mac is the single source of truth (hosted relay considered and rejected for privacy/simplicity; protocol stays plain HTTP so it remains a future lift) |
| 10  | Feedback grammar  | User comments (batched), user questions (instant, plan untouched), agent questions (`otacon ask`)                                                                                 |
| 11  | Mixed batch       | Questions answered first, then all comments applied as one revision with one changelog                                                                                            |
| 12  | Visuals v1        | Mermaid, code + before/after blocks, ASCII wireframes. Images deferred to v2                                                                                                      |
| 13  | Storage           | Working state in `<repo>/.otacon/` (otacon manages no `.gitignore` — track or ignore it as you like); every approved plan archived to the home store `~/.otacon/sessions/<id>/` (permanent, never cleaned); on Save also copied into the repo under `plans.dir`                                  |
| 14  | LLM cost          | Zero API spend invariant: daemon/CLI/UI never call a model; all intelligence runs in the user's interactive subscription-backed session. No Agent SDK anywhere                    |
| 15  | Multi-session     | One daemon, many concurrent sessions; per-session event queues; UI session list (resizable/collapsible sidebar ≥960px; inline home list + ☰ overflow sheet below)                 |
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

Brand identity is the **OTACON wordmark** (`src/ui/otacon.svg`, the gear-as-O mark) — a
flat single-color silhouette shown in the app shell sidebar header (and the mobile
mini top-bar), painted in the brand accent via CSS mask so it tracks light/dark and
per-session hue rather than baking a color. The brand
accent is a **lime green** (hue ~82°, the wordmark's own green) — the default for
`var(--hue, 82)`; per-session accents still vary by hash (§7). Semantic state colors
(approved/added green, await amber, revise blue, fail red) are a separate palette and keep
their own hues.

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

| Section                    | Tier                           | Budget                  | Presence |
| -------------------------- | ------------------------------ | ----------------------- | -------- |
| `## Summary`               | read path (normative)          | ≤5 lines                | required |
| `## Contract`              | read path (normative)          | ≤12 lines               | optional |
| `## Decisions`             | read path (normative)          | each entry ≤3 lines     | required |
| `## Impact`                | read path (normative)          | ≤10 lines               | optional |
| `## Phases` (H3 per phase) | read path (normative) + detail | see below               | required |
| `## Risks`                 | read path (normative)          | ≤5 items, ≤2 lines each | required |
| `## Open Questions`        | read path                      | may be empty            | required |

**Optional review-altitude sections.** Beyond the required spine, the schema
admits optional H2 sections slotted at fixed positions in the order above —
linted when present, never mandatory — so a trivial plan stays minimal and a
complex one scales up (the **review altitude** goal: lead with intent and risk,
not implementation steps). `## Contract` is the first: the interface / data-schema
surface — inputs, outputs, types, errors — the reviewer signs off **instead of
reading implementation**. `## Impact` is the second: the change's **blast radius** —
the upstream modules it leans on and the downstream modules it can break —
rendered as a compact dependency list (an optional dependency mermaid is allowed and,
like any diagram, exempt from the fence cap). The order check tolerates absent optionals (it compares
the sections found against the canonical order filtered to those present), so
omitting one never trips the ordering rule.

Each `### Phase <n> — <name>` requires: **Goal** (≤3 lines), **Files** (list),
**Verification** (≤3 lines), optional **Out of scope**. The Verification field
may also carry a ` ```gwt ` **behavioral-assertion block** (below). Each phase may
have one `#### Details` block — collapsible in the UI, unbudgeted (soft cap: warn
over 80 lines).

### Lead diagram (first screen)

A **lead diagram** — a ` ```mermaid ` state / sequence / flow chart placed directly
under the `## Summary` headline — is **strongly recommended, not required** (~90% of
plans, q6): the reviewer should grasp the change's shape before reading any prose. It is
exempt from both the line budget and the per-section fence cap; a `mermaid` diagram is
not counted by the fence cap, so it never spends Summary's one-fence allowance and the
≤5-line headline is unaffected, and the review screen pins the Summary and its lead
diagram as the first screen (§10). The headline stays the existing ≤5-line Summary. There
is no forced one-line TL;DR, and phases stay expanded.

The linter checks **presence, never usefulness** (a diagram that merely restates the
summary adds reading load): a Summary with no diagram earns a non-blocking nudge (lint
L7, §5), never an error. When a chart genuinely wouldn't help — a pure docs or config
change — an explicit `<!-- no-lead-diagram: <why> -->` marker in Summary suppresses the
nudge (the marker is chrome, exempt from the line budget). The escape hatch is explicit
so "no diagram" is always a deliberate choice, never an oversight.

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
blocks are exempt from line budgets. `mermaid` diagrams are also exempt from the fence
cap (they count only toward the L7 lead-diagram check, never toward E_FENCE_CAP); code
and before/after fences stay capped at one fence per read-path section (tunable).
Everything is unlimited inside Details. Images deferred to v2.

A before/after pair is two adjacent fences whose info strings carry `before` and
`after` tags after the language (` ```ts before ` … ` ```ts after `). The UI renders
them side-by-side on desktop, stacked on phones; an unpaired tag renders as an
ordinary fence. The plan stays plain renderable markdown everywhere else.

Tree- or hierarchy-shaped content (a taxonomy, a doc or file structure, a nested
option space, a state hierarchy, a decision tree) is expressed as a ` ```mermaid `
diagram (the agent picks the shape, `graph TD` by default), not a monospace nested
outline in a ` ```text ` fence: a diagram shows the shape at a glance where an outline
forces the reviewer to reconstruct it line by line. This is part of the visuals
vocabulary the wrapper teaches; the renderer already validates such diagrams (L8) and
exempts them from the fence cap, so a structural tree can sit alongside the lead diagram.

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
- **Behavioral assertions** — a ` ```gwt ` fence inside a phase's **Verification**
  holds one or more `Given … / When … / Then …` scenarios (blank line between
  scenarios; `And`/`But` continue a clause). The renderer styles them as scenario
  cards that double as the human's approve checklist — **Test-Driven Review**
  (§9, §10). The grammar is a single shared tokenizer used by both the linter and
  the UI, so what the agent must write and what the reviewer sees never drift. The
  block is exempt from the fence cap (it is the verification surface, not a code
  fence), capped instead at a scenario count (default 6), and must sit under
  Verification; a malformed or misplaced block fails the lint.

The two block visuals are exempt from line budgets but counted against a
per-read-path-section **visual cap** (default 2, tunable — the same shape as the
one-fence rule, and uncapped inside Details), so a 2-line risk can _be_ a callout without
a section becoming a wall of widgets. **Inline pills are always free** (never counted).
The `gwt` block is exempt from the fence cap and tracked by its own scenario budget.
`mermaid` diagrams are likewise exempt from the per-section fence cap (counted only
toward the L7 lead-diagram check), so the fence cap now governs only code and
before/after fences.

### Anchoring (for comments)

Comments anchor to **section ID + text quote** (exact text + prefix/suffix context),
W3C-annotation style. Section IDs derive from heading slugs (`phase-2`, `decisions`).
Fuzzy re-anchoring across revisions: on every accepted revision the daemon re-locates
each thread's quote — exact match first, then prefix/suffix-disambiguated, then a
normalized match (whitespace collapsed, markdown emphasis markers ignored) that
rewrites the stored quote to the new revision's text. A unique match re-anchors
(following moved text across sections); no match or an ambiguous one marks the anchor
internally (`anchorState:"orphaned"`) and the thread **stays inline in the rail with its
quote muted** — never silently dropped, and automatically recovered if a later revision
restores the text. Whole-plan (non-anchored) comments are also supported and never lose
their anchor.

Open threads keep their anchored text **persistently lit** in the clean view — the
steady counterpart to the click-flash, so which passages are under discussion is
visible at a glance. Open questions, open comments, and unsent drawer drafts paint
via the CSS Custom Highlight API (never by re-rendering the plan); a question's mark
clears when it is answered or when the reviewer **resolves** the conversation (a
follow-up keys on its root's close), a comment's mark clears when the reviewer
**resolves** it (not merely when the agent replies — a reply is a response, the thread
stays lit until the reviewer closes it), and any mark clears when its quote orphans.
Whole-plan and orphaned anchors are never lit — there is no re-locatable quote to paint.

---

## 5. Linter

Runs in the daemon on every `otacon submit`. Failure = non-zero exit + machine-readable
errors on stdout; the agent fixes and resubmits. Invalid revisions never reach the user.

| Rule | Check                                                                                                                                            | Severity                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| L1   | Schema completeness: required sections present, in canonical order (absent optionals tolerated); phases have Goal/Files/Verification; `gwt` blocks well-formed and under Verification | error                                  |
| L2   | Read-path budgets (Summary ≤5 lines, Goal ≤3, etc.)                                                                                              | error                                  |
| L3   | Decision traceability: every `D<n>` cites a `q<n>` (`← q7` or `← q7, q9`; `<-` accepted) or `[assumed]`; cited ids must exist in the grill transcript | error (warning in `--quick` sessions)  |
| L4   | Detail containment heuristics: file paths in Details must appear in that phase's Files; new dependency names in Details must appear in Decisions | warning                                |
| L5   | Revision accompaniment: a submit must include a reply for every open comment thread that has none — a comment the reviewer has **resolved** (the close/withdraw verb) is skipped, never blocking the submit — and every revision ≥ 2 must carry a changelog | error                                  |
| L6   | Detail soft caps (>80 lines/section)                                                                                                             | warning, surfaced as a badge in the UI |
| L7   | First-screen recommendation: a lead diagram (`mermaid`) near the top is strongly recommended (~90% of plans); a `<!-- no-lead-diagram -->` marker in Summary opts out | warning (nudge, never blocks) |
| L8   | Diagram renderability: every `mermaid` fence parses headlessly (mermaid in a happy-dom DOM); a fence mermaid cannot parse is `E_DIAGRAM_UNRENDERABLE`, so an unrenderable diagram never reaches the reviewer | error (fails open: no headless setup → no check) |

Budget numbers are config, expected to be tuned during the first week of real use.
Known residual risk: vacuous summaries pass L2 (no deterministic fix without an LLM,
which the zero-cost invariant forbids server-side) — mitigated by the human commenting
"this says nothing," which is cheap.

L8 parses **every** `mermaid` fence in the plan, not just the lead diagram, by running
mermaid's own parser in a headless happy-dom DOM at submit time — the same parser the UI
uses to render. A fence that fails to parse is a blocking `E_DIAGRAM_UNRENDERABLE` error
the agent must fix and resubmit, so a "failed to render" card can never surface to the
human reviewer. The check **fails open**: if the headless mermaid setup can't be stood up
(bad import, missing DOM globals), L8 degrades to no check rather than wedge every submit
on an infra problem.

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
| `otacon implement-done [--pr <url>] [--failed]`                             | End an `implementing` session: record the PR link and flip to `implemented`, or `--failed` → `implement_failed` (§12) |
| `otacon resume [--session <id>]`                                            | Reopen a finished session for amendment (flip terminal → `revising`): auto-detects the session that owns the cwd build worktree (its recorded `impl.worktree`), or `--session` names one. Prints the daemon's reopen body plus `title`, `repo`, `plan` (the file to amend, under the session's main repo) (§12) |
| `otacon status [--all]`                                                     | Session state + undelivered event count (crash/resume entry point); also surfaces `resumeCandidate` (id, title, status, plan) when the cwd is inside a known build worktree |
| `otacon open [--session <id>]`                                              | Open the review URL in the browser, or the index URL when no session resolves; `OTACON_NO_BROWSER` prints it instead of launching |
| `otacon config [open]`                                                      | Open the Settings web UI in the browser: `/settings?repo=<cwd repo root>` inside a repo (Project scope), bare `/settings` outside one (User scope); `OTACON_NO_BROWSER` prints the URL instead |
| `otacon config get <key>`                                                   | Read-only: print the merged effective value of one dotted key (`worktree.dir`, `budgets.summaryLines`, …) from the config files; no daemon. Unknown key → exit 1 |
| `otacon clean [--all]`                                                      | Archive ended sessions' working state to `.otacon/archive/` and prune the registry (§12) |
| `otacon update [--check]`                                                   | Update the global install to the latest published version now, bypassing the start-time throttle and `update.auto` (§16); `--check` reports current/latest/outdated without installing |

The `--resolutions` file is the revision-accompaniment document:

```json
{
  "changelog": "Kept RS256; moved the table drop to phase 3 as asked.",
  "threads": { "t1": "Moved to phase 3.", "t2": "Kept — see the new D4." }
}
```

`threads` maps comment-thread ids to the agent's replies — lint L5 requires one per
open comment thread that has none; accepted replies land on the threads as the agent's
*response* (re-replying overwrites). A reply is not a close: the thread stays open
until the **reviewer** resolves it (§9), so a comment can carry a reply and still be
open. `changelog` is the agent's summary of the revision,
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
{"event":"answer","session":"otc_a1b2c3","question":"q7","choice":"B","revised":true,"prior":{"choice":"A"}}
{"event":"approved","session":"otc_a1b2c3","path":"/Users/me/.otacon/sessions/otc_a1b2c3/2026-06-12-auth-refactor.md","home":"/Users/me/.otacon/sessions/otc_a1b2c3/2026-06-12-auth-refactor.md","implement":true}
{"event":"deleted","session":"otc_a1b2c3"}
{"event":"timeout"}
```

Every payload carries `session` so the agent can sanity-check it is handling its own plan.
An `answer` to a `--multi` question carries `choices` (an array) instead of `choice`; an
answer to an optionless question carries only `text` (`text` may also accompany a choice
as extra context). An option question also accepts a **free-form custom answer** — a
non-empty `text` with no `choice`/`choices` (native-AskUserQuestion "Other" parity), so
the user is never trapped by the offered chips. Re-answering an already-answered
question overwrites it (at-least-once: a duplicate POST is legitimate), and that second
`answer` event carries `revised:true` plus `prior` (the previous answer's content, the
defined `choice`/`choices`/`text` only, no `answeredAt`); a first answer omits both. A
`revised` answer **supersedes** the old one: the agent treats it as a correction, finds
every plan Decision citing `← q<n>` for that question and rewrites those entries from the
new value, and (if the plan is already submitted) resubmits a revision whose changelog
notes the correction. A `question` event carries `replyTo`
when it is a **follow-up** on an earlier question (§9) — the agent skims that thread's
prior turns for context and answers the new `q<n>` the usual way. A `comments` event
carries `final:true` when it is the **comment & approve** fold-in batch (§12): the
reviewer approved with comments still open and chose *Send to agent*, so the daemon
re-delivers every comment thread still owed a response (no reply yet and not
reviewer-resolved) for one solo pass — the agent replies to each, and its next clean
`submit` finalizes the plan (it then receives `approved`, which may
carry `implement:true`) instead of returning to in-review. Approval writes the plan file
and the event reports where; the agent runs no git for it.
`approved.home` is ALWAYS the absolute canonical copy in the home archive
(`~/.otacon/sessions/<id>/`). `approved.path` is the copy the agent acts on, keyed by the
optional `implement` flag: a plain `approved` (no flag, **Save**) is **terminal** —
`path` is the repo-relative project copy under `plans.dir`; the agent prints where it
landed and stops, and you commit it if you want. An `approved` with
`implement:true` (**Implement**) is **not** terminal — `path` equals `home` (no project
copy is written), and the agent reads the plan from there to walk the build loop (the
**Implement loop**, §6 below; the session sits in `implementing` until
`otacon implement-done`). `deleted` is terminal: the agent stops — it means the reviewer
discarded a pending session in the UI (§12), so there is no artifact; a parked `wait` is
woken with it immediately rather than left to 404 on its next call.

### HTTP API (daemon, 127.0.0.1 only)

```
GET  /api/health                            daemon identity + version (CLI handshake)
POST /api/shutdown                          clean daemon exit
GET  /api/config?repo=<root>                config surface for the Settings UI:
                                            {schema: CONFIG_SCHEMA, scopes} where
                                            scopes.user is {path, values} for
                                            ~/.otacon/config.json (always present);
                                            scopes.project ({path, values, repo})
                                            is the committed
                                            <repo>/.otacon/config.json and
                                            scopes["project.local"] the personal
                                            <repo>/.otacon/config.local.json — both
                                            included only when ?repo= names an
                                            absolute path. `values` are sparse +
                                            coerced (known keys that pass their
                                            type rule)
POST /api/config                            {scope:"user"|"project"|
                                            "project.local", repo?, values} —
                                            replaces the scope file with the
                                            sanitized sparse values (a cleared
                                            field is dropped → reverts to
                                            inherited). 400 on a bad/missing scope
                                            or a project scope without an absolute
                                            repo; 422 {fieldErrors} on a value that
                                            fails its type rule (writes nothing);
                                            else 200 {values}. scope=user →
                                            ~/.otacon/config.json, project →
                                            <repo>/.otacon/config.json, project.local
                                            → <repo>/.otacon/config.local.json
GET  /api/sessions                          index (registry)
POST /api/sessions                          mint + register a session (otacon start)
GET  /api/sessions/:id                      session detail (+ revision, pending events)
DELETE /api/sessions/:id                    deregister a session, status-branched:
                                            terminal (approved/implemented/
                                            implement_failed) → deregister + archive its
                                            dir to .otacon/archive/ (otacon clean + UI);
                                            non-terminal → wake the parked agent with a
                                            terminal `deleted` event, then hard-remove its
                                            dir (UI, §12). Both publish a terminal `removed`
                                            SSE frame; response carries `archivedTo`
GET  /api/sessions/:id/events?wait=540      agent long-poll
POST /api/sessions/:id/submit               lint; reject 422 with issues, or store revision N
POST /api/sessions/:id/comments             flush a comment batch; a batch item may
                                            carry {replyTo:"t<n>"} to post a follow-up
                                            on that comment's conversation — it inherits
                                            the root's anchor (a client anchor is
                                            ignored), 404 E_UNKNOWN_COMMENT on a
                                            non-comment id
POST /api/sessions/:id/questions            user question (instant); optional
                                            {replyTo:"q<n>"} posts a follow-up on
                                            that question's conversation — it
                                            inherits the root's anchor (a client
                                            anchor is ignored), 404
                                            E_UNKNOWN_QUESTION on a non-question id
POST /api/sessions/:id/questions/:qid/answer  agent's answer to a user question
                                            (otacon answer); 404 E_UNKNOWN_QUESTION
                                            on ids that are not open questions
POST /api/sessions/:id/threads/:tid/resolve   the reviewer's Resolve verb: {resolved}
                                            stamps (or clears) the close on a comment or
                                            question conversation root — {resolved:true}
                                            carries the session's current revision, doubles
                                            as the comment-withdraw path (a resolved comment
                                            owes no reply, L5 skips it). → 202 + a `thread`
                                            SSE upsert; 404 E_UNKNOWN_THREAD on a bad id;
                                            non-boolean `resolved` → 400; refused on a
                                            terminal session (E_SESSION_OVER)
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
                                            (+ a `session` frame for the chip). The
                                            same note ALSO lands in the live-activity
                                            stream (below) as a `highlight` event —
                                            redacted, truncated, daemon-assigned seq —
                                            pushed as a `stream` SSE frame. No agent
                                            event is queued — UI-only telemetry
POST /api/sessions/:id/answers              user's answer to an agent question:
                                            {question, choice|choices, text?} —
                                            validated against the question's options
                                            and multi-ness; an option question also
                                            takes a non-empty text-only custom answer
                                            (no chip); queues the answer event
POST /api/sessions/:id/approve              approve: writes
                                            the artifact to the home archive (always)
                                            + the project copy under plans.dir, flips
                                            the session approved, queues `approved`
                                            with path=project copy, home=archive
                                            (Save). With {"implement":true} it writes
                                            the home copy ONLY, flips to `implementing`
                                            (non-terminal), and queues `approved` with
                                            path=home, implement:true (§12).
                                            Unresolved threads (comments the reviewer
                                            hasn't Resolved + questions with neither an
                                            answer nor a Resolve) → 409
                                            E_UNRESOLVED_THREADS carrying both
                                            `unresolved` (the total) and `openComments`
                                            (the foldable count: comments still owed a
                                            response). The UI's warn stage
                                            offers two ways past it: {"force":true}
                                            finalizes now and drops the open threads, or
                                            {"sendOpenComments":true} — comment & approve
                                            (§12) — defers the finalize, flipping to the
                                            non-terminal `finalizing`, queuing a
                                            `final:true` comments batch of the open
                                            threads, and finalizing on the agent's next
                                            clean submit (carrying the implement choice).
                                            A second {"sendOpenComments"} while finalizing
                                            → 409 E_ALREADY_FINALIZING; {"force":true}
                                            stays open as the manual escape.
                                            No revisions yet → 409 E_NO_REVISION
POST /api/sessions/:id/implement-done       end an `implementing` build (otacon
                                            implement-done): {pr?, failed?} → flips
                                            `implemented` (default) or
                                            `implement_failed` (failed:true), records
                                            `prUrl` on the summary; a session not
                                            `implementing` → 409 E_NOT_IMPLEMENTING
POST /api/sessions/:id/reopen               reopen a finished (terminal) session for
                                            another review round (a `/otacon` run from
                                            inside the build worktree): flips it back to
                                            `revising`, pins the diff baseline at the
                                            approved revision (lastReviewedRevision =
                                            revision), and keeps `prUrl` + `impl`; a
                                            non-terminal session → 409 E_NOT_REOPENABLE
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
ask, answers, progress, approve) refuses a **terminal** session (approved /
implemented / implement_failed) with 409 `E_SESSION_OVER` — the status machine's
terminal *set* is enforced on the daemon, not just by the CLI's session-resolution
rules. An `implementing` session is **not** terminal: progress / ask / wait / answer
stay open so the orchestrating agent can narrate and pause-and-ask while it builds
(but `submit` is refused there with 409 `E_ALREADY_IMPLEMENTING` — a revision cannot
land on a plan already being built). A `finalizing` session (comment & approve, §12)
is likewise non-terminal: the agent's fold-in `submit` must still land — it is what
finalizes — so only that pass mutates it; a fresh `approve {sendOpenComments}` there
is refused 409 `E_ALREADY_FINALIZING`, and a new `comment` there is refused the same
way (a comment would otherwise flip the session back to `revising` with the
`pendingApproval` flag still armed — a later clean submit would then silently
finalize — and hand the agent an un-swept thread that wedges its L5 fold-in).
`/` and `/s/:id` serve the SPA shell (static assets under `/assets/`); an unknown
session id renders as a client-side not-found state. Each SSE stream opens with a
`snapshot` frame (the per-session stream's snapshot carries the thread list, the
grill transcript, the activity feed, and the live-activity stream's newest events; every
snapshot — index and per-session —
also carries the daemon's `version`, which open tabs use to self-heal after an
update, see §16), then pushes `session` / `revision` /
`queue` / `thread` / `grill` / `activity` / `stream` / `removed` frames as state changes — a
`revision` frame carries the revision number and its changelog; a `thread` frame is
an upsert: a new comment/question thread (a follow-up of either kind carries `replyTo`,
the root it continues), or an existing thread changing (a question gaining its answer, a
comment gaining the agent's reply or the reviewer's resolution, an anchor re-anchoring or
orphaning); a `grill` frame is the transcript's upsert: a question asked via
`otacon ask`, or an entry gaining the user's answer; an `activity` frame carries one
new progress note appended to the per-session activity log (the draft chip rides the
`session` frame's `latestActivity` instead); a `stream` frame carries one or more new
normalized live-activity events (the live-activity stream, §10a), newest last and
coalesced/batched ok, which the UI appends to its stream view by `seq`; a `removed` frame is terminal —
the session left the registry (`otacon clean`): the session list drops it live, an
open review screen flips to a quiet "session cleaned" state and
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
`~/.otacon/config.json` (the committed `<repo>/.otacon/config.json` and the
personal `<repo>/.otacon/config.local.json` override it in turn, §16),
mirroring the budgets config. Off macOS the banner is a silent no-op.

### The full loop

The installed skill wrapper has a hard implementation gate: after the skill is
triggered, the agent may research read-only and write only the session plan/resolution
files until an `otacon wait` event returns `approved` with `implement:true`. A plain user
request to "fix" or "implement" is not approval to edit project files inside an otacon
session.

1. **Start (first).** Skill triggers; `otacon start` mints the session and prints the
   review URL *before* research, so the user can watch from the first second. The
   agent then researches the codebase. On a supported agent the live-activity stream
   (§10a) auto-captures the agent's own tool calls, text, and thinking, so the routine
   work streams to the now-playing console without narration; the agent drops an
   `otacon progress` note only for occasional highlights and chapter markers. On an
   agent with no transcript adapter that floor is the *only* activity signal, so the
   notes still carry the bar there (UI-only; never an event).
   The entry point can also **resume** a finished session: when the agent runs from
   inside a build worktree otacon created (`otacon status` reports a `resumeCandidate`),
   it judges whether the request is about that plan and, if related or unsure, asks the
   user in the terminal whether to amend the existing plan or start new (the one
   confirmation that precedes any session). On resume it skips research and grill,
   edits the existing plan into the next revision, and re-enters the review loop.
2. **Grill** (§8). Agent walks the design tree via `otacon ask` + `wait`, one question
   at a time. Skipped with `--quick`.
3. **Draft.** Agent writes `plan.md`, runs `otacon submit`; loops on lint errors until clean.
4. **Review.** Agent parks in `wait`. User reads, fires instant questions
   (agent answers via `otacon answer`, returns to `wait`), stacks comments, taps Send.
   The reviewer **Resolves** a comment or question conversation when satisfied (the
   close verb, which doubles as withdraw); a comment stays open — and lit — until then,
   even after the agent replies.
5. **Revise.** Agent edits `plan.md`, writes `resolutions.json` (changelog + thread →
   reply), resubmits. Daemon lands the replies on the threads as the agent's *response*
   (not a close), re-anchors every quote in the new text (§4), computes diff vs the
   user's last-reviewed revision, pushes the changelog banner. Repeat 4–5.
6. **Approve = Save.** User taps **Save** (warned if unresolved threads exist —
   comments the reviewer hasn't Resolved, plus asks with neither an answer nor a
   Resolve — the daemon answers 409 with the count until the UI confirms). The **daemon** composes
   the artifact (`status: approved` + the grill transcript appended) and writes it to
   two places: ALWAYS the canonical home archive
   (`~/.otacon/sessions/<id>/YYYY-MM-DD-<slug>.md`), and ALSO a project copy under the
   repo's configured `plans.dir` (default `.otacon/plans`). It flips the
   session to `approved` (ending it — every further mutation refuses) and queues the
   `approved` event carrying both paths. The agent's `wait` returns the event; it prints
   a one-line summary naming where the plan was saved and stops. You commit the project
   copy if you want it in git. Session over.
   On the unresolved-threads warning the reviewer has a second choice — **comment &
   approve** (*Send to agent*): instead of dropping the open comments, the daemon
   defers the finalize (status `finalizing`) and hands the agent every comment thread
   still owed a response (no reply yet and not reviewer-resolved) in one `final:true`
   comments batch; the agent replies to them and its next clean `submit` finalizes —
   writing the same artifact, now with a `## Review notes` section recording what it
   changed (§12). The reviewer is done the instant they
   click; the chosen variant (Save vs Implement) carries through.
7. **Approve = Implement** (optional, §12). The other approve action — **Implement** —
   finalizes the plan but writes it to the home archive ONLY (nothing into the
   project), flips the session to `implementing` (non-terminal), and sets
   `implement:true` on the `approved` event with `path` equal to the home copy. The
   same agent, on receiving it, reads the plan from that home path (no commit) and then
   **orchestrates the build**: it opens a worktree off the repo's current default-branch
   HEAD and walks the phases in order — a fresh implement+test subagent per phase, then
   a separate `/code-review --fix` subagent that resolves findings, committing each
   clean+green phase. On the **first** blocked phase it pauses with an `otacon ask`
   (retry / skip / abort / guidance) and parks in `wait`. On success it opens a PR
   against the default branch (PR body = plan summary + per-phase log; no plan file
   rides in the PR — the plan lives only in the home archive) and reports it with
   `otacon implement-done --pr <url>` (or `--failed` on abort), which flips the session
   to `implemented` / `implement_failed`. All build work runs in native in-session
   subagents (subscription-covered, §13); the daemon never spawns a model.
   On a **resumed** session the build amends in place: the worktree and
   `otacon/impl-<slug>` branch already exist, so the agent does not open a second
   worktree. It builds on top of the existing commits (scoping to the phases this
   revision changed) and pushes the branch, which updates the **same** PR (its URL is
   on the session, reported by `otacon status` as `prUrl`).

---

## 7. Sessions & multi-session

Multiple concurrent planning sessions (different repos, worktrees, or features) against
one daemon.

**Identity & routing.** `otacon start` mints a session ID and registers it in
`~/.otacon/registry.json` (ID → repo path, branch, title, status). The registry is
the single source of truth — there is no local session pointer:

- Commands default to the repo's single active session: the CLI reads the registry
  and picks the one non-approved session matched by repo root **or** build-worktree
  root. A session's `.repo` is the main repo where planning happened, so a reopened
  session resolves implicitly even from inside its Implement build worktree (whose
  root matches the recorded `impl.worktree`, not the repo). Different
  worktrees = different roots = parallel planning with zero flags.
- `--session <id>` overrides everywhere, and is the only way to reach an approved
  (ended) session. If a repo has two or more active sessions, the CLI **refuses** the
  implicit default and errors with the candidate list — never guesses. Zero active
  sessions for the repo refuses too (`E_NO_SESSION`).

**Event isolation.** One event queue per session. `otacon wait` long-polls only its own
session's queue; a comment on plan A wakes only plan A's agent. N parked waits = N open
HTTP requests, no contention.

**UI switching.** The **app shell sidebar** is the persistent session list (§10): one
condensed row per active session — accent, title, repo/branch, status glyph, agent dot,
unread badge — with approved (and implemented / implement_failed) sessions folded into a
collapsed `approved (n)` disclosure below, the same split the old index read. On desktop
(≥960px) it's a drag-resizable, collapsible column (240px by default) wrapping every
route, so switching is one click from anywhere; `/` itself is a welcome pane, not the
index. Below 960px the sidebar is hidden: the home route renders the list inline (the
phone index), and from an open plan the same condensed rows are one tap away through the
review header's ☰ **overflow menu**, a bottom-sheet `SessionList` (§8). The review screen has one **sticky header** pinned to the
top of the scroll: expanded it shows the full masthead (title, revision, repo/branch,
status), the clean⇄diff toggle, and Approve; scrolling down it compacts to a tight
one-line bar and re-expands at the top (§10). The header carries the ☰ button at <960px
(where the sidebar is hidden); at ≥960px it folds away, since the sidebar is already the
list. `[`/`]` walk the active sessions in activity order (wrapping at both ends), so a
reviewer can sweep the queue from the keyboard; the shortcut mounts on the **app shell**
(the one element present on every route), so it works from the welcome and settings panes
too, not just the review screen. `●N` on a row counts the revisions this device hasn't
opened (unread state is device-local, §10); the row you are reading never wears one. Each
session gets a stable **accent color** used on the row, the header, the comment composer,
and agent-question cards, so rapid switching can't post feedback to the wrong plan.

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
chosen chip as a note. An answer is not final while the session is live: an answered card
carries an **undo** control that reveals the full option chips again (the same form
prefilled with the current answer), and submitting overwrites it (the overwrite is the
`revised` answer event of §4).

The transcript persists in `.otacon/<session>/transcript.json` — distinct from the
user-question threads in `threads.json` (different surface, different lifecycle: the
transcript ships with the artifact; threads stay review exhaust). Agent questions
mint their `q<n>` ids from the same counter as user questions, so citations and
deep links live in one unambiguous id space.

Structural integration:

- **Traceability** (§4, lint L3): plan decisions cite the grill Q&A that produced them
  (`D3 ← q7`) or wear `[assumed]`. No plan reaches review with silently-made decisions.
- **The transcript is part of the review UI**: a collapsible **"Interview" panel is the
  single grill surface** (no separate pinned queue above the plan). It has two labeled
  zones, each newest-first: an **"open"** group on top where unanswered questions are
  answered inline (the interactive card with chips/text), a divider, then an
  **"answered"** group below where each card shows only the answer (no option list) plus
  an **undo** control that reveals the full option chips to change it. The panel is
  **default-expanded during the grill phase** (status `draft`), still collapsible, and
  **auto-collapses once grill is over** (the status leaves `draft`); a manual toggle
  sticks within a phase. Each decision in the plan deep-links to its originating answer
  ("why RS256?" answered in one tap, opening the panel and scrolling to the entry,
  including what the user said at the time); the ❓ jump opens the panel and lands on the
  first open question. Once the session is read-only the archive is static: the answer
  echo with no inline form and no undo.
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
| User **comment**   | batched in a drawer; per-comment "send now" override | Flushed batch → exactly one revision, one changelog. A comment is a conversation too — **Follow up** to add a linked comment turn (same anchor); the agent replies per turn on its next submit (L5) |
| **Agent question** | instant (during grill or anytime)                    | Card in UI; user answers with chips/text                                                                           |

**Mixed flush:** questions answered first (answers may inform further review), then all
comments applied as one revision. Keeps revisions chunky — the agent never thrashes on
every keystroke.

**Follow-up conversations:** both comment and question threads are conversations, not
one-shots — after the agent responds, a **Follow up** affordance on the card posts
another turn. A follow-up is its own `t<n>`/`q<n>` thread linked to the root by `replyTo`
and inherits the root's anchor, so the rail groups the whole chain into one card that
jumps and orphans as a unit. The two kinds differ only in how the agent responds: a
**question** follow-up rides the questions route and is answered out-of-band via `otacon
answer` (plan untouched); a **comment** follow-up rides the comments route and is
answered per turn through the revise/submit loop — the agent's next submit must reply to
every un-replied comment turn (L5), so a comment conversation is revision-tied. Resolving
the root withdraws every turn of the conversation at once.

**Reviewer-driven resolution:** the agent's reply to a comment is a *response*, not a
close — only the **reviewer** closes a thread, via the **Resolve** verb (on both comment
and question conversation roots). Resolve doubles as **withdraw**: resolving a comment
that has no reply tells the agent it is dropped (L5 then skips it, so it can never
deadlock a submit). A resolved thread leaves the lit set and the Approve unresolved
count; Reopen (`resolved:false`) puts it back.

**Re-review (3 layers):**

1. **Changelog** — agent-written summary at the top of each revision banner. Submitted
   in the resolutions document (§6), required on every revision ≥ 2 (lint L5), stored
   per revision.
2. **Threads** — every comment becomes a thread the agent MUST reply to (lint L5),
   then the reviewer Resolves to close it; threads not yet Resolved are visible at a
   glance and warned on Approve.
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

A persistent **app shell** wraps every route: a left sidebar (the OTACON wordmark
linking home, the settings gear, and the live session list) beside a content track.
`/` is a **welcome pane** in the track (the sidebar holds the index now); `/s/:id` is
the open session; `/settings` is the config screen (User / Project / Project · local
scopes; reached from the sidebar gear or `otacon config`).
On desktop (≥960px) the sidebar is a column (240px by default) that is **drag-resizable**
(a separator on its right edge; the width persists across reloads) and **collapsible** to
a one-column content view (the choice persists too; a `»` handle reopens it). Below
960px the sidebar is hidden: the home route renders the session list inline, and from an
open plan it is reached through the review header's ☰ overflow-menu sheet (§7); the slim
shell mini top-bar on the welcome / settings panes carries the wordmark + the settings
gear. The shell chrome is accent-neutral; only an open review tints, via its own
per-session accent. Config is
still file-backed (§16); the Settings screen is a web editor over those files. Sections
render worktree → notifications → budgets → activity (the build-time and attention
knobs lead; the line budgets are the long tail). The worktree heading carries both
storage-location knobs — where Implement opens build worktrees (`worktree.dir`) and
where Save writes the project plan copy (`plans.dir`); they share the heading though
each is its own config section (both keys are `dir`). Each field surfaces what it
inherits when left unset (the inherited value shown as the input placeholder) and what
shadows it from above, mirroring the file overlay order
(defaults ← user ← project ← project.local, §16). The inherit hint names the nearest
scope below the active one that sets the field: the Project scope shows the user
profile's value ("default from user profile"); the Project · local scope shows the
committed project's value ("default from project") if the project sets it, else the
user profile's, else the schema default (no hint). The override hint names the nearest
scope above that shadows the field: the User scope flags a field a project or
project · local overrides ("overridden by project" / "overridden by project · local");
the Project scope flags a project · local override; an override hint wins the slot over
an inherit hint. A repo selector names the Project scope
file (the committed `<repo>/.otacon/config.json`; the Project · local scope edits the
personal `<repo>/.otacon/config.local.json` sibling that wins over it); on the User
scope it's an optional "compare repo" that only chooses which project's overrides to
surface (the user file it edits is global either way). Edits
auto-save: a text field commits when it loses focus, and a checkbox or a
reset-to-inherit commits on the spot, so there is no Save button to forget. The save
confirmation surfaces as a toast pinned to the viewport, so it is seen the instant it
fires no matter how far the form is scrolled.

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

### Sidebar session list + welcome pane

The app shell's left sidebar is the persistent session list (the desktop index).
Its header row carries the graphic OTACON wordmark (§3, the home link) on the left, with
the settings gear and a `«` collapse toggle grouped on the right; the column itself is
**drag-resizable** (a right-edge separator, width persisted) and **collapsible**. Below
the header, one condensed row per session: accent, status glyph, title, repo + branch,
agent-presence dot, an unread badge, and a hover-revealed delete. Click → review screen. The same status
derivation drives the row glyph and the review chip: `awaiting your review` /
`agent revising` / `questions pending` /
`approved` / `implementing` / `implemented` / `implement failed`, plus an
**activity-driven draft chip**: while a session is in `draft`
(it sits there through research + drafting, before revision 1 exists) the chip
shows the latest `otacon progress` note (truncated), falling back to `agent
working` until the agent narrates — so the chip never claims "drafting" while the
agent is still reading. The **agent-presence dot** (live/offline) sits beside the
chip — a subtle "is the agent still on the line?" mark, distinct from the
browser↔daemon link dot, which now lives in the review header's status row (labelled
`agent` vs `link`); the status chip stays the primary "your turn" signal. The dot is live while the agent is parked in
`otacon wait` or its last contact is recent, and is hidden on approved sessions.

**Approved sessions group separately.** The main list holds only active sessions
(drafting / in review / revising / **implementing** — a live build is active work, so
it stays in the list, not grouped away); approved (and implemented / implement_failed)
ones fold into a collapsed `approved (n)` disclosure below it, one click to expand (the
same disclosure idiom as the activity panel). Approved plans stay readable: opening an
approved row shows its read-only plan — the disclosure is the only entry point now the
list no longer keeps them in the active set.

**Welcome pane.** With no session open, `/` depends on width. At ≥960px it shows a short
welcome in the content track: when the registry is empty, the empty-state copy (run
`otacon start`; the offline hint appears when the daemon link is down); otherwise a brief
"pick a session" prompt pointing at the sidebar. Below 960px the sidebar is hidden, so
`/` renders the live session list (the condensed cards) inline instead, the way the home
screen always read on a phone.

**Mobile (below 960px).** The sidebar is hidden, so the list is reached two ways: the
home route (`/`) renders it inline (the phone index), and an open plan reaches it through
the ☰ **overflow menu** in the review header (§7), a scrim-backed bottom-sheet
`SessionList` dismissed on a row tap, a scrim tap, Esc, or any route change. The welcome
and settings panes carry a slim shell mini top-bar (wordmark + settings gear) so brand
and config stay reachable where the sidebar is hidden. The status chip / agent dot /
unread vocabulary above is what the inline list, the sheet, and the desktop sidebar rows
all render: one list, three placements. At ≥960px the sheet is never opened; the `»`
collapsed-sidebar handle is the equivalent "show sessions" control there.

Every session carries a small delete control on its card — and one in the review
screen header — to remove it from the index without dropping to the CLI. It opens a
confirm sheet (mirroring Approve), and the disposition (and the sheet's copy) follow
status (§12): an **approved** session is archived (recoverable — its plan is preserved
in the home archive `~/.otacon/sessions/<id>/`), a **pending** one is permanently
removed. The card
control stops its click from following the card link; deleting from the review screen
returns to the index.

### Review screen — desktop (Google-Docs margin model)

```
┌──────────────────────────────────────────────────────────────────┐
│ auth-refactor  r4 · in review   [Clean|Diff]  [session ▾] ✓Approve│
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
    top strip = the sticky header; it compacts to one line as the plan scrolls
```

- Sticky header: one always-present masthead pinned to the top — title, revision,
  repo/branch, status, the agent-presence dot, the clean⇄diff toggle, and Approve, plus
  (only <960px, where the sidebar is hidden) the ☰ "show sessions" button that opens the
  mobile session sheet (§7). It **compacts** to a tight one-line bar as the plan
  scrolls down and re-expands at the top; because it is a single element there is no
  second copy to keep in sync. The review page disables scroll anchoring so the header's
  compaction cannot perturb the scroll offset, which would otherwise re-cross the fold and
  flicker the header. The diff baseline picker, the changed-section tally
  (`j`/`k`), and the changelog recall live below it in a contextual in-flow strip, not
  in the header.
- Lead diagram: the Summary's ` ```mermaid ` chart (§4) is the **first screen** —
  the Summary section and its diagram lead the reading column, the diagram lifted by a
  2px accent top rule so the change's shape reads before its prose. Absent on plans that
  opted out of a lead diagram.
- Select text → docked Comment/Ask bar: **Comment** (→ drawer) | **Ask** (fires
  immediately; thread shows "answering…" until the reply lands). The bar docks at a
  fixed bottom edge instead of floating over the selection: the native selection and
  dictionary popovers (the iOS long-press callout, the macOS force-click Look-Up) can't
  be suppressed on the web and land right on the selection, so the bar coexists by
  staying out of that zone on both phone and desktop. It only appears where the anchor
  can survive: selections touching renderer chrome (mermaid SVG labels, fence captions,
  slug anchors, size badges — text that exists only in the rendered DOM, never in the
  plan markdown the agent reads) get no bar. Desktop keeps the `c`/`q` shortcuts.
- Drawer = bottom bar: review/edit/delete pending comments, per-comment **send now**,
  **Send all**; when nothing is pending it shrinks to the whole-plan comment
  affordance alone.
- Unsent-drafts gate: drawer comments live only in the browser until **Send all**,
  so picking an approve variant while N drafts are staged opens a drafts stage with
  three moves. **Send & approve** flushes the batch into open threads and folds them
  in through the comment & approve path in one click; **Discard & approve** drops the
  local drafts (irreversible) and finalizes the chosen variant; **Cancel** backs out
  (the safe default). The gate fires after the variant pick, so Send/Discard inherit
  Save vs Implement. The same staged drafts also arm a
  reload/close-tab guard (`beforeunload`) so a page unload warns before wiping them;
  the guard is scoped strictly to staged drafts (a clean drawer never prompts) and
  covers reload and close-tab only, with navigate-away and half-typed composer text
  out of scope. Everything here is browser-only: the daemon never sees these drafts,
  so nothing in this gate touches the protocol.
- Threads rail: clicking an anchored thread scrolls to its section and flashes the
  quoted text in the plan. Both kinds render through one shared **conversation card** —
  the root plus each follow-up turn, each turn paired with the agent's response (or the
  blinking pending cursor: "answering…" for a question, "responding…" for a comment) —
  with a collapsed **Follow up** button that reveals a reply box for the next turn, plus
  a **Resolve** button to close the whole conversation. The two kinds differ only in the
  agent's text and the follow-up route: a **question** turn shows its `answer` and a
  follow-up posts to the questions route; a **comment** turn shows its `reply` (labelled
  with the revision it landed on) and a follow-up posts to the comments route (an
  un-replied comment's Resolve is a withdraw). When the **reviewer** Resolves: a question
  conversation shows its inline ✓ mark with the resolved revision; a comment conversation
  collapses to a ✓ line (id, the reviewer's resolved revision, section) that expands to
  the whole conversation — every turn and its reply. Either kind then offers a **Reopen**
  control that re-opens the resolved conversation (`resolved:false`). The ✓
  card is keyed on the reviewer's close, never on the mere presence of a reply.
  Resolve/Reopen/Follow up all hide read-only
  (session over). A **detached thread** — whose quoted text changed in a later revision
  and can no longer be located — stays **inline in the same list** as every other
  thread; its quote renders **muted** (no live text to jump to or flash, so it is not
  clickable) beside a subtle icon whose hover tooltip explains the quote changed in a
  later revision. A conversation keys on its root, so a detached root keeps its whole
  chain inline too. (Internally the anchor still carries `anchorState:"orphaned"`; the
  UI never surfaces that word or a revision number.)
- Persistent thread marks (clean view): open threads and unsent drafts keep their
  anchored text lit — questions one ink (underlined), comments + drafts another — so
  the two read apart and stay legible without color; the click-flash still pops above
  them. Reverse interaction: a **tap** (collapsed selection) on a lit span scrolls its
  rail thread into view and pulses it, while a **drag** still starts select-to-comment,
  so the gestures never clash.
- New revision → banner: _changelog / diff / dismiss_. Shown while the latest
  revision is newer than last-reviewed — derived state, so it survives reloads and
  shows on every device — and only from r2 on: the first read of a plan is a first
  review, not a re-review. Dismiss marks the revision reviewed; a **Changelog**
  control in the contextual strip re-opens the current revision's changelog afterwards.
- Diff mode renders the server's hunks inside the same reading column; a baseline
  picker ("vs r2 ▾") selects any prior revision and the clean view's gutter markers
  follow the same baseline. Unchanged sections collapse to status-tagged rails —
  the clean reading is one toggle away. Selection anchoring works only in clean
  view; diff lines are telemetry, not plan text an anchor could survive on. Markers
  (and the banner) wait for a first review: with no baseline everything is new, and
  marking every section says nothing.
- Collapsed Details show size badges ("▸ 34 lines · 1 diagram · 2 code blocks") —
  skipping is a conscious choice. L6 warnings render here.
- Agent questions: answered in the collapsible **"Interview" panel** (§8), the single
  grill surface, with open questions in an "open" zone (chips + free text, session-colored)
  on top, answered ones in an "answered" zone below, and default-expanded during the grill
  phase. Decisions deep-link into it; the ❓ jump lands on the first open question.
- Live activity rides the always-on **now-playing bar + console** (§10a), pinned under
  the header: the automatic, cross-agent stream of the agent's tool calls, text, and
  thinking, with `otacon progress` highlights inline as chapter markers. It is the
  primary "what is the agent doing right now?" surface during research + drafting,
  shown from the first second (it replaces the old default-closed Activity fold). The
  header also carries the agent-presence dot.
- Keyboard: `j/k` jump changed sections, `c` comment, `q` ask, `[`/`]` previous/next
  session (walks the active sessions in the session list, §7). **No shortcut for
  Approve, on purpose.** Approve warns on unresolved threads.

### Review screen — phone (one thumb, walking)

```
┌──────────────────────┐
│ auth-refactor  ●srch │  ← sticky header: title + chips + [clean|diff] (accent)
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
- The sticky header stays lean on phone: title + the clean⇄diff toggle + the ☰
  "show sessions" button (which opens the session sheet, §7). The revision and Approve
  are not in the phone header — Approve and the question tally live in the bottom bar
  instead, never shown in two places; the toggle stays so diff review is still reachable.
- Threads open as bottom sheets. Sticky bar = whole control surface: pending
  questions ❓ (tap → opens the Interview panel and lands on the first open question),
  drawer + Send, Approve (confirm sheet: Save r4 to the project copy / Implement from
  the home archive — §6, §12). The bar is the desktop drawer augmented at the phone
  breakpoint — approve and the question tally fold into it and leave the header strip,
  never shown twice.
- Agent question cards answerable with chips — designed for grilling on the move.
- Touch inputs (composer, drawer edit, grill answer) are sized ≥16px so iOS never
  auto-zooms the page when a field is focused; the viewport meta stays permissive,
  so pinch-zoom stays available for accessibility.
- Bottom sheets are keyboard-aware: every sheet (composer, the section ⋯ menu,
  the approve confirm) rides above the on-screen keyboard — tracked live via the
  VisualViewport API — so its actions never hide under the fold, and the plan
  behind a sheet is locked so it stops drifting while you type.

### Cross-cutting

UI updates over SSE (watch status flip from _revising_ to _new revision_, answers
stream into threads). Mobile-first CSS. A thread whose quote can no longer be
located stays inline in the threads rail with its quote muted. The review screen
reports its visibility to the daemon
(`POST /presence`) so desktop attention banners (§6) fire only when you are not
already watching that review.

### 10a. Live-activity stream

The live-activity stream is otacon's automatic, cross-agent record of what the agent
is *doing* while it researches and drafts — a step beyond the manual-only `otacon
progress` feed. It is a single normalized event stream the daemon owns; capture sources
(a per-session tailer reading the agent's own transcript, below) append to it, and an
`otacon progress` note flows into the *same* stream so a manual highlight sits inline
with the captured activity — both are indistinguishable downstream.

**Event shape.** Each entry is a `StreamEvent`: a daemon-assigned monotonic `seq` (per
session), an ISO `at`, a `kind` (`tool` · `text` · `thinking` · `highlight` —
`highlight` is an `otacon progress` note), a one-line `label` ("Read src/auth.ts" ·
"Bash: bun test" · "thinking…"), an optional expandable `detail` (the truncated +
redacted body), the raw `tool` name when `kind === "tool"`, and an optional `status`
(`running` · `ok` · `error`).

**Normalization (daemon-side, mandatory).** Every raw capture passes one normalizer
before it is stored or pushed: secrets are redacted out of `detail` (API keys,
bearer/`token=`/`password=` pairs, AWS `AKIA…` ids, PEM private-key blocks, `.env`-style
`KEY=secret`) — best-effort, never a security boundary — then `detail` and `label` are
truncated to their configured caps (`stream.detailMaxChars`, `stream.labelMaxChars`), so
a high-frequency or large-bodied capture source can never bloat a payload or leak a key
into a review screen. Redaction and truncation live in the shared normalize path, so no
capture source can skip them.

**Storage (`<repo>/.otacon/<id>/stream.jsonl`).** Append-only JSONL — one `StreamEvent`
per line — so a frequent capture source pays a cheap append, not a whole-file rewrite,
on the common path. The file is capped at `stream.cap` events: it is rewritten to the
newest N only when it grows past the cap (older lines drop off the front). Reads are
corrupt-line-tolerant: a torn final append or a hand-edit is skipped, never fatal — a
JSONL stream's value is the lines that *did* parse, so a single bad line never
quarantines the whole file (unlike the JSON state files, §13). The stream is ephemeral
working state under `.otacon/`, like the activity feed and threads — it is not part of
the approved artifact and is never archived to the home store.

**Surface.** The per-session SSE snapshot carries the newest `stream.cap` events; a
`stream` frame (above) pushes new events live (newest last, coalesced/batched ok). The
draft chip still rides `latestActivity` (the activity feed), not the stream.

On the review screen the stream renders as an always-on **now-playing bar** pinned
directly under the sticky header, which expands into a full **live console**. The bar is
one mono line: the latest *meaningful* event's label (a trailing `thinking` shows
dimmed/italic), a ticking elapsed timer while the newest tool call is still `running`, a
live pulse dot whenever the session is agent-active (`draft`/`revising`/`finalizing`/
`implementing`, calm otherwise), and a small **mode badge** reading `live` once any
captured (tool/text/thinking) event exists (an adapter is attached) or `notes` while the
stream holds only `highlight` progress notes (the floor). The bar is shown whenever the
agent is active *or* any stream event exists, including pre-plan research, not gated on a
plan existing, so the work is never buried (it replaces the old default-closed activity
fold). The console below it is a terminal-feel list, newest at the bottom, that
auto-scrolls to the latest only while the user is already pinned to the bottom; it
starts collapsed by default and the user expands it via the toggle (the one-line
now-playing bar is always shown while there is activity, so the console never
auto-expands and the manual choice always sticks). The console pairs each tool
`running` event with its later `ok`/`error` outcome into one row carrying the final
status, collapses consecutive same-label rows into one counted row ("Read ×5",
expandable), renders `highlight` notes as emphasized chapter dividers, reveals a row's
`detail` on expand, filters by kind (all / tools / text / thinking), and hides `thinking`
behind an off-by-default toggle (the noisiest kind). The draft chip and the index card
keep riding `latestActivity`: the bar and console are the firehose, while the chip stays
the one-line summary.

**Capture: the transcript tailer.** While a session is active the daemon runs a
per-session *tailer* that watches the coding agent's own on-disk transcript and feeds
new activity into the stream — no per-agent hook, no cooperation from the agent. It is
bound to the session lifecycle: it starts when the session is created (or, after a
daemon restart, for every still-active session) and stops the moment the session goes
terminal (Save/approve, implement-done, or delete). An `implementing` session keeps its
tailer so the build's activity keeps streaming. The tailer polls the transcript on a
short interval (a plain poll loop, chosen over `fs.watch` for cross-platform
reliability), so a burst of writes between two polls naturally coalesces into one append
and one `stream` frame. It re-locates while no transcript is found yet — a session can be
created a beat before the agent's transcript file appears.

**Adapter authoring contract.** Each coding agent is supported by a small
`TranscriptAdapter` (one per agent); the daemon holds an ordered registry of them.

- **`locate(repoRoot) → handle | null`.** Find the *freshest* transcript whose recorded
  working directory equals the session's repo root (cwd + recency), or `null` when this
  agent has none for that repo. "Freshest" breaks ties by file mtime; the recorded cwd
  (read from the transcript itself) is what authoritatively matches a transcript to a
  repo — a dir-name encoding may only be a hint.
- **`parse(handle, cursor) → { events, cursor }`.** Read incrementally from
  `cursor.offset` to EOF, consume only *complete* lines (never a trailing partial — leave
  the offset before it so the next poll completes it; advance by bytes, not characters),
  and map each recognized record to a `RawStreamEvent` (`kind`/`label`/`detail`/`tool`/
  `status`). The `cursor` is opaque to the daemon: `offset` plus any per-adapter carry
  (e.g. the resolved repo root), round-tripped untouched. A non-JSONL source uses the carry
  *instead of* the byte offset for incrementality — the OpenCode SQLite adapter leaves
  `offset` unused and carries a high-water `time_created` watermark plus the part ids
  emitted at exactly that watermark (the same-millisecond tie set), so each poll returns
  only newer parts and never re-emits.
- **Append-only outcomes.** The store never upserts. A tool's `running` event and its
  later `ok`/`error` outcome are **two separate appended events**, not one mutated row —
  an adapter emits the outcome as a follow-on event, never an edit to the earlier one.
- **Fail-soft, always.** A malformed line, a vanished/rotated file, or any parse error is
  skipped, never thrown. The daemon catches a throwing `locate` as "no match". The worst
  case is the session running on the `otacon progress` floor for that tick.
- **Supported agents.** Claude Code, Codex, and OpenCode ship adapters and are
  auto-captured. Claude and Codex each tail one JSONL transcript; OpenCode keeps its
  sessions in a local SQLite database (`$XDG_DATA_HOME/opencode/opencode.db`, default
  `~/.local/share/opencode/`), so its adapter reads that DB *read-only* (Node's built-in
  `node:sqlite`, no extra process) and walks the `session`/`message`/`part` tables, mapping
  `part.data` of type `text`/`reasoning`/`tool` to text/thinking/tool events. Every other
  agent degrades to the floor.
- **The floor (graceful degradation).** When *no* adapter matches a repo's agent, the
  registry returns `null`, no tailer attaches, and the session streams only its manual
  `otacon progress` highlights. Every agent therefore gets at least the floor; an adapter
  only ever *adds* automatic capture on top of it.

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

| Location                                          | Contents                                                                                                       | Git                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `<repo>/.otacon/`                                 | Working state under `<id>/`: `plan.md`, revision snapshots `r1.md…rN.md` (each with the lint warnings it was accepted with, `rN.warnings.json`, and its agent changelog, `rN.changelog.md`), threads (`threads.json`: comment + question threads with answers, agent replies, reviewer-resolve closes, and anchor states inline), the grill transcript (`transcript.json`), the capped live-activity feed (`activity.json`: the newest ~N `otacon progress` notes), the live-activity stream (`stream.jsonl`: the normalized, capped, append-only event stream, §10a), queues | the user's call — otacon manages no `.gitignore` |
| `~/.otacon/worktrees/<slug>/`                     | Implement build's git worktree on branch `otacon/impl-<slug>` (base dir is `worktree.dir`, default `~/.otacon/worktrees` — outside the repo)                    | n/a (global, outside the repo)             |
| `~/.otacon/sessions/<id>/YYYY-MM-DD-<slug>.md`    | Canonical approved plan, every session (`status: approved` frontmatter + grill transcript)                     | n/a (global, permanent archive)            |
| `<repo>/<plans.dir>/YYYY-MM-DD-<slug>.md`         | Save-time project copy (default `.otacon/plans`; set `plans.dir=docs/plans` to group with tracked plans)       | yours to commit (or not)                   |
| `~/.otacon/registry.json`                         | Session registry: ID → repo, branch, title, status, `prUrl`, and `impl` (the build's worktree + branch, recorded at Implement-approve; see below)                                                             | n/a (global)                               |

Every approved plan lands in the **home archive** keyed by its session id — the
canonical copy a downstream implementer (or a future you, on any machine) can always
find, never touched by `otacon clean`. On **Save** it additionally writes a project copy
under the repo's `plans.dir`; you commit that copy if you want it tracked. otacon manages
no `.gitignore`, so whether `.otacon/` working state is tracked or ignored is the user's
call. `otacon clean`
archives ended sessions' working state: for every **terminal** session (approved, plus
implemented / implement_failed once a build finishes) in the current repo (`--all`:
everywhere), it calls `DELETE /api/sessions/:id`; the daemon drops the registry entry and
**archives** `.otacon/<id>/` to `.otacon/archive/<id>/` in the session's repo (name
collisions get a numeric suffix), reporting the destination as `archivedTo`. The home
archive (`~/.otacon/sessions/`) is **never** touched by clean — it is the permanent
record. Events still queued on an ended session are archived with the directory rather
than blocking the clean. There is no plan-file archive step: the plan is not in the repo
on Implement (it lives in the home archive), and on Save the project copy is the user's to
manage. Clean should also prune a finished or aborted build's impl artifacts — the
`<worktree.dir>/<slug>/` worktree (via `git worktree remove`, default base
`~/.otacon/worktrees`) and its `otacon/impl-<slug>` branch — which a per-phase-commit
build otherwise litters on disk.

**Deleting any session** from the review UI (§10) reuses that same route, and the
disposition follows whether the session is terminal (its plan is in the home archive).
A **terminal** session (approved, or a finished build — implemented / implement_failed)
takes the clean path above: its dir is archived (recoverable) because its plan +
transcript are already preserved in the home archive (and, on Save, the project copy).
A **non-terminal** session (draft / in_review / revising, or a live `implementing`
build) has no ended-and-archived artifact to keep, so the daemon wakes any parked agent
with a terminal `deleted` event (§6) — so its
`wait` loop stops cleanly
— drops the registry entry, and **hard-removes** `.otacon/<id>/` permanently. The wake
fires before deregistration so the woken long-poll still resolves against a live session;
the queue is marked closed first so a late post-response ack cannot recreate the
directory after it is removed/archived. Both paths publish the same terminal `removed`
SSE frame; an agent that was not parked at delete time discovers it via the next call's
404.

**The approved artifact** is the final revision's markdown with the frontmatter
`status` rewritten to `approved` and `revision` corrected to the daemon's count (the
daemon owns both), plus the grill transcript appended as an `## Interview` section —
one `### q<n> — <question>` per entry with an `- Options:` line (recommended option
tagged `(recommended)`, `(multi)` on the label for multi-choice) and an `- Answer:`
line (`choice`/comma-joined `choices`, ` — text` appended when both were given,
`_unanswered_` when the question was never answered). A `--quick` session's empty
transcript appends no section. When the approval went through **comment & approve**
(§6), a `## Review notes` section follows the Interview — one `### t<n> — <section>`
per comment the agent folded in unreviewed (the response-owed comments: no reply yet and
not reviewer-resolved), the reviewer's comment as a blockquote and the agent's reply
beneath it — so the trusted fold-in stays auditable
(a plain or *commit-anyway* approve folds nothing in, so the section is omitted).
The reviewer reaches this same fold-in in one click even from browser-only drafts the
daemon never received: picking an approve variant with unsent drawer comments opens the
client-side drafts gate (§10), whose **Send & approve** flushes the batch into open
threads and then approves with `{sendOpenComments}`, so staged-but-unsent comments
count toward the plan instead of vanishing at approve.
The same artifact is written to the home archive (always) and the project copy (on
Save). The filename is dated with the approve day and slugged
from the session title; a taken name gets a `-2`, `-3`, … suffix — never overwritten.
The artifact is post-lint output: the closed plan schema (§4-5) governs submits, not
this file. Approve ends the session **logically** — `status: approved` excludes it
from implicit CLI resolution and every mutating verb refuses — while `.otacon/<id>/`
stays on disk (the parked `wait` still drains the `approved` event from it) until
`otacon clean` archives it. In the UI, the moment the session you're viewing flips to
approved, the review screen navigates home (the session list drops it from the active
set, §7); this fires only on the live non-approved → approved transition, so opening an
already-approved session from home does **not** redirect and the approved plan stays
readable.

Session status machine:
`draft → in_review ⇄ revising → approved` (terminal), with the **Approve & Implement**
branch `approved → implementing → implemented | implement_failed`. **Comment & approve**
inserts a deferred-finalize hop: `revising → finalizing → approved | implementing`
(the agent's fold-in submit finalizes, carrying the variant the reviewer chose). The
terminal *set* is `{approved, implemented, implement_failed}` — the open-verb guard
(§6 `E_SESSION_OVER`) and the CLI's implicit-session resolver both gate on it, so they
can never disagree about what "over" means. `implementing` is deliberately **not**
terminal: it re-opens progress / ask / wait / answer for the orchestrating agent and
resolves as the repo's active session (so the agent can't bail mid-build and `resume`
re-adopts it), and the Stop hook (§13) treats it as live. `finalizing` is likewise
non-terminal — the agent's clean `submit` is what finalizes it — and a hung fold-in
is escapable: an `approve {force:true}` there commits the current revision and drops
the still-open threads.

Terminal is **not strictly one-way**: a finished session can be **reopened** back to
`revising` via `POST /api/sessions/:id/reopen` (the reverse edge). This powers
worktree-keyed amendment: a `/otacon` run from inside an Implement build's worktree
reopens the *same* session to amend the approved plan in place instead of spawning a
second worktree. Reopen pins the diff baseline at the approved revision and keeps
`prUrl` + `impl` intact, so the next submit diffs against what was approved and the
amendment still belongs to the same build. Detection rests on the **`impl`** field on
the session record (`{worktree, branch}`, deterministic from the title slug +
`worktree.dir`), written at Implement-approve in the same registry write that flips to
`implementing` (recorded at approve time, not at build start, so detection survives an
aborted build). Terminal therefore means "over until explicitly reopened", not "forever".

```
                                         ┌─ Approve ──────────────► approved (terminal)
draft ─► in_review ⇄ revising ──────────┤  (Send to agent ─► finalizing ─► submit ─┘
            ▲                            │   or ─► implementing, per the variant)
            │                            └─ Approve & Implement ──► implementing
            │                                                          │
            │ reopen (from any                  implement-done         │
            │ terminal state)             ┌──────────────────────────┤
            │                             ▼                          ▼
            └──────────────────────  implemented              implement_failed
                                        (terminal)                 (terminal)
```

Any **terminal** state has a `reopen` reverse edge back to `revising` (the dashed line
above), used by worktree-keyed amendment (above).

### Implement: worktree, per-phase commits, PR

The **Implement** approve action finalizes the plan (home archive only — nothing in the
repo), then flips the session to `implementing` and hands the same agent the build (§6).
The agent reads the plan from the home archive at the event
`path` and opens a git worktree at **`<worktree.dir>/<slug>`** — `worktree.dir` is
config (§16, default `~/.otacon/worktrees`, outside the repo so the build tree never
lands in the project; the agent reads it with `otacon config get worktree.dir`) — on a
new branch
**`otacon/impl-<slug>`** rooted at the repo's **default-branch HEAD**, and walks the
phases in order: per phase, a fresh implement+test
subagent (scoped to that phase's Goal/Files/Verification), then a separate
`/code-review --fix` subagent that applies findings; a clean+green phase is committed
(**one commit per green phase**) before the next begins. On the **first** blocked phase
the agent pauses with an `otacon ask` and parks. When every phase is green it opens a PR
against the repo's **default branch** with `gh` (PR body = the plan summary + the
per-phase log; it falls back to noting the local branch + path when there is no remote),
then reports the outcome with `otacon implement-done --pr <url>` (or `--failed` on
abort) — flipping the session to `implemented` / `implement_failed` and recording `prUrl`
on the summary (surfaced as the home card's PR link, §10). `otacon clean` should prune a
finished or aborted build's impl worktree and branch alongside archiving its session
state. The whole build runs in native in-session subagents (subscription-covered, §13);
the daemon never spawns a model.

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
- **Approve & Implement keeps the invariant.** The build is orchestrated by the same
  live interactive session; every phase's real work runs in a **native in-session
  subagent** (the agent's Task tool), which is subscription-covered exactly like the
  parent. The daemon still spawns nothing and calls no model — it only records the
  `implementing` → `implemented`/`implement_failed` transition and the PR link.
- The protocol demands only "can run shell commands" + "can edit files" — why the
  identical loop works on Claude Code, Codex, and OpenCode subscriptions.
- **Forward constraint for `snake`:** same rule. Orchestration via instructions + this
  CLI + interactively-started sessions (or native in-session subagents, which are
  subscription-covered). Never SDK-spawned workers. The approved plan file in the home
  archive is the sole handoff interface.

### Failure modes

| Failure                                                                 | Mitigation                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent lazily ends its turn mid-review or mid-build                      | Skill instruction ("never end your turn while the session is open") + **Claude Code Stop hook** (plain shell script): if a non-terminal session exists, block the stop with "plan session still active — run `otacon wait`". An `implementing` session blocks too (the build is live; only `approved`/`implemented`/`implement_failed` let the agent stop). Codex/OpenCode start instruction-only; both have notify/plugin equivalents for later hardening |
| Agent bypasses the remote channel with native AskUserQuestion           | Skill forbids it; v1.5: PreToolUse hook blocks AskUserQuestion (and optionally Edit/Write outside `.otacon/`) while a plan session is active                                                                                                                                                                         |
| Session dies (crash, closed laptop, context compaction)                 | Agent is stateless; events queue on the daemon. Any new session: `otacon status` → open session, current revision, undelivered events → resume the loop                                                                                                                                                              |
| Detail-tier smuggling (load-bearing content hidden in collapsed blocks) | Normative/informative contract + lint L4 heuristics + size badges + diff gutter markers on detail changes                                                                                                                                                                                                            |
| Budget gaming (vacuous summaries)                                       | No deterministic fix; visible to the human, who comments "this says nothing." Accepted residual risk                                                                                                                                                                                                                 |
| Occupied terminal during review                                         | Inherent to the no-SDK constraint (the interactive session is the only allowed brain). Practice: open another tab/worktree for parallel work                                                                                                                                                                         |
| State file corrupt on disk (registry / session / events JSON)           | Quarantined, never fatal: the file is atomically renamed to `<name>.corrupt-<timestamp>` with a stderr log and the daemon continues with a fresh structure — session `revision` is recovered from the `r<N>.md` snapshots. Corruption can cost queued events or counters, never the ability to keep working          |

---

## 14. Out of scope (v2+)

- **`snake`** — a *detached* implementer skill: consumes an approved plan from a fresh,
  unattended session (phone-only, fire-and-forget), rather than the live same-agent build
  that **Approve & Implement** (§6) now ships. Still future.
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
npm install -g otacon        # one package: CLI + daemon (Node ≥ 20); the `latest` dist-tag
                             # (or `npm install -g otacon@staging` to opt into preview builds)
otacon install --all         # write agent skill wrappers; or --agent claude|codex|opencode
                             # --hooks also registers the Claude Code Stop hook
otacon doctor                # verify: node ≥ 20, daemon boots + port free-or-ours,
                             # wrappers present, Tailscale status (hard failures exit 1;
                             # optional pieces are warnings). The Stop hook is optional —
                             # confirmed when present, never flagged when absent. Run
                             # inside a repo, each wrapper check also accepts a project
                             # wrapper (otacon install --project), reporting the scope it
                             # found; a miss names the otacon protocol skill, not "wrapper"
otacon expose                # optional, phone access: checks the tailscale CLI exists
                             # and is logged in, runs `tailscale serve` against the
                             # daemon port, verifies the tailnet URL actually serves
                             # (needs HTTPS certs enabled), prints the URL to bookmark
```

`otacon install` writes the thin protocol wrapper — one protocol card teaching the
full loop (§6), grill discipline (§8), and the never-end-your-turn rule (§13) — into
each agent's skill location: Claude Code `~/.claude/skills/otacon/SKILL.md` plus the
Stop hook script `~/.claude/hooks/otacon-stop.sh`; Codex
`$CODEX_HOME/skills/otacon/SKILL.md` (default `~/.codex/`); OpenCode
`$XDG_CONFIG_HOME/opencode/skills/otacon/SKILL.md`. All three are the same SKILL.md
skill folder. Wrappers are managed files — reinstall overwrites them. The Stop hook registration in
`~/.claude/settings.json` is optional, applied only by `--hooks`: an additive,
idempotent merge that preserves every existing key and backs the file up before the
first change (unparseable settings are refused, never clobbered). The hook is a
belt-and-suspenders guard on top of the skill's never-end-your-turn rule (§13), not a
required piece — so without `--hooks` install neither registers nor nags about it, and
`otacon doctor` confirms it when present but never flags its absence. `otacond` is never
installed or started by hand — any `otacon` command auto-spawns it if it isn't
running, and the CLI restarts a stale daemon on version mismatch (version handshake
on every call).

**Single source for the protocol card.** The card text is built once, parametrized
only by command prefix (`protocolCard(cmd)` in `src/cli/install/assets.ts`): the
installed wrappers use `otacon`, while this repo's own committed dogfood wrapper
(`.claude/skills/otacon-dev/SKILL.md`) uses the run-from-source `./bin/otacon` prefix and
prepends a repo preamble. The dogfood wrapper is named `otacon-dev`, not `otacon`, so it
never collides with the installed product skill when developing otacon itself: in this
repo `/otacon` stays the real product and `/otacon-dev` is the source-mode wrapper. The
dogfood file is **generated** from `dogfoodSkillMd()`,
not hand-edited, and a test (`assets.test.ts`) asserts the committed file equals that
output — so a protocol change can never silently drift between what `otacon install`
writes elsewhere and what this repo runs.

**Single source for the version.** `package.json`'s `version` is authoritative;
`src/shared/version.ts` (the `VERSION` the version handshake compares, §13) is
**generated** from it by `scripts/gen-version.ts`, run automatically by the `npm
version` lifecycle hook on every bump — never hand-edited. A test guards that the two
stay equal, the same generated-file discipline as the protocol card.

### Per-repo setup

**None required.** Otacon works in any git repo with zero configuration. The first
`otacon start` in a repo creates `.otacon/` for its working state. otacon **manages no
`.gitignore`** — it never reads, writes, or migrates the repo's ignore file. Whether
`.otacon/` is tracked or ignored is entirely the user's call; nothing under it is
special-cased by git on otacon's behalf, so the personal `config.local.json` override
is committable too unless the user ignores it themselves. The Save-time project copy
dir (`plans.dir`, default `.otacon/plans`) is created on first Save. Build worktrees
default **outside** the repo (`~/.otacon/worktrees`, §12), so a fresh `.otacon/` never
fills with throwaway build trees.

Config is layered, mirroring Claude Code's `settings.json` + `settings.local.json`
(otacon just doesn't auto-ignore the `.local` file): built-in defaults ←
`~/.otacon/config.json` (user) ← `<repo>/.otacon/config.json` (project,
**committed/team-shared**) ← `<repo>/.otacon/config.local.json` (project.local,
**personal**) — closest wins. Every override file is optional. Tunables include
budgets/lint caps, the activity feed (`activity.cap`, `activity.noteMaxChars`), the
live-activity stream (`stream.cap`, `stream.detailMaxChars`, `stream.labelMaxChars`, §10a),
`notifications.desktop`, `worktree.dir` (base dir for Implement build worktrees, default
`~/.otacon/worktrees`, outside the repo), `plans.dir` (where **Save** writes the
project copy of the approved plan, default `.otacon/plans`; set it to `docs/plans` to
group it with other tracked plans), and `update.auto` (auto-update at `otacon start`,
default true; see Updating below). The home archive location is fixed
(`~/.otacon/sessions/`), not configurable.

Config is editable two ways over those override files: by hand, or through
the **web Settings screen** (`/settings`, reached via `otacon config` or the masthead)
— a scope toggle (User / Project / Project · local) that writes
`~/.otacon/config.json`, `<repo>/.otacon/config.json`, or
`<repo>/.otacon/config.local.json` respectively (§6, §10). The CLI never writes config:
`otacon config` only launches the Settings screen, and `otacon config get <key>` is a
read-only merged lookup — the agent's Implement loop reads `worktree.dir`
through it (`otacon config get worktree.dir`) instead of hardcoding the path (§12).

**Optional: committed wrappers.** `otacon install --project` writes the same skill
wrappers into the **current git repo** instead of the user home, so they can be
committed and shared with the team: `<root>/.claude/skills/otacon/SKILL.md`,
`<root>/.codex/skills/otacon/SKILL.md`, `<root>/.opencode/skills/otacon/SKILL.md`
(`--agent`/`--all` select agents exactly as at user scope). The base resolves to the
git repo root via `findRepoRoot(cwd)`; run outside any git repo it exits with a usage
error (exit 2). `--hooks` is user-only — it registers a Claude Code Stop hook in the
user's `~/.claude/settings.json`, so `--hooks --project` is rejected; a project install
ships only the inert skill wrappers (no hook script), and reports neither offers nor
checks the user Stop hook. When `otacon doctor` runs inside a repo, each per-agent
wrapper check accepts the wrapper at **either** the user path or the project path and
reports the scope that satisfied it (`<path> (project)` / `<path> (user)`) — so a
committed project install never reads as "not installed". A miss names the missing
piece as the otacon protocol skill (not the opaque word "wrapper"), lists the paths it
looked in, and — when in a repo — mentions `--project` as an install option.

### Daily flow

1. In any agent session in the repo: *"plan \<feature\> with otacon"* (or `/otacon`).
   Running `/otacon <request>` from inside a build worktree of a finished plan offers
   to **resume and amend** that plan (the agent confirms relatedness with you in the
   terminal), revising it and pushing the same PR instead of starting fresh.
2. The agent researches, runs `otacon start`, and grills you one question at a time —
   answer the cards in the browser (`otacon open`) or on your phone via the tailnet URL.
3. The agent drafts, passes the linter, submits. You review: questions fire instantly,
   comments stack in the drawer, **Send all** when done.
4. Agent revises; you re-review via changelog + threads + diff-vs-last-reviewed. Repeat
   until you **Save** or **Implement**.
5. Every approved plan is archived to the home store `~/.otacon/sessions/<id>/` (always).
   On **Save** otacon also writes a copy into the repo under `plans.dir` (default
   `.otacon/plans`; set it to `docs/plans` to group it with tracked plans) and the session
   ends; you commit that copy if you want it in git. On
   **Implement** the same agent builds straight from the home copy — worktree off the
   default branch, per-phase implement+review subagents, pause-on-first-blocker — and
   opens a PR, surfaced on the home card (§6, §12). No plan file rides in the repo on
   Implement.

### Release channels

otacon publishes to two npm dist-tags. **`latest`** is the stable channel a clean
`vX.Y.Z` tag publishes to (and gets a GitHub Release). **`staging`** is a preview channel
testers opt into with `npm i -g otacon@staging`: a `vX.Y.Z-staging.<stamp>` prerelease tag
publishes there (and gets no GitHub Release). A staging build is cut from the long-lived
**`staging` branch** by the branch-detected `bun run release` (the same command, which
switches flows by branch); its version carries a `-staging.<UTC timestamp>` suffix, a
numeric build id. Both channels share one publish workflow, which routes by version
suffix: a `-staging.` version goes to `staging`, anything else to `latest`, so a staging
build never moves `latest` and never lands in front of regular users. Re-cutting a staging
build yields a newer (higher) timestamp, which moves the `staging` dist-tag to the newest
build; the maintainer runbook is in RELEASING.md.

The CLI's self-update (below) is **channel-aware**: a staging install (its own version
carries the `-staging.` suffix) tracks the `staging` dist-tag and auto-updates
staging→staging, so it is never pulled back to a stable build; a clean install tracks
`latest` exactly as before. The channel is derived purely from the installed version's
suffix, with no extra config or state.

### Updating

`otacon start` self-updates on its own channel: before a session exists it discovers the
latest published version on the channel its installed version tracks (GET
`registry.npmjs.org/otacon/<channel>`, short timeout, fail-open on any error) and updates
the global install when a newer one is published. The channel is derived from the
installed version's suffix: a `-staging.` build tracks the `staging` dist-tag (so a
staging install auto-updates staging→staging and is never pulled back to a stable build),
and anything else tracks `latest` (the clean-install behavior, unchanged). The check is
throttled to once per hour via `$OTACON_HOME/update-check.json` (a `checkedAt`
timestamp), so most starts pay no network cost. Turn it off with the `update.auto`
config key (default true) to pin the installed version (CI, air-gapped, pinned-version
shops). Only `otacon start` runs the check — the tight loops (wait/ask/progress) never
do — and a run from a source checkout (a `.ts` daemon entry) is skipped.

When a newer version is published on its channel, `otacon start` runs `npm install -g
otacon@<channel>` (`otacon@latest` for a clean install) and then **re-execs itself** —
`node main.js start <original argv>` with
`OTACON_UPDATED=1` set — so the rest of the command runs on the freshly-installed CLI
(the env var is the loop guard that stops the re-exec'd child from re-checking). stdio
is inherited, so the child prints the single JSON line on stdout and the start contract
is preserved; the parent exits with the child's code. The daemon needs no separate
update step: the re-exec'd child's `ensureDaemon` version handshake restarts a stale
`otacond` on its next call, just as it already does after any manual bump. If `npm
install` fails for any reason (a non-writable global dir, npm missing) otacon **never
escalates to sudo** — it prints the manual `npm install -g otacon@<channel>` command and
proceeds on the installed version.

A restart swaps the daemon's code, but an already-open review tab is still running the
JS bundle it loaded — whose content-hashed lazy chunks (the plan renderer, mermaid)
404 against the rebuilt `dist/ui` and wedge the page. So **open tabs self-heal**: every
SSE snapshot carries the daemon's `version` (§6), and an EventSource reconnect after the
restart re-delivers it; when that differs from the version baked into the running bundle
(`__OTACON_VERSION__`, stamped by the Vite build) the tab reloads once to fetch the
fresh code. The reload is guarded by a `sessionStorage` key keyed to the target version,
so a version that can't converge (the daemon updated but the bundle is pinned, or vice
versa) reloads at most once and never loops. This leans on the existing cache headers:
`index.html` is served `no-cache` and the hashed assets `immutable`, so the reload pulls
the new shell and its new chunks rather than a stale cached copy. As a backstop, the
review screen's renderer error boundary (which catches a vanished lazy chunk) also
auto-reloads once per tab — falling back to a manual "Reload" link if that didn't fix it.

`otacon update` forces the upgrade on demand. Unlike the start-time gate it ignores both
suppressors: the 1h throttle (the user asked now) and `update.auto:false` (an explicit
command overrides a config that only governs the implicit start-time check). It discovers
the latest version on the same channel the same way (fail-open on any registry error →
reports `latest:null`, exit 0), refuses on a source checkout (nothing global to update),
and runs the same `npm install -g otacon@<channel>` — never sudo. `--check` reports
`{current, latest, outdated}`
and never installs (the dry run, and the only safe mode in CI / pinned shops). On a
successful install it does **not** restart the daemon: the running process is still the old
code, so its `ensureDaemon` would see no version mismatch; the new daemon and the open
tabs' self-heal come up on the next `otacon` command, which runs the freshly-installed
binary. A failed install is the one exit-1 path (`E_UPDATE_FAILED`), pointing at the manual
command.

`npm update -g otacon` still works for a manual bump; the version handshake restarts the
daemon on next use either way, and open tabs self-heal the same way.
