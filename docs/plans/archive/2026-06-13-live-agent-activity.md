---
title: live-agent-activity
session: otc_ag7md1
revision: 2
status: approved
created: 2026-06-13
---

## Summary

Make the agent's work visible in the web UI from the first moment. The session
is minted immediately (before research), the agent narrates with a new
`otacon progress <note>` verb feeding a live append-only activity log, the draft
chip shows the latest note, and a subtle live/offline dot tells you the agent is
still on the line. Push/sound alerts stay out of scope (owned elsewhere).

## Decisions

- D1: New `otacon progress <note>` CLI verb — the agent narrates at checkpoints; no model call, zero-API invariant intact ← q1
- D2: Activity is an append-only feed (last ~20 timestamped notes) in a new `activity.json`, pushed over a new `activity` SSE frame ← q2
- D3: No new status value; the `draft` chip becomes activity-driven — latest note (length-capped + ellipsized), falling back to "agent working" ← q3
- D4: Agent presence = live/offline, derived from a parked `wait` + last-contact recency; a small dot beside existing chips, which stay the primary "your turn" signal ← q1, q4
- D5: Visual-only this milestone; browser/OS push + sound belong to the separate `attention-notifications` session ← q5
- D6: Protocol reorders to start-first — `otacon start` runs before research so the UI exists to watch the whole time ← q3
- D7: One wrapper template (assets.ts) is the single source — the dogfood `.claude/skills/otacon/SKILL.md` is generated from it and guarded by a test, so it can never drift from what `otacon install` writes into other repos [assumed]

## Phases

### Phase 1 — Activity & presence backend

Goal: Add `otacon progress`, store a capped activity feed, track agent presence,
and extend the session summary + SSE so every surface knows what the agent is
doing and whether it is still on the line.
Files:
- src/cli/commands/progress.ts (new), src/cli/main.ts (wire verb)
- src/daemon/activity.ts (new: read/append/cap), src/shared/paths.ts (activityPath)
- src/daemon/app.ts (POST /progress, lastContact map, summarize fields, publishes)
- src/daemon/notify.ts (`activity` UiEvent), src/daemon/ui.ts (snapshot carries feed)
- src/shared/types.ts (ActivityNote/ActivityFile; summary presence + latestActivity)
- DESIGN.md (§6 CLI/API/events/SSE, §12 storage), DECISIONS.md
Verification: bun test (new activity.test.ts cap/append; app.test.ts progress
route + activity frame + presence in summary + approved-refuses); bun run
typecheck.

#### Details

- `otacon progress <note>`: resolves the session like `ask` (pointer or
  `--session`), POSTs `{note}`, refuses empty and approved sessions
  (E_SESSION_OVER), prints `{"ok":true,"session","note"}`. Non-blocking — never
  parks. A note is trimmed server-side to a max length (config, ~200 chars) so
  long narration never fails or bloats payloads. Bumps last-contact like every
  other call.
- `activity.ts`: `ACTIVITY_CAP` (≈20, config-tunable) keeps only the newest N on
  append; `readActivity` returns `[]` for missing files and quarantines a
  corrupt one (same habit as the queue/transcript readers). A note is
  `{at, text}`.
- Presence is in-memory only (ephemeral liveness): a `Map<id, lastContactAt>` in
  `createApp`, bumped by ask/submit/answer/comments/questions/progress and at
  each `wait` park. `summarize` adds `lastContactAt` (and `parked` from
  `queueFor(id).waiterCount > 0`); the UI derives live/offline so the daemon
  needs no timer. A daemon restart shows offline until the next contact — which
  is correct.
- Publishes: a progress note publishes `activity` (the note, per-session log)
  and `session` (latestActivity for the chip, on index + review). The `wait`
  park path also publishes `session` so a refreshed `lastContactAt` reaches the
  dot within one park slice (the live/offline threshold must exceed the 240s
  slice; both threshold and cap are config — first-week tuning, per §15).
- No new event is queued for `progress` (like `ask`): it is UI-only telemetry,
  never an agent wake-up.

### Phase 2 — Web UI: activity log, activity-driven chip, presence dot

