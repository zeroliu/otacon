# TODOs

- [ ] P2: The highlighted questions or comments are not preserved after the questions or comments are sent. So I can't tell which ones are being asked. We should preserve the highlight effect.
- [ ] P0: While HTML has more interesting styling, it's still a wall of texts. We need to prompt the agent to use more diverse and expressive visual.
- [ ] P3: The ability to fold the thread
- [ ] P3: The ability to follow up on a thread
- [ ] P1: When the agent is doing work such as refining plan, I need to see some updates in the web UI. It's also hard to tell from the agent CLI view that it's waiting for my answer. When the skill is triggered, it should create a web UI session immediately, and then the user can finish the rest of the plan all in the web UI, while have full visibility when the agent is doing work.
- [ ] P1: Web Push (phone) notifications when a plan requires attention — desktop is done (M6, native macOS banner). Phone path: zero-dep hand-rolled VAPID (node:crypto) + a payload-less wake-up push; the service worker fetches the session detail over Tailscale to build the notification (DESIGN.md §14).
- [ ] P2: Delete a pending session
- [ ] P1: Resume a pending session - when the session is interrupted, the user must be able to resume the session. It can be done by user trigger `/otacon resume` and the agent will provide a list of pending sessions to resume. On select one, the agent will continue to work on the plan
- [ ] P1: Stacking everything on mobile view makes it difficult to review on mobile devices. We need to redesign the UI for mobile to improve readability
- [ ] P1: Make handoff seamless after the plan is ready for implementation
- [ ] P3: Make multi-select card in grill mode more obvious
- [ ] P3: When scrolling to the bottom, the name of the plan, and controls such as approve, switch to another session should stick to the top as a header
- [ ] P0: Test mobile debug working
- [ ] P2: Support future update after installation
- [ ] P1: Record launch video
