---
title: web-ui-ux-improvements
session: otc_kknjlh
revision: 2
status: approved
created: 2026-06-13
---

## Summary

Three improvements to otacon's own QA + visual surface, all surfaced by this grill.
(1) Option cards can't submit a custom/free-form answer — the gap you hit live;
add native-AskUserQuestion "Other" parity. (2) Asking one round-trip at a time
feels slow; let the agent batch independent questions into one grouped call.
(3) The rounded-rect + fat left-border cards read as AI slop — go hairline-telemetry.

## Decisions

- D1: Ship all three workstreams — custom-answer parity, batch asking, hairline card refresh — as one milestone, phased 1→2→3 so the restyle lands once over final markup ← q5, q7
- D2: Option cards (single + multi) accept a non-empty free-form answer with no chip, or text as a note on a chosen chip; the daemon /answers route relaxes to allow text-only on option questions ← q8
- D3: Batch = several independent questions posted in one call; they render as ordinary independent cards (as today) — no group header, no group submit; each answers instantly (tap = answer) ← q7
- D4: Visual = hairline telemetry: drop border-radius + fat left-border across the card system; accent becomes a small mono tag/dot/underline; masthead, mono, scanlines stay ← q6
- D5: Everything is additive — instant single-tap, free-text cards, the whole answer flow you called "nice" stay exactly as they are ← q3
- D6: No grouping and no new transcript field — a batch is purely an ask-time convenience that mints N ordinary cards; dependency-first grilling stays, only independent siblings batch [assumed]

## Phases

### Phase 1 — Custom answers on option cards

Goal: Every option question accepts a free-form custom answer — sent standalone
or as a note on a chosen chip — closing the chip-less-feedback gap. The instant
chip-tap answer is untouched.
Files:

- ui/src/review/grill.tsx — QuestionCard: custom-answer textarea + "send custom" on single-select; allow text-only submit on multi; note still rides a chip tap
- src/daemon/app.ts — /answers route: accept non-empty `text` with no choice/choices on option questions
- src/daemon/app.test.ts — custom-answer cases (single, multi, empty-text rejection)
- DESIGN.md §8, DECISIONS.md — the relaxed answer model

Verification: `bun test` (answer route); a custom answer with no chip lands and
`otacon wait` prints `{text}` with no `choice`; empty/whitespace text is rejected
(no chip-less empty answers) and the chip/choice path stays byte-for-byte.

#### Details

The daemon change is narrow: in the options branch of POST /answers, treat a
non-empty trimmed `text` with neither `choice` nor `choices` as a valid custom
answer (today single-select hard-requires `choice`, multi requires
`choices.length > 0`). The choice/note paths are unchanged. The UI: single-select
gains a persistent custom-answer affordance (the existing "+ add a note" toggle
grows a "send custom" button that POSTs `{text}` alone); multi's send enables on
either picked chips or non-empty text. `GrillAnswer.text` already exists, so no
type change here.

### Phase 2 — Batch asking (independent questions together)

Goal: The agent posts a set of independent questions in one CLI call; they appear
as ordinary cards (exactly like today's queue); the user answers each instantly;
the agent loops `wait` to collect the answers.
Files:

- src/cli/commands/ask.ts — `--batch <file|->` (JSON array of question specs); prints one line `{ok, session, ids}`
- src/daemon/app.ts — ask route accepts `{questions:[…]}`; validates + mints all atomically, publishes a grill frame each (no new fields)
- src/cli/commands/ask.test.ts, src/daemon/app.test.ts — batch mint, validation (whole-batch reject on a bad member)
- DESIGN.md §6/§8, DECISIONS.md, .claude/skills/otacon/SKILL.md, src/cli/install/assets.ts, README.md — batch protocol

Verification: `bun test`; `bash test/e2e-grill.sh`; manual — one `otacon ask
--batch` posts N independent cards at once; answers come back over the `wait` loop.

#### Details

No grouping, no new transcript field: a batch mints N ordinary `TranscriptEntry`
cards that render and answer exactly as standalone questions do today (t1). The
only new surface is the ask-time path: `--batch` on the CLI and a `{questions:[…]}`
body on the ask route, validated per-member and minted atomically (a malformed
member fails the whole batch — no partial queue). `wait` stays
one-answer-at-a-time — the agent loops it to drain a batch (as this very session
did); a `wait --all` convenience is deferred (Open Questions). Protocol docs move
in lockstep: DESIGN §8 grilling discipline becomes "dependencies first, one at a
time; independent siblings may be batched," and SKILL.md + assets.ts (the wrapper
text shipped to other repos) gain the `--batch` usage so external agents learn it.

