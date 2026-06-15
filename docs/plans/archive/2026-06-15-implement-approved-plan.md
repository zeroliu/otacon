---
title: implement-approved-plan
session: otc_wqva6w
revision: 1
status: approved
created: 2026-06-15
---

## Summary

Add **Approve & Implement**: one tap approves the plan and keeps the same agent on
the line to build it. The agent commits the plan, opens a git worktree, and walks the
phases — a fresh implement+test subagent per phase, then a separate `/code-review`
subagent that fixes findings before the phase commits. It pauses and asks via otacon
on the first blocker, and opens a PR once every phase is green.

## Decisions

| Pick | Implementer model | Tradeoff |
| ---- | ----------------- | -------- |
| ✓    | Same agent + per-phase subagents | continuity, and fresh context per phase (solves "long session degrades") ← q1, q2 |
|      | Fresh detached spawn (old plan)  | phone-only/unattended, but a disconnected fire-and-forget run — now removed ← q1 |
|      | Daemon- or SDK-driven build      | breaks the zero-API-spend invariant (§13) |

- D1: Standalone feature; the in-review `spawn-sessions-from-web` plan is removed — no fresh-spawn transport to reconcile. ← q1
- D2: Two approve actions — `Approve` (terminal, as today) and `Approve & Implement` (commit the plan, then the same agent builds). ← q2
- D3: On the **first** blocked phase (red tests, unresolved review, stuck subagent) the orchestrator pauses, posts an `otacon ask`, and parks — no auto-retry. ← q3
- D4: UI stays pragmatic — the existing activity feed for step detail, plus an `implementing/implemented/failed` status chip and the PR link on the card. ← q4
- D5: All build work runs in native in-session subagents (Task tool, subscription-covered); the daemon never spawns or calls a model — zero-API-spend (§13) holds. [assumed]
- D6: Orchestration lives in the shared protocol card (`assets.ts`), regenerated into the dogfood `SKILL.md` — a new section, not a separate skill. [assumed]
- D7: New non-terminal `implementing` state (→ `implemented`/`implement_failed`); during it progress/ask/wait/answer stay allowed and the Stop hook treats it as active. [assumed]
- D8: `Approve & Implement` reuses the approve route (`{implement:true}`) and extends the `approved` event with `implement:true`; a new `otacon implement-done` reports the PR/outcome. [assumed]
- D9: Worktree at `.otacon/worktrees/<slug>` (gitignored), branch `otacon/impl-<slug>` off the plan-doc commit, one commit per green phase; `gh` PR vs the default branch (local-branch fallback when no remote). [assumed]

## Phases

### Phase 1 — Daemon: the `implementing` lifecycle

Goal: Add `implementing → implemented | implement_failed`. `Approve & Implement` =
`POST /approve {implement:true}` — write the artifact, flip to `implementing`, queue
`approved {implement:true}`; a new `POST /implement-done` records the outcome + PR link.

Files:
- `src/shared/types.ts` — statuses, `approved.implement`, `SessionSummary.prUrl`, registry field
- `src/daemon/app.ts` — approve-route branch, the implement-done route, open-verb guard allows `implementing`
- `src/daemon/store.ts`, `src/daemon/ui.ts` — persist + stream `prUrl`/status on session frames
- `src/daemon/app.test.ts` (+ store) — approve&implement round-trip, guard, outcome recording

Verification: `bun test daemon/`; approve&implement flips to `implementing` and queues
the event; mutating verbs work while `implementing`, refuse once terminal. `bun run
typecheck && bun run build`. Daemon edit → `./bin/otacon restart`.

### Phase 2 — CLI: implement verb + active-state resolution

Goal: `otacon implement-done [--pr <url>] [--failed]` reports the outcome; the
implicit-session resolver (and the Stop hook) treat `implementing` as the repo's active
session, so the agent can't bail mid-build and `resume` re-adopts it.

Files:
- `src/cli/commands/implement-done.ts` (+ `implement-done.test.ts`) — outcome verb
- `src/cli/main.ts` — dispatch + USAGE
- `src/cli/session.ts` — `implementing` resolves as the active session

Verification: `bun test cli/`; `implement-done` sets status + link; an `implementing`
session resolves implicitly. `bun run typecheck && bun run build`, then `node
dist/cli/main.js implement-done`. CLI-only — no restart.

### Phase 3 — UI: Approve & Implement + status chip + PR link

Goal: A second button beside Approve (sharing its force-confirm); render the
`implementing/implemented/failed` chip + PR link on home cards; keep `implementing`
sessions in the active list (not grouped away like approved).

Files:
- `src/ui/review/*` — approve sheet/header gains the second action
- `src/ui/index-screen.tsx`, `src/ui/session-filter.ts` — chip + PR link; `implementing` stays active
- `src/ui/api.ts` — `approve{implement}` + implement status/link over SSE

Verification: `bun run verify:branch`; approve&implement shows the chip live, the PR
link appears on `implement-done`, and an `implementing` session stays on home.

### Phase 4 — Orchestration protocol card + docs

Goal: Teach the agent the build loop in the shared protocol card, regenerate the
dogfood `SKILL.md`, and reframe the spec (otacon now implements, not just plans).

Files:
- `src/cli/install/assets.ts` (+ `assets.test.ts`) — the implement-orchestration section
- `.claude/skills/otacon/SKILL.md` — regenerated to equal `dogfoodSkillMd()`
- `DESIGN.md`, `DECISIONS.md` — scope reframe (§1, Decision 1, §14 snake), the build loop, status machine, protocol + CLI table

Verification: `bun test` (`assets.test.ts` guards committed `SKILL.md` == `dogfoodSkillMd()`);
`bun run typecheck`.

#### Details

The card section the agent follows on an `approved {implement:true}` event:

