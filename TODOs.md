# TODOs

- [ ] P1: mobile UX: comment window on mobile view is below the fold. When highlighting text, the custom popover overlaps with native browser popover. Zoom should be disabled.
- [ ] P2: Provide a quick "comment and approve" flow to leave last comment and trust agents to handle it well. Otherwise, we have to leave some nit comment, wait for agent to respond, then approve. This is similar to senior engineer leave a comment with LGTM on a PR.
- [ ] P2: Web Push (phone) notifications when a plan requires attention — desktop is done (M6, native macOS banner). Phone path: zero-dep hand-rolled VAPID (node:crypto) + a payload-less wake-up push; the service worker fetches the session detail over Tailscale to build the notification (DESIGN.md §14).
- [ ] P1: Resume a pending session - when the session is interrupted, the user must be able to resume the session. It can be done by user trigger `/otacon resume` and the agent will provide a list of pending sessions to resume. On select one, the agent will continue to work on the plan
- [ ] P1: Make handoff seamless after the plan is ready for implementation
- [ ] P3: Make multi-select card in grill mode more obvious

## Post MVP

- [ ] P2: Support future update after installation
- [ ] P1: Record launch video
