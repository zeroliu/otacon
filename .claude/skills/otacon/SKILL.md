---
name: otacon
description: Plan a feature for THIS repo through an otacon review session — grill interview, schema'd plan, browser/phone review with anchored comments, approved committed artifact. Use when the user asks to plan something with otacon, types /otacon, or wants a reviewed implementation plan before coding. Replaces native plan mode. Dogfoods otacon on its own development.
---

# Otacon plan session protocol (dogfooding this repo)

This repo **is** otacon. You plan features for it by running otacon's own CLI from
source, so every command exercises the code in this checkout.

**In every command below, `otacon` means `./bin/otacon`, run from the repo root.**
That shim runs the CLI from `src/` via bun — no build needed; it always reflects
current source. The daemon auto-spawns from source on the first command. Working
state lives in the gitignored `.otacon/`; the approved plan is committed to
`docs/plans/`.

After editing **daemon** source (`src/daemon/**`) mid-session, restart the running
daemon so your change loads: `otacon restart` (the next `otacon` command respawns it
from current source). Use `otacon restart`, not a raw curl to a fixed port — in a git
worktree the shim runs the daemon on a derived port, and `restart` always targets the
one this checkout talks to. CLI/linter/parser edits need no restart.

The spec these commands implement is otacon's own DESIGN.md (§6 loop, §8 grill, §13
failure habits); the canonical wrapper text lives in `src/cli/install/assets.ts`.
Keep this file in sync with it when the protocol changes.

---

Run plan reviews through the otacon CLI instead of your native plan mode. The
user reviews in a browser — often a phone over Tailscale. Every `otacon`
command prints exactly one JSON line on stdout. Exit 0 = proceed; exit 1 = a
machine-readable error you can fix (read the JSON); exit 2 = you invoked it wrong.

## The loop

1. **Research the codebase first.** Read enough to propose answers, not collect
   questions.
2. `otacon start --title <kebab-title>` — mints the session, prints the review
   URL. Tell the user to open it (`otacon open` prints it again). `--quick`
   skips the interview — only when the user explicitly asks.
3. **Grill** (mandatory unless --quick): walk the design tree ONE question at a
   time, dependencies first. Explore the code before asking — never ask what the
   code can answer.
   - `otacon ask --question "..." --options "A|B|C" --recommend A` — always lead
     with your recommended answer. `--multi` for multi-select; omit `--options`
     for free text. The user can always answer with free-form custom text instead
     of (or alongside) the chips, so frame options as a starting point, not a cage.
   - Independent questions whose answers don't shape each other? Post them in one
     call: `otacon ask --batch questions.json` (or `--batch -` for stdin) — a JSON
     array of the same specs (`{question, options?, recommend?, multi?}`). They land
     as ordinary cards; loop `wait` to collect each answer. Dependent questions
     still go one at a time.
   - Park for the answer: `otacon wait --timeout 540` (set the Bash tool timeout
     to 600000 ms). The answer arrives as `{"event":"answer","question":"q<n>",...}`.
4. **Draft** the plan at `.otacon/<session>/plan.md` in the schema below, then
   `otacon submit`. On exit 1, fix every reported lint issue and resubmit until
   accepted.
5. **Review loop** — park in `otacon wait --timeout 540` (Bash timeout 600000 ms)
   and handle the one event it prints:
   - `comments` → revise plan.md; write `resolutions.json` as
     `{"changelog":"what changed","threads":{"t1":"how you resolved it"}}` with
     one reply per comment thread; `otacon submit --resolutions resolutions.json`
     (loop on lint errors); park again.
   - `question` → `otacon answer <q-id> --body "..."` (or `--file`); park again.
   - `answer` → use it and continue; park again whenever you are waiting.
   - `timeout` → park again immediately. A timeout is NEVER completion.
   - `approved` → `git add` + commit the plan file at the printed `path`, print a
     one-line summary, and STOP. Planning only — implementation is another
     session's job.
6. **Never end your turn while the session is open.** Nothing to do = park in
   `otacon wait` again. Confused, crashed, or compacted? `otacon status` returns
   the open session, revision, and pending events — resume the loop from it.

## Plan schema (linted on submit)

Frontmatter (`title`, `session`, `revision`, `status`, `created`), then exactly
these H2 sections in order: `## Summary` (≤5 lines) · `## Decisions` (entries
≤3 lines, `- D<n>: ... ← q<n>` citing the grill answer that produced it, or
`[assumed]`) · `## Phases` (`### Phase <n> — <name>`, each with `Goal:` ≤3
lines, `Files:` list, `Verification:` ≤3 lines, optional collapsible
`#### Details` block) · `## Risks` (≤5 items, ≤2 lines each) ·
`## Open Questions`. Mermaid / code / `before`+`after` fences are budget-exempt,
max one per read-path section. Details may elaborate on the read path, never
introduce new scope.

## Rules

- Never use native plan mode, AskUserQuestion, or any built-in question UI while
  the session is open — every question goes through `otacon ask`.
- Dependencies first, one question at a time; only batch independent siblings.
  Recommended option first; the phone is the review surface.
- Long review ahead? Remind the user to keep the Mac awake: `caffeinate -i`
  while the session runs.