Goal: Render the feed live on the review and pre-plan screens, make the draft
chip read the latest note, and show a subtle agent live/offline dot beside the
chips on the index card, switcher, and review header.
Files:
- src/ui/api.ts (consume `activity` frame + feed snapshot; presence/latestActivity on LiveSession)
- src/ui/chip.tsx (activity-driven draft chip; AgentDot component)
- src/ui/review/activity.tsx (new: the activity log)
- src/ui/session-screen.tsx (log panel + header dot; pre-plan placeholder shows the feed)
- src/ui/index-screen.tsx, src/ui/switcher.tsx (dot + note on cards/chips)
- src/ui/styles.css; DESIGN.md (§10), DECISIONS.md
Verification: bun run build (output stays node-runnable); playwright UI spec —
a posted progress note appears in the log and the dot reads live; bun run
typecheck.

#### Details

- `LiveSession` gains `latestActivity?: {text, at}` and `lastContactAt` (+
  `parked`); the per-session hook also holds the feed array, seeded from the
  snapshot and appended on each `activity` frame (trim to the cap client-side).
- `AgentDot`: live when `parked` or `now - lastContactAt < THRESHOLD`, else
  offline; a screen tick (the index already has `useTick`) keeps it honest
  while idle. It sits next to `StatusChip`, visually distinct from the existing
  `LinkState` (browser↔daemon) dot — labelled "agent" vs "link".
- Draft chip: when `status === "draft"` and a note exists, render the note
  truncated with CSS ellipsis to a fixed max-width — a long note (already
  ≤cap server-side) can never break the card layout; otherwise "agent working".
  `questionsPending` still outranks it; the full note always lives in the log.
- The pre-plan placeholder ("no revision yet") leads with the activity log — the
  main thing to watch during research/drafting; on the review screen the log is
  a compact collapsible panel near the Interview panel.

### Phase 3 — Protocol reorder + single-source wrappers

Goal: Flip the canonical loop to start-first and teach the agent to emit
`otacon progress` at checkpoints — from ONE wrapper template (assets.ts), so the
dogfood and installed wrappers can never drift (D7).
Files:
- src/cli/install/assets.ts (parametrize the card by command prefix; reorder loop + add progress step/CLI row; add `dogfoodSkillMd()`)
- src/cli/install/assets.test.ts (guard: committed dogfood SKILL.md === `dogfoodSkillMd()`)
- .claude/skills/otacon/SKILL.md (regenerated from assets.ts, never hand-edited)
- DESIGN.md (§6 loop order, §16 install + dogfood generation), DECISIONS.md
- README.md (Roadmap: add this post-v1 milestone line)
Verification: bun test (assets guard + card content); manual read of the
rendered wrapper; `node dist/cli/main.js progress` smoke.

#### Details

- The loop becomes: (1) `otacon start` → tell the user the URL; (2) research,
  emitting `otacon progress` at phase boundaries; (3) grill; (4) draft + submit;
  (5) review loop; (6) approve. Step 1 before research is the point of D6 — the
  watch surface exists from the first second.
- Single source (D7, ← t1): `protocolCard(cmd)` builds the card with a given
  command prefix. `skillMd()`/`codexBlock()` use `otacon` (what `otacon install`
  writes into any repo); `dogfoodSkillMd()` uses `./bin/otacon` and prepends the
  repo preamble (run-from-source + `otacon restart` after daemon edits). The
  committed `.claude/skills/otacon/SKILL.md` is exactly `dogfoodSkillMd()`, and
  `assets.test.ts` asserts that equality — a protocol change that updates
  assets.ts but forgets to regenerate the dogfood file fails CI. This is the
  "introduce the template into the repo so install stays consistent" t1 asked
  for; both wrappers now derive from the same source.
- `otacon install` into another repo is unchanged — it writes the global wrapper
  (plain `otacon`), which already works for any repo; only this repo needs the
  source-mode variant, so no project-scoped install is added.
