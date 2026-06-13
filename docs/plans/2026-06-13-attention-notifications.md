---
title: attention-notifications
session: otc_h7dwof
revision: 2
status: approved
created: 2026-06-13
---

## Summary

Desktop notifications when a plan needs your attention. The daemon fires a native
macOS banner when the agent posts a grill question or submits a revision awaiting
review — suppressed when that session's review is already open in a browser. Phone
(Web Push) is explicitly out of scope here and deferred to a TODO. On by default;
one config toggle.

## Decisions

- D1: Desktop-only this milestone; phone Web Push deferred to a dedicated TODOs.md entry ← q1, q2
- D2: Desktop = native macOS banner fired by the daemon (not Web Push) — the daemon already runs on the Mac, so this is the right tool for that surface ← q1
- D3: Triggers = agent posts a grill question + agent submits a revision (awaiting review); a batch `ask` coalesces to one banner ← q3
- D4: Prefer `terminal-notifier` when on PATH (click opens the review URL), fall back to `osascript`; no hard dependency ← q4
- D5: Suppress the banner only while that session's review page is actually visible/focused — the UI reports `document.visibilityState` to the daemon (heartbeat + TTL); a hidden, backgrounded, or closed tab does NOT suppress ← q5
- D6: On by default; toggle via a `notifications.desktop` boolean in `~/.otacon/config.json`, repo override allowed (mirrors budgets config) ← q6
- D7: `osascript`/`terminal-notifier` are local OS calls, not model APIs — the zero-API-spend invariant (§13) is untouched; the daemon making a local OS call is the new behavior worth recording [assumed]

## Phases

### Phase 1 — Config field + desktop-notify module

Goal: Add a `notifications.desktop` config field (default true) and a standalone
module that fires a banner via `terminal-notifier` (preferred) or `osascript`,
no-op off macOS. Pure unit — nothing wired to it yet, so no behavior change.
Files:

- src/shared/config.ts — add `notifications: { desktop: boolean }` to OtaconConfig + DEFAULT_CONFIG + a merge step
- src/daemon/desktop-notify.ts — `findTerminalNotifier()`, `notifyDesktop()`, injectable spawn for tests
- src/daemon/desktop-notify.test.ts — tool selection, arg array + escaping, no-op off-darwin
- src/shared/config.test.ts — notifications merge + invalid-value handling
- DECISIONS.md — desktop-not-Web-Push + tool-preference rationale

Verification: `bun test` (config + desktop-notify), `bun run typecheck`.

#### Details

`notifyDesktop({ title, message, url? })` runs fire-and-forget via `execFile`
with an **arg array** (no shell), so a session title or question text can never
inject. With a `url` and `terminal-notifier` present: `terminal-notifier -title
… -message … -open <url>`. Otherwise `osascript -e 'display notification "…"
with title "…"'`. `findTerminalNotifier()` checks `$OTACON_TERMINAL_NOTIFIER`
then PATH (mirrors `findTailscale` in src/cli/install/tailscale.ts). On
`process.platform !== "darwin"` it is a no-op. The spawn fn is a constructor
arg so tests assert the chosen binary + args without firing a real banner.
Config merge follows the existing `mergeBudgets` shape: a non-boolean
`notifications.desktop` is ignored with a stderr notice.

### Phase 2 — Presence tracking + trigger wiring (go-live)

Goal: Track which sessions have a *visible* review open, then fire at the two
triggers — suppressed only while that review is visible, gated by
`notifications.desktop`. The user-facing behavior goes live in this commit.
Files:

- src/daemon/presence.ts (+ presence.test.ts) — per-session visibility tracker: `markVisible/markHidden`, `isWatched(id)` (TTL-based, survives a crashed tab)
- src/daemon/app.ts — `POST /api/sessions/:id/presence`; `maybeNotify()` in createApp, called from submit (revision) + ask (single + coalesced batch), suppressed via `presence.isWatched`
- src/ui/api.ts + src/ui/session-screen.tsx — `usePresence(id)`: report visibility on `visibilitychange` + heartbeat, `sendBeacon` hidden on unload
- src/daemon/app.test.ts — fires on ask/submit; suppressed only while visible; fires when hidden/expired; silent with config off
- DESIGN.md §6/§10/§13, README.md Roadmap — presence endpoint + visibility suppression + an M6 line
- DECISIONS.md — visibility-based (not connection-based) suppression rationale

Verification: `bun test` (app + presence: fire/suppress/expire/config-off),
`bun run build` stays node-runnable (`node dist/cli/main.js`).

#### Details

Suppression keys on visibility, not mere connection: a hidden/background tab
keeps its SSE stream open, so a connection count would wrongly silence banners
(review t1/t3). `usePresence(id)` POSTs `{visible:true}` when the review becomes
visible and on a ~20s heartbeat while visible, `{visible:false}` on
`visibilitychange→hidden`, and a `sendBeacon` false on unload. The daemon's
tracker stores `lastVisibleAt`; `isWatched(id)` is true within a ~45s TTL, so a
crashed/closed tab self-expires while an explicit hidden-ping un-suppresses
immediately. The agent's `otacon wait` hits `/events`, never presence — a parked
agent never suppresses. `maybeNotify(session, kind)` loads config fresh for
`session.repo`, returns early unless darwin + `notifications.desktop` +
`!presence.isWatched(id)`, builds `http://127.0.0.1:${otaconPort()}/s/${id}`, and
fires. Messages: single question → truncated snippet; batch of N → "N questions
need your answer"; revision → "Revision rN ready for review"; title carries the
session title. The fire is wrapped so a spawn error never breaks the submit/ask
response.

