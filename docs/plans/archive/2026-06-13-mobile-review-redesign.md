---
title: mobile-review-redesign
session: otc_wdsjoc
revision: 1
status: approved
created: 2026-06-13
---

## Summary

On a phone the two-column grid collapses, dumping every comment and question in a
rail *below the whole plan* — far from the text it anchors to, so each thread costs a
scroll to the bottom and back. This ships the phone model DESIGN.md §10 specs but
never built: inline per-anchor markers on section/phase headers, a focused bottom
sheet per anchor, and a sticky-bar ⊙N button for the full list + orphan tray.

## Decisions

- D1: Build §10's unshipped phone model — inline thread markers + bottom-sheet threads — scoped to threads only, no plan typography or chrome rework. ← q1
- D2: Tapping a section/phase marker opens a sheet holding only that anchor's threads, not the full list. ← q2
- D3: The inline marker counts only open threads (unresolved comments, unanswered questions); resolved threads stay in the sheet but off the badge. ← q3
- D4: The new model replaces the rail below 721px — the whole single-column regime — so no stacked rail survives at any narrow width. ← q4
- D5: A ⊙N button in the sticky bar opens the global sheet (all threads + orphan tray), preserving §637's "orphans always reachable" invariant. ← q5
- D6: Markers mount via React portals into static header slots, so live counts never re-render the memo'd PlanView (which rewrites .md innerHTML and would collapse an in-progress selection). [assumed]
- D7: Markers render as a mono codec mark (⊙N), not the literal 💬 emoji the §10 sketch draws — the rest of the UI is hairline-telemetry mono with no emoji. [assumed]

## Phases

### Phase 1 — Threads bottom sheet + card reuse

Goal: A bottom-sheet component that lists a given set of threads by reusing the
rail's existing cards — the shared surface both entry points (markers, bar) open.

Files:
- `src/ui/review/thread-card.tsx` (new) — extract ThreadCard / ResolvedCard / OrphanCard out of rail.tsx
- `src/ui/review/rail.tsx` — re-import the extracted cards (desktop stays byte-identical)
- `src/ui/review/thread-sheet.tsx` (new) — the bottom sheet, per-section and global modes
- `src/ui/review/thread-sheet.test.tsx` (new)
- `src/ui/styles.css` — sheet chrome, reusing the bottom-sheet shell

Verification: `bun test` — cards render unchanged after extraction; the sheet shows a
section's threads in per-section mode and the orphan tray + full live list in global
mode; tapping a thread fires onJump.

#### Details

Move ThreadCard, ResolvedCard, and OrphanCard verbatim into `thread-card.tsx`
(behavior unchanged); rail.tsx imports them so the desktop rail renders identically.
`thread-sheet.tsx` takes `threads`, an optional `section` filter, a `title`, and
`onJump`. Global mode renders the rail's exact structure (orphan tray, live threads
newest-first, resolved collapsed); per-section mode filters to `anchor.section ===
section`, listing open threads with resolved ones collapsed below. The sheet reuses
the section-menu / composer bottom-sheet shell (scrim, slide-up, safe-area-inset
padding, lift shadow). Tapping a thread closes the sheet, then calls onJump so the
existing scroll-and-flash runs against the plan underneath.

### Phase 2 — Inline per-anchor markers

Goal: Every section/phase header shows a marker badging its open-thread count;
tapping opens that anchor's sheet. Mobile only; desktop keeps the rail.

Files:
- `src/ui/plan/plan-view.tsx` — render a static `thread-slot` span in section-rail and phase-head
- `src/ui/review/thread-marker.tsx` (new) — the marker badge
- `src/ui/session-screen.tsx` — group threads by anchor, portal markers into the slots, open the per-section sheet
- `src/ui/review/thread-marker.test.tsx` (new)
- `src/ui/styles.css` — marker styling; `display:none` at ≥721px

Verification: `bun test`; on a narrow viewport a section with 2 open threads shows
⊙2, tapping opens its sheet, the count ignores resolved threads, and a thread SSE
frame does not re-render PlanView.

#### Details

PlanView gains a static, callback-free `<span className="thread-slot"
data-thread-slot={id} />` in each header — no thread data crosses the prop boundary,
so the string-prop memo and the innerHTML-stability guarantee both hold. After each
render or threads change, session-screen queries `planRef` for `[data-thread-slot]`
and `createPortal`s a `<ThreadMarker count onClick>` into each, counts coming from a
`threadsByAnchor` map (open threads grouped by `anchor.section`, orphaned excluded).
The marker click sets the per-section sheet state. The portal layer is the live
surface; PlanView itself stays frozen exactly as today.