- The card gains the `otacon progress "<what you're doing>"` instruction ("call
  it when you start a chunk of work the user can't otherwise see") and a CLI
  row; never-end-your-turn and grill discipline are unchanged.

## Risks

- Long silent research stretch (no `progress` call) past the live threshold blinks the dot offline; mitigated by a generous threshold + checkpoint guidance, and it self-heals on the next call.
- Agent forgets to call `progress` → empty feed; the chip still falls back to "agent working" and presence still works, so the floor is today's behavior.
- Contested `current-session` pointer when several sessions share a repo (hit this session) makes implicit `progress` target the wrong plan; the wrapper must use the started session's id / `--session`.
- Extra `session` publishes on the `wait` park path add load, bounded to ≤ once per park slice per agent — negligible.
- Feed cap (~20) and the live threshold are guesses; both are config and expected to need first-week tuning (§15 ethos).

## Open Questions

- Final defaults for `ACTIVITY_CAP` and the live/offline threshold (config); settle in first-week use.
- Whether the activity-note chip should truncate at a fixed width on the index card — a UI detail to settle in Phase 2.

## Interview

### q1 — The daemon only hears from the agent at discrete CLI calls (start/ask/submit/wait). During a long research or drafting stretch the agent makes none, so the UI has nothing live to show. How should the agent report what it's doing?

- Options: New 'otacon progress <note>' command the agent calls at checkpoints (+ daemon auto-marks 'waiting' whenever parked in wait) (recommended) | Automatic only: daemon infers state from existing commands, no new command, no agent burden | Both, but ship automatic inference first and add progress notes later
- Answer: New 'otacon progress <note>' command the agent calls at checkpoints (+ daemon auto-marks 'waiting' whenever parked in wait)

### q2 — How much activity should the UI keep and show? Progress notes are coarse — a handful per phase ('reading auth module', 'drafting plan', 'revising for batch b3').

- Options: Append-only feed: daemon keeps the last ~20 timestamped notes; UI shows a compact live activity log + the current note prominently (richest visibility, new activity.json + SSE frame) (recommended) | Single current-note line only: each progress call replaces the last; rides the existing session summary/SSE frame (minimal storage & UI) | Feed, but unbounded full history kept on disk for the whole session
- Answer: Append-only feed: daemon keeps the last ~20 timestamped notes; UI shows a compact live activity log + the current note prominently (richest visibility, new activity.json + SSE frame)

### q3 — Your ask: mint the session immediately when the skill triggers (before research), so you can watch from the UI the whole time. That means the session sits in 'draft' through research+drafting before revision 1 exists — and today 'draft' renders as a fixed 'agent drafting' chip, misleading while it's still researching. How should that pre-plan state read?

- Options: Keep the 4-status machine; make the draft chip activity-driven — show the latest progress note (e.g. 'reading auth module'), fall back to 'agent working'. No new status, no linter/type churn (recommended) | Add a distinct 'researching' status to the state machine (own chip + switcher glyph), flips to 'draft' once drafting starts | Leave the chip as 'agent drafting'; let the separate activity line + waiting indicator carry all the nuance
- Answer: Keep the 4-status machine; make the draft chip activity-driven — show the latest progress note (e.g. 'reading auth module'), fall back to 'agent working'. No new status, no linter/type churn

### q4 — The daemon can distinguish: agent parked in 'wait' (waiting on you) vs actively working vs gone (no recent contact). Today the UI only has the 4 status chips. Your pain was 'hard to tell it's waiting for my answer.' How prominent should the agent-presence / 'your turn' signal be?

- Options: First-class presence indicator with 3 states (working / waiting-on-you / offline), derived from parked-wait + last-contact recency, shown prominently on the review header AND index card AND switcher so 'your turn' is unmistakable without watching the terminal (recommended) | Subtle: a small live/offline presence dot next to the existing chips; keep status chips as the main signal | No separate presence; just make the existing chips ('awaiting your review','questions pending') louder
- Answer: Subtle: a small live/offline presence dot next to the existing chips; keep status chips as the main signal

### q5 — There's a separate 'attention-notifications' session open in this repo, which looks like it owns active alerting (browser/OS push, sound) when it becomes your turn. Should THIS session stay visual-only — activity feed + live/offline dot + activity-driven chip — and leave push/sound to that session?

- Options: Yes — visual-only here; notifications belong to the attention-notifications session (recommended) | No — fold a minimal browser-notification ping into this session too
- Answer: Yes — visual-only here; notifications belong to the attention-notifications session