1. **Setup.** `git add` + commit the plan file at the event `path` (as plain Approve
   does), then `git worktree add .otacon/worktrees/<slug> -b otacon/impl-<slug>` off
   that commit. `otacon progress` each checkpoint throughout.
2. **Per phase, in order** (read phases from the committed plan):
   - `progress "phase N — implementing"`; spawn an **implement+test** subagent (Task
     tool) scoped to that phase's Goal/Files/Verification. It implements and runs the
     phase Verification plus the repo gates (`bun test`, `typecheck`, `build`).
   - spawn a **separate** `/code-review --fix` subagent on the phase's working diff; it
     applies findings; re-review.
   - **clean + green →** commit the phase and continue. **Blocked** (red, review still
     flags, or a subagent is stuck) → `otacon ask` (retry | skip | abort | guidance) and
     park in `otacon wait`; act on the answer (D3).
3. **Finish.** `gh pr create` against the default branch (PR body = plan summary + the
   per-phase log; local branch + path when there is no remote), then `otacon
   implement-done --pr <url>` (or `--failed` on abort).

Subagents are native (subscription-covered); the orchestrator only coordinates and
narrates, keeping its own context lean. `/code-review` effort is config — start
moderate so false positives don't become needless pauses, and tune like the budgets.

## Risks

> [!risk]
> The orchestrator is still one long-lived session. Mitigated: it only coordinates —
> every phase's real work runs in a fresh subagent, so its own context stays lean.

> [!risk]
> `implementing` re-opens verbs that `approved` closed. The open-verb guard must gate
> on **terminal** states only, or an ended session becomes mutable again.

- A worktree under `.otacon/` plus per-phase commits litter state on abort; `otacon
  clean` should prune finished/aborted impl worktrees + branches.
- `/code-review` false positives surface as user-facing pauses (D3); effort is config,
  start moderate and tune.
- [assumption] The Mac stays awake and the session attended through the build
  (`caffeinate -i`); if the terminal closed, the queued directive resumes via `otacon resume`.

## Open Questions

- Commit granularity (per-phase vs squash) and whether the PR bundles the plan-doc
  commit are [assumed] in D9 — easy to flip in review.
- Terminal-state naming (`implement_failed` vs folding abort back to `approved`) is
  provisional; the D4 chip set assumes a distinct failed state.

## Interview

### q1 — Your in-review spawn-sessions-from-web plan (Phase 4) ALREADY adds an Implement button: tapping it makes the daemon spawn a FRESH detached claude in a worktree (tmux, fire-and-forget) that commits and opens a PR — works phone-only with nobody attending. Your new ask is for the SAME planning agent to orchestrate a richer per-phase loop (implement+test subagent -> /code-review subagent -> fix -> gate -> next phase -> PR). They conflict on who implements and how it's launched. How should this feature relate to that one?

- Options: Orchestration layer ON the spawn (keep fresh-spawn transport; this defines what the implement agent DOES) (recommended) | Same live planning session implements (don't stop after approve; park for Implement, orchestrate subagents itself) | Standalone — design independently, reconcile later
- Answer: standalone, that plan is now removed

### q2 — Today approve is terminal: the agent commits the plan and STOPS (session ends). For the SAME agent to implement on click, that must change. When should implementation start? (Note: the Implement click queues an event on the daemon regardless, so whichever default we pick, the other is still reachable — a queued Implement is picked up instantly if the agent is parked, or later on resume if the terminal was closed.)

- Options: Park for Implement after approve: agent commits, then stays parked; approved session shows an Implement button; click -> agent picks it up instantly and orchestrates (new 'implementing' state). Truest to 'same agent on click'. (recommended) | Stop after approve (as today); Implement is a later /otacon implement resume — robust if you build hours/days later, but it's a resumed session, not the live agent. | Approve & Implement in one step — approving flows straight into building, no separate click.
- Answer: in addition to approve, add an "approve & implement" option, which triggers the implement flow after the plan is ready

### q3 — During implementation a phase can get stuck: tests stay red, /code-review keeps flagging issues the fix subagent can't resolve, or a subagent spins. otacon's whole identity is keeping you in the loop from your phone. What should the orchestrator do at a BLOCKED phase?

- Options: Bounded auto-retry, then pause+ask: retry the phase a few times with a fresh subagent each time; if still blocked, post an otacon question (retry/skip/abort/give guidance) and park in wait until you answer. (recommended) | Pause+ask on first blocker (no auto-retry): stop and surface it immediately — max control, more interruptions. | Best-effort, never block: log the failure to the activity feed, continue to the next phase, and open a DRAFT PR with blockers noted for you to triage.
- Answer: Pause+ask on first blocker (no auto-retry): stop and surface it immediately — max control, more interruptions.

### q4 — While the agent builds (worktree -> per-phase implement+test subagent -> /code-review subagent -> fix -> commit -> next -> PR), what should you SEE in the otacon UI? Today there's an append-only activity feed the agent writes with 'otacon progress', plus session status chips on the home cards.

- Options: Activity feed + status chip + PR link (pragmatic): keep the flat 'otacon progress' feed for step-by-step detail, add an implementing/implemented/failed status chip on the card, and surface the final PR link. Ships small. (recommended) | Structured phase tracker (rich): a new implement view — each phase a row with live status (pending->implementing->reviewing->done/blocked), its code-review outcome, and the PR link. The most otacon-y, but a real chunk of new daemon state + UI. | Activity feed only: orchestrator narrates everything via 'otacon progress'; near-zero new UI, no status chip or PR link surfacing.
- Answer: Activity feed + status chip + PR link (pragmatic): keep the flat 'otacon progress' feed for step-by-step detail, add an implementing/implemented/failed status chip on the card, and surface the final PR link. Ships small.
