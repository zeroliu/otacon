---
title: sticky-session-header
session: otc_7a3l7p
revision: 2
status: approved
created: 2026-06-14
---

## Summary

Replace the scroll-away hero (`SessionHead`) with **one always-present sticky header**
pinned to `top: 0`. Expanded at top it shows the full masthead (title, rev, repo/branch,
status) + switcher + clean⇄diff toggle + Approve; scrolling down **compacts** it to a tight
one-line bar, re-expanding at top. One element, always complete ⇒ double-render is
impossible. Phone stays lean: title + switcher chips only, Approve in the bottom bar.

## Decisions

- D1: One always-present sticky header replaces the hero (`SessionHead`); it holds the full masthead + controls and **compacts on scroll**, re-expanding at top ← q1, t1
- D2: Header controls = Approve + clean⇄diff toggle + revision; the diff baseline picker, changed-tally/`j`-`k`, and changelog recall stay in a contextual in-flow strip (not changelog in the header) ← q2
- D3: Phone header = title + switcher chips only; Approve stays solely in the bottom bar ← q3
- D4: Header rendered inside `ReviewLoop` (it owns session/view/approve state); cleaned/missing screens keep their own minimal topbar [assumed]
- D5: Compact state toggled by scroll position (rAF-throttled listener) — one element means no reveal to gate, and a missed update merely leaves it expanded ← q1, t1
- D6: Phone subset via the existing 639px CSS breakpoint — no new JS viewport detection [assumed]

| Pick | Approach                                        | Tradeoff                                                       |
| ---- | ----------------------------------------------- | -------------------------------------------------------------- |
| ✓    | One header, compacts on scroll (replaces hero)  | always complete; single element ⇒ double-render impossible     |
|      | Hero + separate condensed reveal bar            | needs observer gating; risks duplicating the title             |
|      | Pin the full static header                      | never compacts; eats half a phone viewport pinned              |

## Phases

### Phase 1 — The morphing sticky header (replaces the hero)

Goal: New `ReviewHeader` in `ReviewLoop` subsumes `SessionHead` and adds back + switcher +
clean⇄diff toggle + Approve; always `position: sticky; top: 0`, with a `compact` flag from
scroll position. Remove standalone `SessionHead`; strip seg toggle + Approve from `ReviewControls`.

Files:
- `src/ui/review/header.tsx` [new] — `ReviewHeader` + an rAF-throttled `useCompactOnScroll` hook
- `src/ui/session-screen.tsx` — render `ReviewHeader`; drop the standalone `.topbar` + `SessionHead` from the live branch
- `src/ui/review/banner.tsx` — `ReviewControls` drops the seg toggle + Approve (now in the header), keeps baseline / tally / changelog
- `src/ui/review/header.test.ts` — scroll→compact threshold helper

Verification: `bun run typecheck` · `bun test` · `bun run build` stays Node-runnable (`node dist/cli/main.js`).

#### Details

`ReviewLoop` already owns `session`, `view`/`setView`, `over`, and `setApproveOpen`, so
the header lives there. `SessionScreen`'s `cleaned`/`missing`/loading branches keep their
own inline `.topbar`/`BackLink` (no plan, nothing to pin). The header is the single
masthead: **expanded** at `scrollTop` 0 (full title + repo/branch + status row),
**compact** past a small threshold (tight line: title + rev + switcher + toggle +
Approve). Because it is one persistent element there is no second copy to gate — a missed
scroll update just leaves it expanded, fully functional. `ReviewControls` keeps only the
contextual re-review bits: the diff baseline picker, the changed-section tally with its
`j`/`k` hint, and the changelog recall button.

### Phase 2 — Styles: pin, compact transition, phone subset, occlusion fixes

Goal: Sticky positioning (surface backdrop + bottom hairline), the expanded↔compact
transition (collapse meta rows, shrink title, tighten padding, faint lift), the phone
subset, and the occlusion papercuts a top bar introduces (rail offset, scroll-margin-top).