### Phase 3 — Hairline-telemetry card refresh

Goal: Replace the rounded-rect + fat left-border card pattern system-wide with
flat panels split by hairline rules and accent-as-mono-tag/dot/underline. Pure
visual + small markup; no behavior change.
Files:

- ui/src/styles.css — card, grill-card, threads, banner, composer, approve, section-menu, drawer treatments
- ui/src/index-screen.tsx, ui/src/review/{grill,rail,banner}.tsx — small markup for the accent tag/dot where a fat left-border carried it
- DESIGN.md §10, DECISIONS.md — the visual-language decision (codec identity kept, card treatment replaced)

Verification: `bunx playwright test` UI spec (behavior unchanged) + `bun run
typecheck`; visual review on the live otacon screen, light + dark, at 390px and
desktop.

#### Details

The emblematic case is the grill card the redesign targets:

```
BEFORE                              AFTER
┌─────────────────────────┐        ▍q5 · single                3m
▌ ? q5  single      3m    │        ─────────────────────────────
▌ Which is the real scope?│        Which is the real scope?
▌ [ Just the fix  ★rec ]  │         [ Just the fix ]  ·rec
▌ [ Both ]  [ Visual ]    │         [ Both ]   [ Visual ]
└─────────────────────────┘        + custom answer
  radius:12 border-left:4px          hairline rule top; accent = ▍tag, no box
```

Accent moves from a 4px painted edge to a 1ch mono `▍`/tag glyph + a hairline
top rule; `border-radius` drops to 0–2px; the soft drop-shadow goes. The same
treatment applies to index cards (full 1px border + radius:10 → top-ruled rows),
threads, the revision banner, composer, section menu, and approve dialog, so the
house style is consistent. Chip styling (the `★rec` star, on/off states) and all
hit targets are preserved — only the container chrome changes. Verify the diff
gutter markers, phone bottom-sheets, and the ≤639px sticky bar still read after
the selector churn.

## Risks

- Relaxing answer validation could admit empty/garbage answers — guard: trimmed non-empty `text` required; the choice path stays byte-for-byte.
- Batch ask widens the ask route + CLI — keep one route, validate every member, mint atomically so a bad member fails the batch (no partial queue).
- The card refresh touches many selectors — risk of regressing diff gutters, phone sheets, approve dialog; verify against Playwright + the 639px breakpoint.
- The batch protocol must stay in sync across DESIGN, SKILL.md and assets.ts or external agents drift — all three move in Phase 2.

## Open Questions

- Should `otacon wait` gain a `--all q7,q8,…` mode that blocks until a whole batch is answered, or is the per-answer loop enough? (Leaning: loop suffices; revisit if it grates.)
- Final form of the accent indicator (mono tag vs dot vs underline) — settle in Phase 3 against the live screen, since it is a look you will judge directly.

## Interview

### q1 — The web UI is already mature and deliberate (codec aesthetic, full desktop/phone review loop, SSE-live, grill cards, diff layer). What's the primary goal of this 'improve UI/UX' pass — what should I optimize for?

