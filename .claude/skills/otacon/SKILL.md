---
name: otacon
description: Plan a feature for THIS repo through an otacon review session — grill interview, schema'd plan, browser/phone review with anchored comments, approved plan saved to a home archive (and your project on Save). Use when the user asks to plan something with otacon, types /otacon, or wants a reviewed implementation plan before coding. Replaces native plan mode. Dogfoods otacon on its own development.
---

<!-- Generated from src/cli/install/assets.ts (dogfoodSkillMd) — do NOT hand-edit;
     assets.test.ts guards that this file equals that output. Regenerate after any
     protocol change. -->

# Otacon plan session protocol (dogfooding this repo)

This repo **is** otacon. You plan features for it by running otacon's own CLI from
source via the `./bin/otacon` shim, so every command below exercises the code in
this checkout. That shim runs the CLI from `src/` via bun — no build needed; it
always reflects current source. The daemon auto-spawns from source on the first
command. Working state lives in `.otacon/` (otacon manages no .gitignore — track
or ignore it as you like); the approved plan is archived in the home store
(`~/.otacon/sessions/<id>/`) and, on Save, copied into the repo under `plans.dir`
(default `.otacon/plans`). otacon never git-commits the plan — you commit it
yourself if you want.

After editing **daemon** source (`src/daemon/**`) mid-session, restart the running
daemon so your change loads: `./bin/otacon restart` (the next command respawns it
from current source). Use `./bin/otacon restart`, not a raw curl to a fixed port —
in a git worktree the shim runs the daemon on a derived port, and `restart` always
targets the one this checkout talks to. CLI/linter/parser edits need no restart.

The spec these commands implement is otacon's own DESIGN.md (§6 loop, §8 grill, §13
failure habits); the canonical wrapper text lives in `src/cli/install/assets.ts`.

---

Run plan reviews through the otacon CLI instead of your native plan mode. The
user reviews in a browser. Every `./bin/otacon`
command prints exactly one JSON line on stdout. Exit 0 = proceed; exit 1 = a
machine-readable error you can fix (read the JSON); exit 2 = you invoked it wrong.

## The loop

1. `./bin/otacon start --title <kebab-title>` **first, before you research** — it mints
   the session and prints the review URL. Tell the user to open it (`./bin/otacon open`
   launches it in their browser) so they can watch the whole thing from the first second.
   `--quick` skips the interview — only when the user explicitly asks.
2. **Research the codebase**, narrating as you go with
   `./bin/otacon progress "<what you're doing>"` — call it whenever you start a chunk of
   work the user can't otherwise see (reading a module, drafting, revising). It is
   a non-blocking one-liner that feeds the live activity log and the draft chip; no
   answer comes back, so never park on it. Read enough to propose answers, not
   collect questions.
3. **Grill** (mandatory unless --quick): Interview me relentlessly about every
   aspect of this plan until we reach a shared understanding. Walk down each branch
   of the design tree, resolving dependencies between decisions one-by-one. For
   each question, provide your recommended answer. Explore the code before asking.
   Never ask what the code can answer.
   - `./bin/otacon ask --question "..." --options "A|B|C" --recommend A` — always lead
     with your recommended answer. `--multi` for multi-select; omit `--options`
     for free text. The user can always answer with free-form custom text instead
     of (or alongside) the chips, so frame options as a starting point, not a cage.
   - Independent questions whose answers don't shape each other? Post them in one
     call: `./bin/otacon ask --batch questions.json` (or `--batch -` for stdin) — a JSON
     array of the same specs (`{question, options?, recommend?, multi?}`). They land
     as ordinary cards; loop `wait` to collect each answer. Dependent questions
     still go one at a time.
   - Park for the answer: `./bin/otacon wait --timeout 540` (set the Bash tool timeout
     to 600000 ms). The answer arrives as `{"event":"answer","question":"q<n>",...}`.
4. **Draft** the plan at `.otacon/<session>/plan.md` in the schema below, then
   `./bin/otacon submit`. On exit 1, fix every reported lint issue and resubmit until
   accepted.
