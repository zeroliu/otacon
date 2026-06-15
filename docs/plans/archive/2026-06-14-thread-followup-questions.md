---
title: thread-followup-questions
session: otc_tmw7el
revision: 2
status: approved
created: 2026-06-14
---

## Summary

Turn a one-shot question thread into a conversation. After you `Ask` and the
agent answers, a reply box on that card posts a follow-up; the agent answers it
in the same card. Follow-ups are a [new] thread linked to the original by
`replyTo`, reusing the existing queue, `otacon answer`, and SSE. Scope is
question threads only, one direction — you ask, the agent answers.

## Decisions

- D1: Follow-ups apply to question threads only; comment threads stay one-shot resolutions ← q1
- D2: One-way — you post follow-up questions, the agent answers; no agent-initiated turn inside a thread ← q2
- D3: A follow-up is a [new] question thread linked by `replyTo` to the root, not a `messages[]` rewrite of the thread (matrix below) [assumed]
- D4: A follow-up inherits the root thread's anchor, so no fresh selection is needed and the whole chain jumps and orphans as one unit [assumed]
- D5: The rail groups root + follow-ups into one conversation card; a "Follow up" button on the card reveals the reply box on demand — collapsed by default, not always shown [assumed]
- D6: `POST /questions` gains an optional `replyTo`; the `question` wait-event carries it so the agent answers with prior context — answering stays `otacon answer q<n>`, unchanged [assumed]

| Pick | Model                          | Tradeoff                                                                              |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------ |
| ✓    | Linked threads (`replyTo`)     | reuses the queue, overwrite-idempotent `answer`, SSE upsert, shared q-id space; rail must group the chain |
|      | `messages[]` on the thread     | one object per conversation, but reshapes `Thread`, migrates `body`/`answer`, breaks answer idempotency, touches every thread reader |

## Phases

### Phase 1 — Linked follow-up threads (daemon + protocol)

Goal: A question thread can spawn a linked follow-up. `POST /questions` accepts
an optional `replyTo`, validates the parent, inherits its anchor, and queues a
`question` event carrying `replyTo` so the parked agent answers it normally.
Files:
- src/shared/types.ts (question `Thread` + `question` `EventPayload` gain `replyTo?`)
- src/daemon/app.ts (POST /questions: parse + validate `replyTo`, inherit parent anchor, enqueue with `replyTo`)
- src/daemon/threads.ts (`isThread` validates optional `replyTo`)
- src/cli/install/assets.ts + .claude/skills/otacon/SKILL.md (one line: a `question` event may carry `replyTo` — read the thread for prior turns) [generated, guarded by assets.test.ts]
- DESIGN.md (§6 events + /questions API, §9 timing table), DECISIONS.md
- src/daemon/app.test.ts, src/daemon/threads.test.ts (tests)
Verification: bun test (follow-up creates a linked thread, inherits anchor,
rejects unknown `replyTo` with 404, event carries `replyTo`, refused after
approval); bun run typecheck.

#### Details

- `POST /questions` body adds optional `replyTo: "q<n>"`. When present: look up
  the named thread; 404 `E_UNKNOWN_QUESTION` if it is not a `kind:"question"`
  thread in this session. Resolve the root (the parent's own `replyTo`, else the
  parent id) so every turn in a chain shares one root key — grouping is a flat
  group-by, "follow up on a follow-up" included.
- The new thread inherits the **root** thread's anchor (and `anchorState`); any
  client-sent anchor on a follow-up is ignored. Same place in the plan → the
  chain jumps and re-anchors together.
- Everything else is the existing `/questions` path: bump the shared `question`
  counter, append the thread, enqueue a `question` event (now with `replyTo`),
  publish queue + `thread` SSE. The `sessionEnded` guard already refuses
  follow-ups on an approved session.
- The agent answers with the unchanged `otacon answer q<n>`; overwrite-by-id
  idempotency is untouched because each turn is its own id.

### Phase 2 — Conversation card + reply box (UI)

Goal: The rail renders a root question and its follow-ups as one conversation
card — each turn with its answer or an "answering…" cursor — and a "Follow up"
button reveals a reply box that posts the next follow-up. Phone + orphan tray included.
Files:
- src/ui/api.ts (`Thread.replyTo`; `postFollowup(session, parentId, body)`)
- src/ui/review/group.ts (new pure `groupThreads`: fold children under their root)
- src/ui/review/rail.tsx (render the grouped conversation + reply box; orphan a chain as a unit)
- src/ui/session-screen.tsx (wire the follow-up handler through)
- src/ui/review/group.test.ts (grouping + ordering + orphan-travel)
Verification: bun test (grouping helper); bun run build (UI compiles);
bun run verify:branch (manual: ask → answer → follow up → answer, desktop + phone).

#### Details

- `groupThreads(threads)` is a pure helper: comment threads pass through; question
  threads collapse so a root carries an ordered `followups[]` (by `createdAt`),
  children never appear as their own top-level entry. Returned in the rail's
  existing newest-first order, keyed by root.
- The conversation card renders the root question + answer, then each follow-up
  turn the same way. A "Follow up" button reveals the reply box (collapsed by
  default); submitting calls `postFollowup`, which POSTs `{replyTo: rootId}` to
  `/questions`. The new turn arrives over the existing `thread` SSE frame and
  folds into the card, and the box collapses again. The button hides once the
  session is over.
- Orphaning: children inherit the root's anchor, so `applyRevisionToThreads`
  relocates them identically; the group keys on the root, so an orphaned root
  takes its whole conversation into the tray rather than stranding follow-ups as
  loose cards.

## Risks

> [!risk]
> Grouping must remove follow-ups from the top-level list, or a conversation
> renders twice — once in its card, once as a loose card. The pure `groupThreads`
> helper with a unit test is the guard.

> [!risk]
> The card's "Follow up" button and the selection toolbar's `q` "ask" must stay
> distinct paths: the toolbar creates a *root* question from selected plan text;
> the button's reply box only ever creates a `replyTo` follow-up on this thread.

- [assumption] The agent is parked in `otacon wait` through review, so a follow-up
  reaches it as the next `question` event — same delivery as the first. No new verb.

## Open Questions

- Per-turn q-ids (q4 → q9 → q12) are real ids in the shared space but the card
  shows a single conversation; whether to surface each turn's id as a small tag
  is a polish call deferred to the `verify:branch` walkthrough.

## Interview

### q1 — Follow-ups let you keep a thread going after the agent replies. Which kinds of threads should accept follow-ups?

- Options: Question threads only (recommended) | Questions + comment threads
- Answer: Question threads only

### q2 — Inside a follow-up thread, who can post — just you, or both sides?

- Options: You ask, agent answers (recommended) | Two-way (agent can ask back too)
- Answer: You ask, agent answers