- Options: Fix concrete friction I hit while actually using it (recommended) | General visual/motion polish pass (refine the existing aesthetic, no new features) | Fill a functional UX gap (new affordance that's currently missing) | Accessibility + discoverability (shortcuts hints, focus, a11y, reduced-motion)
- Answer: Fix concrete friction I hit while actually using it

### q2 — Which part of the flow is rough enough that you actually feel it? (Pick the worst offender — I'll drill into specifics next. Use Other to name something I haven't listed.)

- Options: Reviewing the plan — reading density, navigating sections, placing comments (recommended) | Answering grill questions — the card queue, esp. on phone | The revision / diff re-review loop — finding & digesting what changed | Index & session switching — getting to the right place, knowing state at a glance
- Answer: _unanswered_

### q3 — Confirmed the gap: single-select grill cards can't take a custom/'Other' answer — only a chip tap submits. I'll fix that. (This card is free-text, so this box submits fine — leave q2 above unanswered, it's superseded.) Two things: (1) Is fixing the grill custom-answer path the whole scope, or are there OTHER concrete frictions you've hit that I should bundle in? (2) Name any of those rough edges here.

- Answer: the QA flow is nice. the rounded corner card with left border is an AI slop. I need you to come up with more modern design instead

### q4 — On the redesign direction. The 'rounded card + fat left-border + shadow' is the repeated house pattern, so I'll replace it system-wide for coherence. Three directions I'd consider (free-text box, so name your pick + any tweaks, or describe your own): (A) RECOMMENDED — Instrument/codec telemetry: kill rounded cards & left-borders; flat panels split by hairline rules, mono labels, accent shown as a small tag/dot/underline not a fat border; denser, reads like a real Metal-Gear codec readout (most coherent with the existing identity, just executed sharply). (B) Editorial/calm: borderless & airy, bigger type, depth from background tint not borders+shadows — a refined reading app, less 'terminal'. (C) Brutalist mono: bold sharp type, thick rules, monochrome + one accent, loud & deliberate. Which direction, and anything to steer?

- Answer: _unanswered_

### q5 — Reconciling two things you said: earlier 'the rounded card with left border is AI slop, want a modern design,' and just now 'the original card is nice as long as you let me submit free-form feedback.' Which is the real scope?

- Options: Just the free-form fix: option cards should ALSO accept a custom/free-form answer (native-AskUserQuestion 'Other' parity). Visual stays as-is. (recommended) | Both: the free-form fix AND a modern visual refresh of the card system (kill the rounded-rect + fat left-border look). | Mainly the visual refresh — free-form is secondary.
- Answer: Both: the free-form fix AND a modern visual refresh of the card system (kill the rounded-rect + fat left-border look).

### q6 — Direction for the card-system refresh (keeping the codec identity — masthead, mono, scanlines stay; only the card treatment changes). Which look?

- Options: Hairline telemetry (rec): drop the radius + fat left-border; items sit in flat panels divided by thin rules; accent becomes a small mono tag/dot/underline. Dense, real-instrument feel. (recommended) | Tinted & borderless: keep card grouping but remove radius-bloat + fat border; depth from a faint accent-tinted fill + single hairline. Softer, still 'cards'. | HUD brackets: replace rounded rects with sharp corner-bracket [ ] frames + mono headers. Hard Metal-Gear HUD look.
- Answer: Hairline telemetry (rec): drop the radius + fat left-border; items sit in flat panels divided by thin rules; accent becomes a small mono tag/dot/underline. Dense, real-instrument feel.

### q7 — Batch interaction model — when the agent asks several independent questions at once, how should answering feel?

- Options: Keep instant-per-card, just ask together (rec): agent sends a batch in one call; all cards appear at once under a group header; you answer each instantly (tap = answer) as today. Fastest, preserves the flow you like. (recommended) | Group with one 'Submit all': batch cards are filled then sent together with a single submit; lets you review all before sending; standalone single questions stay instant. | Both: instant-per-card stays, plus a 'send all answered' action when multiple are open.
- Answer: Keep instant-per-card, just ask together (rec): agent sends a batch in one call; all cards appear at once under a group header; you answer each instantly (tap = answer) as today. Fastest, preserves the flow you like.

### q8 — Free-form fix on option cards — how should a custom answer work?

- Options: Native 'Other' parity (rec): every option question (single AND multi) also shows a free-form box with its own submit; custom text alone is a valid answer, OR it rides along as a note on a chosen chip. (recommended) | Note-only: keep chips as the answer; a typed note always submits together with a chip tap (no chip-less custom answer). | 'Something else' chip: add an explicit chip that expands a textarea + submit, separate from the quick chips.
- Answer: Native 'Other' parity (rec): every option question (single AND multi) also shows a free-form box with its own submit; custom text alone is a valid answer, OR it rides along as a note on a chosen chip.
