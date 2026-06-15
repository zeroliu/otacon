---
title: hide-approved-sessions-mobile-tabs
session: otc_3yzs7k
revision: 3
status: approved
created: 2026-06-14
---

## Summary

Approved sessions linger until `otacon clean`, cluttering the phone switcher and
home list. Hide them from both switcher faces — including the one you're viewing
— and when the session you're on flips to approved, auto-navigate to home, where
approved sessions sit in a collapsed `approved` section with a count. One shared,
React-free split feeds both surfaces, so they can never disagree.

## Decisions

- D1: Switcher hides ALL approved sessions, including the one you're viewing —
  no "anchor" exception. ← q1 (revised by t3)
- D2: Filter both switcher faces (phone chips + desktop dropdown), one list. ← q2
- D3: When the viewed session transitions to approved, auto-navigate to home;
  opening an already-approved session from home does NOT redirect, so approved
  plans stay readable. ← q5, t3
- D4: Group approved on home into a dedicated section, collapsed by default,
  heading shows a count. ← q3, q4

  | Pick | Behavior                          | Tradeoff                                 |
  | ---- | --------------------------------- | ---------------------------------------- |
  | ✓    | Collapsible, collapsed by default | declutters; approved is one tap away     |
  |      | Always-visible labeled group      | no interaction, but still fills the list |
  |      | Collapsible, expanded by default  | toggle cost without the declutter win    |

- D5: [assumed] Home `list-head` count reflects active (main-list) sessions; the
  approved section carries its own count.
- D6: [assumed] One shared `partitionByApproval` (no React) feeds switcher
  (`.active`) and home (`.active` + collapsed `.approved`) — a single source.

## Phases

### Phase 1 — Shared approval split + tests

Goal: One React-free source of truth for active-vs-approved, unit-tested like
`callout.ts`, so the switcher and home can never disagree.

Files:
- `src/ui/session-filter.ts` [new] — `partitionByApproval(sessions)` →
  `{ active, approved }`, order-preserving; `isApproved` helper.
- `src/ui/session-filter.test.ts` [new]

Verification: `bun test` — splits on `status === "approved"`, both lists keep
input order, neither side drops or duplicates a session.

### Phase 2 — Switcher hides approved (both faces)

Goal: The switcher (DESIGN.md §7) shows only active sessions. The current chip
may be absent now (you can open an approved session from home), so the dropdown
needs a placeholder instead of rendering blank.

Files:
- `src/ui/switcher.tsx` — build `entries` from
  `partitionByApproval(byActivity).active`; keep current-first ordering; show a
  placeholder option + empty value when `current` isn't among `entries`.

Verification: `bun run typecheck` + `bun run build`; approved sessions absent
from chips and dropdown, and an opened-approved session shows a labeled
placeholder, not a blank select.

#### Details

`gone` (cleaned current) and "current is approved" collapse into one condition:
current is not in the visible `entries`. `stateOf`/`GLYPHS` keep `approved` for
the placeholder label. Chips simply omit an absent current — no anchor.

### Phase 3 — Auto-navigate to home on approval

Goal: When the session you're viewing transitions to approved, send you to home
(D3). Opening an already-approved session must NOT redirect, or the home
approved section can't open anything.

Files:
- `src/ui/session-screen.tsx` — in `SessionScreen`, `navigate("/")` only on the
  live non-approved → approved transition (track prior status); never on a mount
  that is already approved.

Verification: approving the viewed session lands you on home; tapping an
approved card from home opens its read-only plan and stays there.

### Phase 4 — Home: collapsed approved section (+ seed)

Goal: Active sessions stay in `.cards`; approved ones move into a
collapsed-by-default section (heading `approved` + count), reusing the
activity-panel disclosure idiom (button + `aria-expanded` + caret + `useState`).

Files:
- `src/ui/index-screen.tsx` — `partitionByApproval`; render `active` in
  `.cards`; add `ApprovedSection` (reusing `SessionCard`); `list-head` count →
  `active.length`; `EmptyState` only when total is 0.
- `src/ui/styles.css` — `.approved-group` / `.approved-toggle` / count + caret,
  mirroring `.activity-*`.
- `test/populate-session.sh` — seed a second session driven to `approved`
  alongside the `in_review` one, so the hide + section + redirect are demoable
  (today every seeded session stays `in_review`). ← t1

Verification: `bun run build`, then `bun run verify:branch full`: the seeded
approved session is gone from the switcher and grouped under a collapsed
`approved (n)` header on home that expands on tap.

### Phase 5 — Docs

Goal: Keep DESIGN.md/DECISIONS.md truthful in the same change.

Files:
- `DESIGN.md` — §7 (switcher hides approved), §10 (home approved section +
  active-only count), §12 (approving the viewed session navigates home).
- `DECISIONS.md` — D1/D2 (switcher filter, no anchor), D3 (redirect on
  transition only), D4 (collapsed home section) as Decision / Why / Revisit-when.

Verification: `git diff` shows DESIGN/DECISIONS moved with the code; nothing
documented that the code doesn't do.

## Risks

> [!risk]
> The redirect must fire on the live transition only, not on mount — if it fires
> whenever status is approved, tapping an approved card from home bounces
> straight back and approved plans become unopenable.

> [!risk]
> A `session` SSE frame can flip the current session to approved without you
> approving it here (e.g. approved on another device), and you'd still be sent
> home. Accepted per q5 (chose auto-navigate over the local-only option).

## Open Questions

- D5 (list-head count → active only): if you'd rather "sessions N" stay the
  registry total, that's a one-line flip — flag it in review.

## Interview

### q1 — When you're viewing a session that's already approved, should its own chip still appear in the switcher (as the 'you are here' anchor) while OTHER approved sessions are hidden?

- Options: Keep the current session's chip, hide other approved (recommended) | Hide all approved including the one you're on
- Answer: Keep the current session's chip, hide other approved

### q2 — The switcher renders as a phone chip strip AND a desktop dropdown from the same list. Hide approved from both faces, or only the phone chips you mentioned?

- Options: Both faces (switcher hides approved everywhere) (recommended) | Phone chips only; desktop dropdown still lists approved
- Answer: Both faces (switcher hides approved everywhere)

### q3 — Should approved sessions also drop off the home/index screen list, or stay there so approved work is still reachable from home?

- Options: Leave home unchanged — only the switcher changes (recommended) | Hide approved from home too
- Answer: We should create a section to group approved sessions

### q4 — How should the new 'approved' section on the home screen behave? Active sessions stay in the main list; approved ones move into this section below them.

- Options: Collapsible, collapsed by default (heading shows a count, tap to expand) (recommended) | Always visible as a labeled group, no toggle | Collapsible but expanded by default
- Answer: Collapsible, collapsed by default (heading shows a count, tap to expand)

### q5 — Reversing D1: approved sessions drop from the switcher INCLUDING the one you're viewing. When the session you're on becomes approved (so its chip is gone), what should happen to you?

- Options: Auto-navigate to the home/index view right after it's approved (recommended) | Stay on the read-only approved plan (shows the committed path); return home via the existing back link | Auto-navigate, but only when YOU approve it here — not when it flips approved on another device
- Answer: Auto-navigate to the home/index view right after it's approved