### Phase 3 — Sticky-bar entry + breakpoint swap + docs

Goal: The sticky bar gains the global ⊙N button; below 721px the side rail yields to
markers + sheet. Spec and decisions updated to match what ships.

Files:
- `src/ui/review/drawer.tsx` — add the ⊙N bar instrument (phone), opens the global sheet
- `src/ui/session-screen.tsx` — global sheet state; stop rendering the stacked rail below 721px
- `src/ui/styles.css` — hide `.rail` < 721px / reveal markers + bar-threads; bar-button styling
- `DESIGN.md` — §10 phone section: markers + bottom-sheet threads + ⊙N entry (replace stacked-rail wording)
- `DECISIONS.md` — entry recording the inline-marker + per-section-sheet model

Verification: `bun test`; `bun run typecheck`; `bun run build` (`node dist/cli/main.js`
still boots). Narrow viewport: no stacked rail, ⊙N opens the global sheet with orphan
tray; ≥721px the desktop rail is unchanged.

#### Details

The rail's DOM stays mounted and authoritative at ≥721px; below 721px session-screen
renders the marker portals + sheets instead, and the bar carries ⊙N. drawer.tsx adds
the bar-threads instrument beside ❓/Send/Approve, glyph-collapsing like its siblings
on the densest 375px row so it never wraps. DESIGN.md §10 already sketches the
`💬2`-style markers and "threads open as bottom sheets"; this updates the prose to
the shipped shape — mono ⊙N marker, per-anchor sheet, ⊙N global entry — and notes the
side rail is the ≥721px-only surface.

## Risks

- Portal slots vs revision re-render: when PlanView re-renders a new revision the slot nodes are replaced — re-query slots on the same deps that drive PlanView, or markers orphan.
- Sticky-bar crowding: ⊙N is a sixth instrument; on a 375px row with a pending batch it must glyph-collapse like ❓/Approve or the bar wraps.
- Shared cards, two chromes: the rail and the sheet share extracted cards but differ in shell — the extraction must keep the desktop rail byte-identical.
- Marker tap vs long-press selection in the header: markers sit in the meta row, away from selectable prose, so the two gestures don't fight.

## Open Questions

- None blocking. The mono ⊙N glyph (D7) and the exact bar placement of ⊙N are visual calls best settled in the browser review, not on paper.

## Interview

### q1 — The biggest mobile pain is the threads rail: on phone it collapses below the whole plan, so every comment/question sits far from the text it anchors to. DESIGN.md §10 already specs (but the code never built) a phone model — inline 💬N markers per section/phase + threads opening as bottom sheets. Where should this redesign aim?

- Options: Build the §10 phone model: inline markers + bottom-sheet threads (threads-only scope) (recommended) | Same, PLUS a plan-content readability pass (typography/spacing/density of the plan itself) | Broader: also rework the stacked chrome above the plan (controls/grill/interview)
- Answer: Build the §10 phone model: inline markers + bottom-sheet threads (threads-only scope)

### q2 — When you tap a section/phase's inline 💬N marker, what should the bottom sheet contain?

- Options: Just that section's threads — focused, fully in-context (recommended) | The full threads list, auto-scrolled to that section — one place holds everything
- Answer: Just that section's threads — focused, fully in-context

### q3 — What should an inline 💬N marker count?

- Options: Only open/unresolved threads — resolved ones are done, keep the inline count quiet (recommended) | All threads anchored there, including resolved
- Answer: Only open/unresolved threads — resolved ones are done, keep the inline count quiet

### q4 — At which width should the new mobile model (inline markers + bottom-sheet threads) replace the side rail?

- Options: Below 721px — the whole single-column regime, so a stacked rail never appears at any narrow width (recommended) | Only ≤639px (phone) — tablets 640–720px keep the current stacked rail
- Answer: Below 721px — the whole single-column regime, so a stacked rail never appears at any narrow width

### q5 — Section markers cover threads anchored to a section. But whole-plan comments (no section anchor), orphaned threads (their quoted text is gone — DESIGN.md says the orphan tray must always stay reachable), and a 'see everything' overview need a global entry. Where should the all-threads affordance live on mobile?

- Options: A ⊙N button in the sticky bar — the documented phone control surface, always visible while scrolling; opens the full list + orphan tray as a sheet (recommended) | A ⊙N threads overview marker at the top of the plan — same tap-a-marker idiom as sections, keeps the sticky bar uncrowded, but scrolls away | A ⊙N chip in the header strip beside the title
- Answer: A ⊙N button in the sticky bar — the documented phone control surface, always visible while scrolling; opens the full list + orphan tray as a sheet
