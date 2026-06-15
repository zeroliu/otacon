---
name: otacon
description: Plan a feature for THIS repo through an otacon review session — grill interview, schema'd plan, browser/phone review with anchored comments, approved committed artifact. Use when the user asks to plan something with otacon, types /otacon, or wants a reviewed implementation plan before coding. Replaces native plan mode. Dogfoods otacon on its own development.
---

<!-- Generated from src/cli/install/assets.ts (dogfoodSkillMd) — do NOT hand-edit;
     assets.test.ts guards that this file equals that output. Regenerate after any
     protocol change. -->

# Otacon plan session protocol (dogfooding this repo)

This repo **is** otacon. You plan features for it by running otacon's own CLI from
source via the `./bin/otacon` shim, so every command below exercises the code in
this checkout. That shim runs the CLI from `src/` via bun — no build needed; it
always reflects current source. The daemon auto-spawns from source on the first
command. Working state lives in the gitignored `.otacon/`; the approved plan is
committed to `docs/plans/`.

After editing **daemon** source (`src/daemon/**`) mid-session, restart the running
daemon so your change loads: `./bin/otacon restart` (the next command respawns it
from current source). Use `./bin/otacon restart`, not a raw curl to a fixed port —
in a git worktree the shim runs the daemon on a derived port, and `restart` always
targets the one this checkout talks to. CLI/linter/parser edits need no restart.

The spec these commands implement is otacon's own DESIGN.md (§6 loop, §8 grill, §13
failure habits); the canonical wrapper text lives in `src/cli/install/assets.ts`.

---

Run plan reviews through the otacon CLI instead of your native plan mode. The
user reviews in a browser — often a phone over Tailscale. Every `./bin/otacon`
command prints exactly one JSON line on stdout. Exit 0 = proceed; exit 1 = a
machine-readable error you can fix (read the JSON); exit 2 = you invoked it wrong.

## The loop

1. `./bin/otacon start --title <kebab-title>` **first, before you research** — it mints
   the session and prints the review URL. Tell the user to open it (`./bin/otacon open`
   prints it again) so they can watch the whole thing from the first second.
   `--quick` skips the interview — only when the user explicitly asks.
2. **Research the codebase**, narrating as you go with
   `./bin/otacon progress "<what you're doing>"` — call it whenever you start a chunk of
   work the user can't otherwise see (reading a module, drafting, revising). It is
   a non-blocking one-liner that feeds the live activity log and the draft chip; no
   answer comes back, so never park on it. Read enough to propose answers, not
   collect questions.
3. **Grill** (mandatory unless --quick): walk the design tree ONE question at a
   time, dependencies first. Explore the code before asking — never ask what the
   code can answer.
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
     (loop on lint errors); park again.
   - `question` → `./bin/otacon answer <q-id> --body "..."` (or `--file`); park again. A
     `question` may carry `replyTo` (a follow-up on an earlier question) — skim that
     thread's prior turns for context, but still answer the new `q<n>`.
   - `answer` → use it and continue; park again whenever you are waiting.
   - `timeout` → park again immediately. A timeout is NEVER completion.
   - `approved` → `git add` + commit the plan file at the printed `path`. Plain
     `approved` (no `implement`) → print a one-line summary and STOP. `approved`
     **with `implement:true`** → after committing, enter the **Implement loop**
     (below) — do NOT stop; the session is now `implementing`.
   - `deleted` → the user deleted this session in the review UI. It is over:
     STOP. There is no approved plan and nothing to commit.
6. **Never end your turn while the session is open.** Nothing to do = park in
   `./bin/otacon wait` again. Confused, crashed, or compacted? `./bin/otacon status` returns
   the open session, revision, and pending events — resume the loop from it.

## CLI quick reference

- `./bin/otacon start --title <t> [--quick]` · `./bin/otacon progress "<note>"` ·
  `./bin/otacon ask ...` · `./bin/otacon wait --timeout 540` · `./bin/otacon submit [--resolutions f]` ·
  `./bin/otacon answer <q> --body "..."` · `./bin/otacon implement-done [--pr <url>] [--failed]` ·
  `./bin/otacon status` · `./bin/otacon open`

## Implement loop (on `approved` with `implement:true`)

You are the **orchestrator**: you only coordinate and narrate
(`./bin/otacon progress` at each checkpoint) — every phase's real work runs in a fresh
native subagent (Task tool, subscription-covered) so your own context stays lean.

1. **Setup.** Commit the plan file at the event `path` (exactly as plain Approve),
   then `git worktree add .otacon/worktrees/<slug> -b otacon/impl-<slug>` off that
   commit (`.otacon/` is gitignored). `./bin/otacon progress` each checkpoint throughout.
2. **Per phase, in order** (read the phases from the committed plan):
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
3. **Finish.** `gh pr create` against the default branch (PR body = the plan
   summary + the per-phase log; fall back to the local branch + path when there is
   no remote), then `./bin/otacon implement-done --pr <url>` (or
   `./bin/otacon implement-done --failed` on abort).

While `implementing` the Stop hook still keeps you on the line — never end the turn
until `implement-done`. Remind the user to keep the Mac awake (`caffeinate -i`) for
a long build.

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
reviewer grasps the change's shape before reading prose. It is budget-exempt and uses
Summary's one fence, so the ≤5-line headline stays intact; the review screen pins
Summary and its lead diagram as the first screen. Keep the headline as the ≤5-line
Summary — no forced one-liner. When a chart genuinely wouldn't help (a pure docs or
config change), opt out explicitly with `<!-- no-lead-diagram: <why> -->` inside
Summary; otherwise a missing lead diagram is a non-blocking lint nudge, never a reject.

## Visuals — prefer them over prose where they carry the information

Three markdown-native primitives the review UI styles. They degrade to readable
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
  Budget-exempt like a visual (does not spend the phase's one-fence allowance),
  capped at 6 scenarios per block; must sit under `Verification`.

Callouts and matrices are budget-exempt but capped (default 2 per read-path
section); pills are free. Reach for a visual when it carries the point better
than a sentence — never as decoration.

## Rules

- Keep the user in the loop: `./bin/otacon progress` at every checkpoint they can't see
  (research phase boundaries, drafting, each revision) so the activity log and the
  draft chip show work happening — silence past a while reads as "agent gone".
- Never use native plan mode, AskUserQuestion, or any built-in question UI while
  the session is open — every question goes through `./bin/otacon ask`.
- Dependencies first, one question at a time; only batch independent siblings.
  Recommended option first; the phone is the review surface.
- Long review ahead? Remind the user to keep the Mac awake: `caffeinate -i`
  while the session runs.