Files:
- `src/ui/styles.css`

Verification: `bun run verify:branch visuals` — compacts on scroll-down and re-expands at
top, at desktop and phone widths; rail clears the bar; `j/k` / thread / decision jumps
land below the bar.

#### Details

- `.review-header { position: sticky; top: 0; z-index: 20 }` with `--surface` bg + a
  bottom `--line` rule; below composer/sheets (z40/41).
- `.compact` collapses `.session-where` + `.session-meta`, shrinks the title, tightens
  padding, and adds a faint lift shadow — a short height/opacity transition.
- `@media (max-width: 639px)`: hide rev + view toggle + Approve in the header; keep title
  + switcher chips. Approve stays in the existing fixed bottom bar (D3).
- Rail `top` bumps from `18px` to clear the compact bar height so it doesn't underlap.
- `scroll-margin-top` on anchored jump targets (section/phase headings) so `flashAnchor`,
  `j/k`, the ❓-queue jump, and decision deep-links don't land hidden under the bar.

### Phase 3 — Docs

Goal: Record the sticky-header model and the phone Approve placement.

Files:
- `DESIGN.md` (§7 switcher/header, §10 review desktop + phone)
- `DECISIONS.md`

Verification: prose matches shipped behavior; `rg "sticky|compact" DESIGN.md` reads true.

#### Details

§10 desktop/phone get the sticky-header note (replaces the hero; compacts on scroll); §10
phone keeps the explicit "Approve never shown twice" rule and states the header carries
title + chips only. DECISIONS.md: one-header-compacts-vs-reveal-bar (single element ⇒ no
double render), phone-Approve-stays-bottom (preserves the never-twice rule), scroll-driven
compaction (rAF-throttled, fails to expanded).

## Risks

> [!risk]
> Phone never-twice: the header's Approve must be CSS-hidden < 640px, or Approve shows in
> **both** the header and the bottom bar — the exact rule §10 forbids.

> [!note]
> Folding the masthead into a sticky header changes first-paint layout; the compact
> transition must not jank per scroll frame — rAF-throttle it, like the selection reposition.

- A `top: 0` header occludes scroll-jump targets: `flashAnchor`, `j/k`, the ❓ queue jump,
  and decision deep-links land under it without `scroll-margin-top` on targets.
- The desktop rail is `sticky; top: 18px`; against a `top: 0` bar it underlaps unless its
  `top` clears the compact bar height.
- `ReviewControls` loses its seg toggle + Approve to the header; the contextual strip
  (baseline / tally / changelog) must still render correctly in diff and re-review.

## Open Questions

None — approach (q1 + t1), control set (q2), and phone behavior (q3) are settled.

## Interview

### q1 — How should the pinned header behave as you scroll down a long plan?

- Options: Condensed bar — the existing top strip (back + session switcher) pins to top:0, and the plan title + Approve fade into it once the full header scrolls past (recommended) | Pin the full header as-is — the whole title block + clean/diff + Approve controls stay fixed at the top
- Answer: Condensed bar — the existing top strip (back + session switcher) pins to top:0, and the plan title + Approve fade into it once the full header scrolls past

### q2 — Besides the plan title + session switcher, which controls should ride the pinned condensed bar on desktop?

- Options (multi): Approve (recommended) | Clean⇄Diff view toggle | Changelog recall | Revision number (r4)
- Answer: Clean⇄Diff view toggle, Approve, Revision number (r4)

### q3 — On phone, Approve already lives in the fixed bottom bar (DESIGN §10: never shown in two places). What should the pinned top header carry on phone?

- Options: Title + switcher chips only — Approve stays in the bottom bar (recommended) | Title + switcher + Approve too (accept duplication) | No pinned top header on phone — keep only the bottom bar
- Answer: Title + switcher chips only — Approve stays in the bottom bar