5. **Review loop** — park in `./bin/otacon wait --timeout 540` (Bash timeout 600000 ms)
   and handle the one event it prints:
   - `comments` → revise plan.md; write `resolutions.json` as
     `{"changelog":"what changed","threads":{"t1":"how you resolved it"}}` with
     one reply per comment thread; `./bin/otacon submit --resolutions resolutions.json`
     (loop on lint errors); park again. A `comments` batch with `"final":true` is
     the reviewer's **comment & approve**: resolve every thread the usual way, but
     your next clean submit **finalizes** — you'll get `approved` (which may carry
     `implement:true`), not another review round. So fold them all in, submit, then
     park and handle the `approved` that follows (do NOT expect more comments).
   - `question` → `./bin/otacon answer <q-id> --body "..."` (or `--file`); park again. A
     `question` may carry `replyTo` (a follow-up on an earlier question) — skim that
     thread's prior turns for context, but still answer the new `q<n>`.
   - `answer` → use it and continue; park again whenever you are waiting.
   - `timeout` → park again immediately. A timeout is NEVER completion.
   - `approved` → the plan is saved at `path` (its canonical archive is at
     `home`). otacon does NOT manage git for plans — never `git add`/commit it
     here. Plain `approved` (Save, no `implement`) → print a one-line summary
     naming where it was saved (`path`), then STOP; commit it yourself if you
     want. `approved` **with `implement:true`** → read the plan at `path` (the
     home copy) to guide the build and enter the **Implement loop** (below) — do
     NOT stop, do NOT commit the plan; the session is now `implementing`.
   - `deleted` → the user deleted this session in the review UI. It is over:
     STOP. There is no approved plan.
6. **Never end your turn while the session is open.** Nothing to do = park in
   `./bin/otacon wait` again. Confused, crashed, or compacted? `./bin/otacon status` returns
   the open session, revision, and pending events — resume the loop from it.

## CLI quick reference

- `./bin/otacon start --title <t> [--quick]` · `./bin/otacon progress "<note>"` ·
  `./bin/otacon ask ...` · `./bin/otacon wait --timeout 540` · `./bin/otacon submit [--resolutions f]` ·
  `./bin/otacon answer <q> --body "..."` · `./bin/otacon implement-done [--pr <url>] [--failed]` ·
  `./bin/otacon status` · `./bin/otacon open` · `./bin/otacon config [get <key>]`

## Implement loop (on `approved` with `implement:true`)

You are the **orchestrator**: you only coordinate and narrate
(`./bin/otacon progress` at each checkpoint) — every phase's real work runs in a fresh
native subagent (Task tool) so your own context stays lean.

1. **Setup.** Do NOT commit the plan — otacon doesn't manage git for plans, and on
   Implement the plan lives only in the home archive at the event `path` (read the
   phases from there). Branch off the repo's current default branch HEAD: create the
   worktree under the configured `worktree.dir`
   (`./bin/otacon config get worktree.dir` — default `~/.otacon/worktrees`, outside the repo):
   `git worktree add <worktree.dir>/<slug> -b otacon/impl-<slug>` (off the default
   branch). `./bin/otacon progress` each checkpoint throughout.
