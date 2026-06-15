---
title: resume-pending-session
session: otc_3balg5
revision: 1
status: approved
created: 2026-06-14
---

## Summary

Add `otacon resume` so an interrupted plan session can be picked back up on
purpose, not just rediscovered after a crash. No-arg lists the repo's resumable
(non-approved) sessions; `--session <id>` rehydrates one — restoring its working
`plan.md` from the latest revision and returning a compact bundle + `nextAction`.
`/otacon resume` drives it: list → user picks → rehydrate → resume the loop.

## Decisions

- D1: A new `otacon resume` CLI command owns the flow; `status` stays read-only. ← q1
- D2: Rehydrate returns a compact bundle (status, revision, pending/open counts, open threads as `{id,quote}`, `nextAction`); full transcript/thread bodies stay behind existing reads. ← q2
- D3: Restore `plan.md` from the latest revision only when it is absent — never clobber an existing local draft; report which case happened. ← q3
- D4: Always require an explicit user pick (even for one session); list is repo-scoped, `--all` broadens. ← q4
- D5: `resume` composes existing endpoints (`GET sessions/:id`, `/threads`, `/revisions/:n`) — no new daemon route, no protocol-shape change. [assumed]
- D6: Approved (ended) sessions are excluded from the resumable list; `--session` to one refuses. [assumed]

| Pick | Surface | Tradeoff |
| ---- | ------- | -------- |
| ✓    | New `otacon resume` command | deterministic rehydration in code; keeps `status` read-only ← q1 |
|      | Skill-only over `status`    | zero new code, but rehydration logic lives fragile in the prompt |
|      | A mode on `status`          | one fewer verb, but `status` would start writing files |

## Phases

### Phase 1 — `otacon resume` command

Goal: A `[new]` CLI verb with two modes — list resumable sessions (no `--session`)
and rehydrate one (`--session <id>`), restoring the draft and printing a bundle
with `nextAction`. Pure CLI orchestration over existing endpoints.

Files:
- `src/cli/commands/resume.ts` (new) — both modes + `nextAction` derivation
- `src/cli/main.ts` — register `resume` in dispatch + USAGE
- `src/cli/session.ts` — extract a shared repo-scope filter (reused by `status`)
- `src/cli/commands/resume.test.ts` (new) — list, rehydrate, restore-vs-preserve, approved-refusal

Verification: `bun test`, `bun run typecheck`, `bun run build`, then
`node dist/cli/main.js resume` lists and `... resume --session <id>` rehydrates.
CLI-only change — no daemon restart needed.

#### Details

