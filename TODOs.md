# TODOs

- [ ] The highlighted questions or comments are not preserved after the questions or comments are sent. So I can't tell which ones are being asked. We should preserve the highlight effect.
- [ ] While HTML has more interesting styling, it's still a wall of texts. We need to prompt the agent to use more diverse and expressive visual.
- [ ] The ability to fold the thread
- [ ] The ability to follow up on a thread
- [ ] When the agent is doing work such as refining plan, I need to see some updates in the web UI. It's also hard to tell from the agent CLI view that it's waiting for my answer. When the skill is triggered, it should create a web UI session immediately, and then the user can finish the rest of the plan all in the web UI, while have full visibility when the agent is doing work.
- [ ] Get notification on the phone, or on the desktop when the plan requires user attention
- [ ] Delete a pending session
- [ ] Resume a pending session - when the session is interrupted, the user must be able to resume the session. It can be done by user trigger `/otacon resume` and the agent will provide a list of pending sessions to resume. On select one, the agent will continue to work on the plan
- [ ] Stacking everything on mobile view makes it difficult to review on mobile devices. We need to redesign the UI for mobile to improve readability
- [ ] Make handoff seamless after the plan is ready for implementation
