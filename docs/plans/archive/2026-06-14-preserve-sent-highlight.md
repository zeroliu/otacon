---
title: preserve-sent-highlight
session: otc_hgjuzt
revision: 2
status: approved
created: 2026-06-14
---

## Summary

Anchored plan text only gets a 1.7s flash on thread-click — once feedback is sent
the selection clears and nothing stays lit, so you can't see which passages are
under discussion. This adds a **persistent** highlight layer: open threads and
unsent drafts keep their anchored text lit (two treatments — question vs comment),
and tapping a lit span focuses its thread. Painted without re-rendering the plan.

## Decisions

- D1: Persistent highlight covers open threads only — unanswered questions +
  unresolved comments; answered/resolved threads clear their mark ← q1
- D2: Not-yet-sent drawer drafts are lit too, sharing the comment treatment (no
  separate draft style — refined in review per t1) ← q2
- D3: Two readable treatments — open question vs open comment; drafts reuse the
  comment look. Questions stay scannable (refined from "three" per t1) ← q3
- D4: Paint from a ReviewLoop effect over `planRef` via the CSS Custom Highlight
  API — never by re-rendering PlanView (see matrix) ← [assumed]
- D5: Clean view only; orphaned threads and whole-plan (null-anchor) feedback are
  never lit — no re-locatable quote exists ← [assumed]
- D6: The click flash (`otacon-flash`) keeps top priority; persistent layers sit
  beneath it so a clicked thread still pops ← [assumed]
- D7: Reverse interaction — a *tap* (collapsed selection) on a lit span focuses
  its rail thread; a *drag* still starts select-to-comment, so no gesture clash ← [assumed]

| Pick | Paint location              | Tradeoff                                                  |
| ---- | --------------------------- | -------------------------------------------------------- |
| ✓    | ReviewLoop effect on ref    | reuses flash infra; no re-render, never kills selections |
|      | Re-render PlanView w/ props | DECISIONS.md warns a re-render rewrites DOM, kills sel.   |
|      | Wrap quotes in `<mark>`     | mutates DOM React owns; fights reconciliation             |

## Phases

### Phase 1 — Persistent highlight engine

Goal: A pure painter in `anchor.ts` that, given the plan container and a list of
`{anchor, kind}` entries, re-locates each quote (reusing `findExactRange`) and
registers two named CSS highlights, clearing them when the list is empty.

Files:
- `src/ui/review/anchor.ts` — add `paintThreads(container, entries)` +
  `clearThreadHighlights()`; factor the section-scoped range lookup out of
  `flashAnchor` so both share it; set highlight `priority` below the flash.
- `src/ui/review/anchor.test.ts` — new; cover range selection over a constructed
  DOM (open vs orphaned/un-relocatable quote, null anchor, prefix disambiguation).

Verification: `bun test src/ui/review/anchor.test.ts` · `bun run typecheck`.

#### Details

`paintThreads` groups entries into two kinds — `question` → `otacon-q`, and
`comment` (covering both sent comments and unsent drafts) → `otacon-comment` —
builds a `Highlight` per kind from the re-located `Range`s, and
`CSS.highlights.set`s each (deleting empties). It is a no-op when
`typeof Highlight === "undefined"` — same graceful degradation the flash relies
on. Whole-plan (null) anchors and quotes that fail to re-locate are silently
skipped, exactly like the flash's fallback.

### Phase 2 — Wire it into the review screen

Goal: Derive the lit set from `threads` + `pending` and repaint on every change,
including after the lazy renderer commits a new revision — without re-rendering
PlanView.

Files:
- `src/ui/session-screen.tsx` — `useMemo` the lit entries (open question =
  no `answer` & not orphaned & has `exact` → kind `question`; open comment =
  no `resolution`, same guards, plus each `pending` draft with an `exact` → kind
  `comment`); a `useLayoutEffect` paints via `paintThreads(planRef.current, …)`
  when `view === "clean"`, clears otherwise; a stable `onRendered` tick re-fires
  the paint once PlanView commits.
- `src/ui/plan/plan-view.tsx` — optional stable `onRendered?: () => void` prop,
  called from a `useLayoutEffect` after each render (memo stays intact).

Verification: `bun run typecheck` · `bun run build` (node-runnable) ·
`bun run verify:branch full`, then comment/ask/stack and watch the marks persist
and clear.

#### Details

