---
title: mobile-review-ux-fixes
session: otc_rnhxpq
revision: 2
status: approved
created: 2026-06-14
---

## Summary

Three phone review fixes, one also hitting desktop. Stop iOS auto-zoom-on-focus by
sizing touch inputs ≥16px, while keeping pinch-zoom. Make bottom sheets
keyboard-aware — lift them above the keyboard via VisualViewport and freeze the
page behind. Retire the floating selection toolbar (it lands where the
unsuppressable native popover does) and surface Comment/Ask as a docked bar.

## Decisions

- D1: Keep pinch-zoom (a11y) — leave the viewport meta permissive; defeat only iOS's auto-zoom-on-focus by sizing touch inputs ≥16px ← q3, reversed by t1
- D2: Native selection popovers (iOS long-press callout, macOS force-click Look-Up) are unsuppressable on the web — design for coexistence by placement, not suppression ← q4 [research]
- D3: Keyboard handling = position bottom sheets above the keyboard via VisualViewport + lock the background so the page behind stops moving while typing ← q1
- D4: One shared keyboard mechanism for all bottom sheets (composer, section ⋯ menu, approve), not just the composer that triggered the report [assumed]
- D5: Retire the floating "codec cursor" selection toolbar; Comment/Ask becomes a docked bar that never overlays the text, on phone and desktop; desktop c/q shortcuts stay ← q4

| Pick | Selection affordance | Why / tradeoff                                                  |
| ---- | -------------------- | -------------------------------------------------------------- |
| ✓    | Docked Comment/Ask bar | Never enters the native popover zone; one model both platforms |
|      | Keep floating, dismiss on conflict | macOS Look-Up still overlaps on force-click (unpreventable) |
|      | Margin gutter pip    | Coexists, but anchors to the block, not the exact span         |
|      | Canvas selection (Docs) | Eliminates native UI but reimplements selection/a11y — overkill |

## Phases

### Phase 1 — Stop iOS input auto-zoom (keep pinch-zoom)

Goal: Stop iOS auto-zooming when a sub-16px field is focused, without disabling
pinch-zoom. Size touch inputs to ≥16px; leave the viewport meta permissive. CSS
only, no JS.
Files:

- src/ui/styles.css — at the phone breakpoint (max-width: 639px), set `input, textarea, select` to `font-size: 16px` (covers the composer, drawer edit, and grill answer fields)
- src/ui/index.html — confirm the viewport stays `width=device-width, initial-scale=1` (no `maximum-scale`/`user-scalable=no`), so pinch-zoom works
- DESIGN.md — note: pinch-zoom stays on; iOS auto-zoom defeated by ≥16px inputs
- DECISIONS.md — record: preserve pinch-zoom a11y, kill only the input auto-zoom

Verification: `bun run build`; on an iPhone over Tailscale, tapping the composer no
longer zooms in and pinch-to-zoom still works.

### Phase 2 — Keyboard-aware bottom sheets

Goal: Lift every bottom sheet above the on-screen keyboard and freeze the page
behind it, so the composer's Send buttons are never under the fold and the layout
behind the keyboard stops shifting. [new] hook, no new sheet types.
Files:

- src/ui/review/keyboard.ts — `useKeyboardInset()` (VisualViewport resize/scroll → px gap below the visual viewport) + `useScrollLock(active)` (lock `<body>` while a sheet is open)
- src/ui/review/keyboard.test.ts — inset math from a mocked visualViewport; lock/unlock toggling and cleanup
- src/ui/session-screen.tsx — set a `--kb-inset` CSS var from the hook; engage scroll-lock while composer/menu/approve is open (phone widths)
- src/ui/styles.css — `.composer-sheet`/`.sec-sheet`/`.approve-sheet` bottom → `calc(14px + env(safe-area-inset-bottom) + var(--kb-inset, 0px))`
- DESIGN.md — §10 phone sheets: note keyboard-aware positioning + background lock

Verification: `bun test` (hook); on iPhone the composer rides above the keyboard,
its buttons stay visible, and the plan behind no longer scrolls.

#### Details

`useKeyboardInset` reads `window.visualViewport` and returns
`layoutHeight - (vv.height + vv.offsetTop)` (0 when no keyboard / unsupported),
recomputed on its `resize`+`scroll` events and on teardown removes them. The sheet
already anchors to `bottom`; adding `var(--kb-inset)` raises it by exactly the
keyboard height. `useScrollLock` pins `<body>` (overflow hidden + preserved scroll
position) only while a sheet is open below `SHEET_VIEWPORT`, so desktop is
untouched. No change to which sheets exist — only where they sit.

### Phase 3 — Docked selection bar (retire the floating toolbar)

Goal: Replace the over-the-selection `SelectionToolbar` with a docked Comment/Ask
bar pinned to a fixed viewport edge, so it never collides with the native
selection/dictionary popover. Desktop c/q shortcuts unchanged.
Files:

- src/ui/review/feedback.tsx — `SelectionToolbar` → docked `SelectionBar`: drop rect-based positioning + caret nub; keep section slug + Comment/Ask + the captured selection
- src/ui/session-screen.tsx — render the docked bar from the same `selection` state; no positioning props
- src/ui/styles.css — `.sel-toolbar` styles → docked bar (bottom-center, thumb range on phone w/ safe-area; slim auto-width on desktop); remove the floating/nub rules
- DESIGN.md — §10: selection affordance is a docked bar (coexists with native popovers), not a floating cursor; note native popovers are unsuppressable
- DECISIONS.md — why coexist-by-placement over suppression/canvas (cite the research)

Verification: `bun run verify:branch visuals`; selecting text — desktop Look-Up and
the iPhone callout no longer stack on our bar.

#### Details

The bar reuses the existing capture path: `useSelection` still tracks the live
selection and yields a `CapturedSelection`; only the presentation changes from a
fixed point over the rect to a docked element. Comment still stacks into the
drawer, Ask still fires the composer — both unchanged downstream. On desktop the
bar reads as a discoverability aid beside the already-present c/q shortcuts; the
slight distance from the selection is the deliberate cost of leaving the popover
zone (D5). The `at`-based composer placement is untouched: the composer opens on a
click that has already dismissed the native popover.

## Risks

> [!risk]
> VisualViewport keyboard insets vary across iOS/Android versions; the inset math
> needs real-device checks, not just the unit mock.

- A bottom-docked selection bar sits farther from the selection on desktop than the
  floating toolbar did — an ergonomics tradeoff, mitigated by the c/q shortcuts.
- Pure UI change (src/ui + index.html): no daemon/CLI/protocol surface, so no
  `./bin/otacon restart` — just rebuild to see it.

## Open Questions

- Desktop docked-bar placement: bottom-center (reuses the sheet model) vs. a strip
  pinned to the reading column — settling during Phase 3 unless you have a preference.

## Interview

### q1 — On a phone the comment composer opens as a bottom sheet (position: fixed; bottom: 14px) and auto-focuses its textarea, so iOS slides the keyboard over it and the Send buttons end up behind/under the fold. How should the sheet stay visible?

- Options: Track the keyboard with the VisualViewport API and lift the sheet above it (recommended) | Add interactive-widget=resizes-content to the viewport meta + switch the sheet to dvh units | Move the composer to a top-anchored / centered position on phone so the keyboard never reaches it
- Answer: when typing on keyboard, the UI behind it also is affected. We need a better keyboard control in general

### q2 — On a phone the select-to-comment toolbar still floats over the selection, so it overlaps the native long-press menu (Copy / Look Up). How should the comment/ask affordance behave on phone?

- Options: Dock comment/ask as a bottom sheet in thumb range (like the section ⋯ menu); drop the floating toolbar below 640px (recommended) | Keep the floating toolbar but try to suppress the native selection menu | Drop the per-selection affordance on phone entirely; rely on the section ⋯ menus for coarse anchoring
- Answer: btw, this is not only a phone problem. On desktop, I run into the same issue with dictionary popover overlaps with the otacon popover as well. I would be very curious how apps such as google docs or notion handle this

### q3 — How far should 'disable zoom' go? The viewport currently allows pinch-zoom, and the 14px composer input also makes iOS auto-zoom on focus.

- Options: Disable both: viewport maximum-scale=1, user-scalable=no (kills pinch + input auto-zoom; note: removes pinch-zoom accessibility) (recommended) | Only stop the iOS input auto-zoom (bump inputs to 16px); keep pinch-zoom for accessibility | Disable pinch via the meta AND bump inputs to 16px (defense in depth)
- Answer: Disable both: viewport maximum-scale=1, user-scalable=no (kills pinch + input auto-zoom; note: removes pinch-zoom accessibility)

### q4 — Research verdict: native selection popovers can't be suppressed on the web — not the iOS long-press callout, not the macOS force-click 'Look Up' dictionary (OS trackpad feature, no JS hook). Google Docs only avoids it by rendering text to canvas (overkill); Notion/Medium just coexist by placement. otacon's selection toolbar is the 'codec cursor' that floats directly OVER the selection — exactly where the native popover lands, on both desktop and phone. How should we resolve the overlap?

- Options: Relocate it out of the popover zone on both platforms: selection shows a docked Comment/Ask bar (bottom-center in thumb range on phone, a slim pinned bar on desktop) that never floats over the text; keep desktop c/q shortcuts. Retires the floating codec-cursor toolbar. (recommended) | Keep the floating toolbar but reduce overlap: show only after a deliberate drag-select and auto-dismiss on scroll/blur/force-click. Keeps the aesthetic, but macOS Look-Up can still overlap on force-click (inherent, unpreventable). | Make it a left-margin gutter affordance next to the selected block (Notion-style comment pip), out of the inline text entirely. Clean coexistence, but anchors to the block, not the exact selection span (coarser).
- Answer: Relocate it out of the popover zone on both platforms: selection shows a docked Comment/Ask bar (bottom-center in thumb range on phone, a slim pinned bar on desktop) that never floats over the text; keep desktop c/q shortcuts. Retires the floating codec-cursor toolbar.