### Phase 3 — Web Push (phone) deferral

Goal: Record the deferred phone path so it is not lost — a dedicated Web Push
TODO and an out-of-scope note capturing the agreed future approach. No code.
Files:

- TODOs.md — narrow the combined "phone or desktop" line to a Web Push (phone) entry
- DESIGN.md §14 — list Web Push (phone) as deferred, with the agreed approach from q2
- DECISIONS.md — why phone is deferred + the chosen future approach (zero-dep VAPID, payload-less wake-up + SSW fetch over Tailscale)

Verification: docs read back consistent; `git grep` shows no dangling combined TODO.

## Risks

- In normal use (daemon auto-spawned from your terminal on the Mac) banners always fire; they only go silent if the daemon runs headless/SSH with no GUI session — an edge case, not the daily path.
- Presence TTL (~45s) means a crashed/closed visible tab can keep suppressing until it expires; the explicit hidden/unload ping makes the common path immediate.
- String escaping into `osascript`/`terminal-notifier` — arg arrays via execFile (no shell) close the injection vector from titles/question text.
- A fire-and-forget spawn error must never break the submit/ask response — swallow and log to stderr only.

## Open Questions

None.

## Interview

### q1 — How should attention notifications reach each surface? The daemon already runs on the Mac (so it can fire native macOS notifications directly), and the phone reaches it over Tailscale HTTPS. 'Requires attention' = agent posted a grill question, or submitted a revision awaiting your review.

- Options: Split: native macOS notification for desktop + Web Push (PWA) for phone (recommended) | Unified Web Push (PWA service worker) for both desktop browser and phone | Foreground-only: browser Notification API over the existing SSE (only fires while a tab is open) | Third-party app (ntfy/Pushover) for phone + native macOS for desktop
- Answer: Split: native macOS notification for desktop + Web Push (PWA) for phone

### q2 — Web Push needs the daemon to sign push requests (VAPID) and optionally encrypt a payload. Web Push payloads are end-to-end encrypted regardless, so the push service (Apple/Google) never sees plan content either way. The real tradeoff is dependencies vs. notification self-sufficiency. How should the daemon implement Web Push? (Phone reaches the daemon over Tailscale anyway.)

- Options: Zero-dep: hand-rolled VAPID (node:crypto) + payload-less wake-up; service worker fetches the session detail over Tailscale to build the notification (recommended) | Add the 'web-push' library: send self-contained encrypted payloads (title/type/url in the notification, no fetch needed) | Zero-dep but full: hand-roll VAPID AND RFC-8291 payload encryption in node:crypto — self-contained, no dep, no fetch (~200 lines of crypto)
- Answer: make web push a separate TODOs in the TODOs.md. focus on desktop notification for now

### q3 — Which moments should fire a desktop notification? These are the points where the ball is in your court and the agent has parked in 'otacon wait'. (A batch of grill questions asked in one call would coalesce into a single notification either way.)

- Options (multi): Agent posts a grill question + agent submits a revision (awaiting review) (recommended) | Those two + agent answers an instant question you asked | All of those + a low-key 'session approved' confirmation when planning ends
- Answer: Agent posts a grill question + agent submits a revision (awaiting review)

### q4 — macOS notification mechanism + click behavior. Built-in 'osascript' fires a notification with zero dependencies, but its banners aren't clickable to open a URL. 'terminal-notifier' (a small brew install) supports click-to-open — tapping the banner would open the review URL in your browser.

- Options: Prefer terminal-notifier when installed (click opens the review URL), fall back to osascript otherwise — no hard dependency (recommended) | osascript only — zero dependency, banner informs but isn't clickable | Require terminal-notifier — always clickable, but it must be installed
- Answer: Prefer terminal-notifier when installed (click opens the review URL), fall back to osascript otherwise — no hard dependency

### q5 — Should a desktop notification be suppressed when you already have that session's review open in a browser (a live SSE stream connected)? The point of the notification is to reach you when you're NOT watching the UI — if the review tab is live, it already updates in place.

- Options: Suppress when a live review stream is connected for that session — the daemon already knows the stream count (recommended) | Always notify regardless of whether a tab is open — simplest, but doubles up with an open review | Suppress only when the review tab is actually focused/visible (the UI reports visibility to the daemon) — most precise, needs a small presence ping
- Answer: Suppress when a live review stream is connected for that session — the daemon already knows the stream count

### q6 — Enablement & config. DESIGN.md keeps config in a file (no settings UI in v1). How should desktop notifications be enabled/disabled?

- Options: On by default; toggle with a 'notifications.desktop' boolean in ~/.otacon/config.json (repo override allowed), matching the existing budgets config (recommended) | Off by default; opt-in via the same config flag | On by default, no config knob at all (always on for the owner's Mac)
- Answer: On by default; toggle with a 'notifications.desktop' boolean in ~/.otacon/config.json (repo override allowed), matching the existing budgets config