The lit `useMemo` keys on a stable signature (section+exact+kind joined), so
drawer body keystrokes — which don't change anchors — never repaint. `onRendered`
is wrapped in `useCallback` so PlanView's `React.memo` survives; it bumps a
`renderTick` the paint effect depends on, covering the lazy chunk's first mount
and every revision swap (when `planRef`'s DOM is replaced). Answering a question
or resolving a comment arrives as an SSE `threads` frame → the entry leaves the
lit set → its highlight clears on the next paint, no extra wiring.

### Phase 3 — Treatments + docs

Goal: Style the two layers so they're distinguishable (incl. without color) and
quiet against gutter markers and the accent flash; document the behavior.

Files:
- `src/ui/styles.css` — `::highlight(otacon-q)` = wash + underline,
  `::highlight(otacon-comment)` = wash only (Custom Highlight API supports
  background + underline). Shape, not just hue, separates them.
- `DESIGN.md` §4 + §10 — persistent anchored-text marks for open threads & drafts,
  and tap-to-focus-thread.
- `DECISIONS.md` — paint-from-ReviewLoop rationale + open-only/drafts scope.

Verification: `bun run verify:branch full` — confirm the two treatments read apart
and the flash still pops on top; static, so reduced-motion is unaffected.

### Phase 4 — Reverse interaction: tap a lit span → focus its thread

Goal: A tap landing inside a lit span scrolls its thread into view in the rail and
emphasizes it — without stealing the drag-to-select-then-comment gesture.

Files:
- `src/ui/review/anchor.ts` — `threadAtPoint(container, entries, x, y)`:
  `caretRangeFromPoint` → for each entry re-locate its range → `isPointInRange`;
  return the matching thread id (innermost wins).
- `src/ui/session-screen.tsx` — in `onPlanClick`, when the selection is collapsed
  (a tap, not a drag) and `threadAtPoint` hits, set a `focusThread` target.
- `src/ui/review/rail.tsx` — scroll the targeted `.thread` into view (motion-safe)
  and flash a brief emphasis class; nonce re-fires repeat taps.

Verification: `bun run verify:branch full` — tap a lit span jumps the rail to its
card; dragging the same text still opens the comment/ask toolbar.

#### Details

The Custom Highlight API paints over text but never intercepts pointer events, so
clicks fall through to the underlying text node. The tap-vs-drag split is the
whole conflict resolution: a non-empty selection means the user is selecting to
comment (toolbar shows, we don't hijack); a collapsed selection inside a lit span
is the focus gesture. Re-locating ranges at click time (not caching live `Range`s)
keeps it robust against revision re-renders.

## Risks

> [!note]
> iOS is **not** a dealbreaker (t2): the Custom Highlight API shipped in Safari
> 17.2 / iOS 17.2 (Dec 2023), and the existing 1.7s flash already uses this exact
> API on iOS — if the flash lights up on your iPhone, this layer will too. Parity,
> not new exposure. Residual gap is only iOS ≤ 17.1, which silently gets no marks.

> [!risk]
> Two persistent inks over plan text can clash with the amber gutter markers and
> the accent flash. Mitigate with low-opacity washes + a shape cue (underline on
> questions), not saturated fills; tune during Phase 3 verify:branch.

- Repaint timing: if the `onRendered` tick is missed on first lazy mount, marks
  appear one state-change late; the tick + revision dep should close that window.
- `caretRangeFromPoint` (Phase 4 hit-test) is WebKit-named; use the standard
  `caretPositionFromPoint` with a `caretRangeFromPoint` fallback.

## Open Questions

- Should answered/resolved threads leave a faint "was-discussed" tick rather than
  clearing entirely? q1 chose clean clearing; revisit if the plan feels forgetful.

## Interview

### q1 — Which review threads should keep a persistent highlight on their anchored plan text? (Right now only a 1.7s flash on click exists — nothing stays lit.)

- Options: Open threads only (unanswered Qs + unresolved comments) (recommended) | All anchored threads (incl. answered/resolved) | Questions only
- Answer: Open threads only (unanswered Qs + unresolved comments)

### q2 — Comments stack into the drawer before you hit 'send all'. When you stack a draft, the selection clears too — should not-yet-sent drawer drafts also get a persistent highlight, so you can see what you've already queued?

- Options: Yes — highlight pending drafts too (distinct, dimmer style) (recommended) | No — only sent/server threads light up
- Answer: Yes — highlight pending drafts too (distinct, dimmer style)

### q3 — Among SENT open threads, should questions and comments look different, or share one 'open thread' highlight? (Pending drawer drafts already get the dimmer variant from the last answer.) You said you can't tell which ones are being asked — distinguishing makes questions scannable in the plan.

- Options: Distinguish — open question one ink, open comment another (3 readable states w/ drafts) (recommended) | One 'open' ink for both sent kinds — rail carries the kind, quieter look
- Answer: Distinguish — open question one ink, open comment another (3 readable states w/ drafts)
