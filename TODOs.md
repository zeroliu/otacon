# TODOs

- [ ] P1: Spawn new claude code session and run otacon from the web UI. Right now, it's a pain point that I can only spawn new session from my laptop where the session is running and the mobile can only be used for reviewing.
- [ ] P2: Web Push (phone) notifications when a plan requires attention — desktop is done (M6, native macOS banner). Phone path: zero-dep hand-rolled VAPID (node:crypto) + a payload-less wake-up push; the service worker fetches the session detail over Tailscale to build the notification (DESIGN.md §14).
- [ ] P1: Resume a pending session - when the session is interrupted, the user must be able to resume the session. It can be done by user trigger `/otacon resume` and the agent will provide a list of pending sessions to resume. On select one, the agent will continue to work on the plan
- [ ] P3: Make multi-select card in grill mode more obvious

## Post MVP

- [ ] P2: Support future update after installation
- [ ] P1: Record launch video