2. **Per phase, in order** (read the phases from the home plan at the event `path`):
   - `./bin/otacon progress "phase N — implementing"`; spawn an **implement+test**
     subagent (Task tool) scoped to that phase's Goal/Files/Verification — it
     implements and runs the phase Verification plus the repo gates.
   - spawn a **separate** `/code-review --fix` subagent on the phase's working
     diff; it applies findings; re-review. (`/code-review` effort is config — start
     moderate so false positives don't become needless pauses.)
   - **clean + green** → commit the phase and continue. **Blocked** (tests stay red,
     review still flags, or a subagent is stuck) → on the FIRST blocker,
     `./bin/otacon ask` with options `retry|skip|abort|guidance`, park in `./bin/otacon wait`,
     and act on the answer. No auto-retry.
3. **Finish.** On success, open a PR against the default branch with `gh pr create`
   (PR body = the plan summary + the per-phase log; fall back to the local branch +
   path when there is no remote), then `./bin/otacon implement-done --pr <url>`. There is
   no plan file to commit or archive — the plan lives in the home archive at the
   event `path`; otacon never puts it in the repo on Implement. On abort, run
   `./bin/otacon implement-done --failed`.

While `implementing` the Stop hook still keeps you on the line — never end the turn
until `implement-done`.

## Plan schema (linted on submit)

Frontmatter (`title`, `session`, `revision`, `status`, `created`), then these
H2 sections in order — the five required ones plus optional review-altitude
sections slotted in place (include them when the change warrants; skip them on
trivial plans): `## Summary` (≤5 lines, lead with a diagram — see below) ·
*(optional)* `## Contract` (≤12 lines —
the interface surface the reviewer signs off instead of reading code: inputs,
outputs, types, errors; one signature fence is fine under the 1-fence rule) ·
`## Decisions` (entries ≤3 lines, `- D<n>: ... ← q<n>` citing the grill answer
that produced it, or `[assumed]`) · *(optional)* `## Impact` (≤10 lines — blast
radius: the upstream modules this plan leans on and the downstream modules it can
break; a dependency mermaid is fine under the 1-fence rule) · `## Phases`
(`### Phase <n> — <name>`, each with `Goal:` ≤3 lines, `Files:` list,
`Verification:` ≤3 lines plus an optional ```gwt scenario block — see below,
optional collapsible `#### Details` block) ·
`## Risks` (≤5 items, ≤2 lines each) ·
`## Open Questions`. Mermaid / code / `before`+`after` fences are budget-exempt,
max one per read-path section; the markdown-native review visuals below share a
separate per-section cap. Details may elaborate on the read path, never
introduce new scope.

**Lead with a diagram.** Put a ```mermaid state / sequence / flow diagram right
under the `## Summary` headline — strongly recommended on ~90% of plans, so the
reviewer grasps the change's shape before reading prose. Keep the headline as the ≤5-line
Summary.

## Visuals — prefer them over prose where they carry the information

Four markdown-native primitives the review UI styles. They degrade to readable
markdown if rendering fails, and a comment can anchor to one specific risk, row,
or callout.

- **Callouts** — a blockquote whose first line is a type marker
  (`[!risk]`, `[!note]`, `[!decision]`, `[!assumption]`). Risks and
  assumptions SHOULD be callouts, not bullets buried in prose:
  > [!risk]
  > The JWT cutover locks out sessions issued before it.
- **Decision matrix** — a GFM table comparing options, the chosen row led by a
  `✓`. A Decisions section weighing 2+ options SHOULD use a matrix:
  | Pick | Option | Tradeoff                        |
  | ---- | ------ | ------------------------------- |
  | ✓    | RS256  | rotate keys without redeploy    |
  |      | HS256  | shared secret on every verifier |
- **Scope pills** — inline tags `[new]` `[breaking]` `[risky]` `[deletes]`
  for flagging scope mid-sentence ("adds a [new] issuer; [breaking] cookie removal").
- **Behavioral assertions** — a ```gwt fence inside a phase's `Verification`
  holding one or more Given/When/Then scenarios (blank line between scenarios;
  `And`/`But` continue a clause). They render as scenario cards that double as
  the human's approve checklist (Test-Driven Review), so write the observable
  behavior the reviewer signs off, not the test code:
  ```gwt
  Given a plan with no Contract section
  When the agent submits it
  Then the lint passes and review opens
  ```
  Capped at 6 scenarios per block; must sit under `Verification`.

Callouts and matrices are budget-exempt but capped (default 2 per read-path
section); pills are free. Reach for a visual when it carries the point better
than a sentence — never as decoration.

## Rules

- Never use native plan mode, AskUserQuestion, or any built-in question UI while
  the session is open — every question goes through `./bin/otacon ask`.
- Long review or build ahead? Remind the user to keep the Mac awake: `caffeinate -i`
  while the session runs.