List mode (`otacon resume [--all]`): fetch `/api/sessions`, repo-scope like
`status` (default cwd's git root; `--all` = every repo), drop `approved`, and
print `{ok, resumable:[{id,title,status,revision,pendingEvents,openQuestions,branch,latestActivity}]}`.
Never errors on ambiguity — listing many is the point.

Rehydrate mode (`otacon resume --session <id>`): refuse if unknown
(`E_UNKNOWN_SESSION`) or approved (`E_SESSION_OVER`). Read the session summary and
`/threads`; if `plan.md` is absent and `revision ≥ 1`, fetch `/revisions/<revision>`
and write it to `planPath` (creating the dir), else leave the file untouched. Print
`{ok, session, title, status, revision, pendingEvents, openQuestions,
openThreads:[{id,quote}], draft:{restored:bool, path, fromRevision|reason}, url, nextAction}`.

`nextAction` is derived from state, in priority order: pending events → "run
`otacon wait` to drain N event(s)"; `status:"revising"` → "revise plan.md +
resolutions.json, then submit"; `revision === 0` (never submitted) → "finish the
grill/draft and submit"; otherwise (`in_review`, idle) → "park in `otacon wait`".

### Phase 2 — Skill + docs wiring

Goal: Teach the protocol the `/otacon resume` flow and record it in the spec.
The agent branch: `otacon resume`, present the list, get an explicit pick, then
`otacon resume --session <id>` and follow `nextAction` back into the loop.

Files:
- `src/cli/install/assets.ts` — `protocolCard` gains a "Resuming a session" note + quick-ref entry (feeds all wrappers)
- `.claude/skills/otacon/SKILL.md` — regenerated to equal `dogfoodSkillMd()`
- `DESIGN.md` — §6 loop/CLI table + §7 resume story
- `DECISIONS.md` — entry for D1–D4

Verification: `bun test` (`assets.test.ts` guards committed SKILL.md ==
`dogfoodSkillMd()`), `bun run typecheck`.

#### Details

> [!note]
> The selection step is the one place a native question UI is allowed, because no
> otacon session is bound yet. Once `resume --session` rehydrates, the normal rule
> resumes: every question goes through `otacon ask`/`answer`.

DESIGN/DECISIONS edits land in the same commit as the code they describe, per the
documentation contract.

## Risks

> [!risk]
> "Never clobber" (D3) means a `plan.md` that drifted *behind* the latest revision
> is edited stale, and resubmit could regress it. Mitigated: the bundle reports
> `revision` + restored/preserved so the agent can diff before editing.

> [!risk]
> `resume` and `status` overlap in listing logic; left un-shared they drift. The
> Phase 1 `session.ts` extraction is load-bearing, not optional.

- [assumption] CLI and daemon share one host (127.0.0.1), so revision files exist
  on disk for the draft restore; a remote daemon would break the file write.

## Open Questions

- None blocking. Cross-repo ranking of the resumable list (by actionability) is
  deferred — v1 lists plainly and the user picks.

## Interview

### q1 — How should /otacon resume be backed? Today 'otacon status' already lists active sessions and is the documented crash/resume entry point — but nothing RESTORES a fresh agent's working draft (.otacon/<id>/plan.md) from the latest submitted revision, and nothing helps the user pick which session. (A) A new 'otacon resume' command owns this: no-arg lists resumable sessions; '--session <id>' rehydrates — restores plan.md from the latest revision and returns a compact resume bundle + next-action. Rehydration becomes deterministic code, not prompt text. (B) Skill-only: no CLI change; the skill tells the agent to run 'status', present the list, and reconstruct context by reading existing endpoints/files itself. (C) Add a resume/rehydrate mode to 'status' instead of a new verb (keeps one command, but 'status' stops being read-only).

- Options: New 'otacon resume' command (recommended) | Skill-only over status | Add a mode to status
- Answer: New 'otacon resume' command

### q2 — When the user resumes a specific session, what should 'otacon resume --session <id>' return on its single JSON line (besides restoring plan.md)? (A) Compact bundle: status, current revision, pendingEvents count, openQuestions count, open comment threads as [{id, quote}], plus a 'nextAction' hint — the agent reads full transcript/thread bodies from existing endpoints when needed. (B) Minimal: just the status summary (revision, pendingEvents); agent reconstructs the rest itself. (C) Full inline: also embed the entire grill transcript and every open thread body in the JSON so no follow-up reads are needed.

- Options: Compact bundle + nextAction (recommended) | Minimal status only | Full inline transcript+threads
- Answer: Compact bundle + nextAction

### q3 — On resume, the working draft .otacon/<id>/plan.md may be missing (fresh process), or present (left over from before the crash — usually equal to the last submitted revision, but possibly unsaved mid-edit work). How should resume restore it? (A) Restore from the latest revision ONLY when plan.md is absent; never clobber an existing local file — preserves unsubmitted edits, and reports the latest revision so the agent can reconcile. (B) Always overwrite plan.md with the latest submitted revision — registry is the source of truth, simplest and most predictable, but discards mid-edit work. (C) Restore when absent or when the file's contents differ-and-are-older than the latest revision; preserve only strictly-newer edits.

- Options: Restore only when absent (never clobber) (recommended) | Always overwrite from latest revision | Restore when absent-or-stale
- Answer: Restore only when absent (never clobber)

### q4 — How should the skill drive selection after the user types /otacon resume? (A) Default to active sessions in the CURRENT repo: if exactly one, resume it automatically; if two or more, present them and let the user pick (a list in chat — no otacon session is bound yet, so a terminal pick is fine); if none here, say so and suggest 'otacon start' or resuming with --all. (B) Always list and require an explicit pick, even when there's only one. (C) Default to ALL repos' active sessions, not just the current one.

- Options: Auto-pick single, ask if many (this repo) (recommended) | Always require explicit pick | List all repos by default
- Answer: Always require explicit pick
