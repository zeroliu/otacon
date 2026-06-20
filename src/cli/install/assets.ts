// The wrapper content `otacon install` writes — this is the product-critical
// text that teaches an agent the whole protocol: the full review loop, grill
// discipline, and "never end your turn" rule. One protocol card,
// three destinations — Claude Code, Codex, and OpenCode each get it as a
// SKILL.md in their own skills dir. Plus the Stop hook shell script.
// Wrappers are managed files: reinstall overwrites them wholesale (DECISIONS.md
// "Wrappers are managed files").

/** Present in every wrapper this tool owns; doctor greps for it. */
export const MANAGED_MARKER = 'managed by `otacon install`';

/**
 * The protocol card — start-first full loop + grill discipline + failure habits
 * — parametrized by the command prefix so one source feeds both
 * wrappers (D7): `otacon` for what `otacon install` writes into any repo,
 * `./bin/otacon` for this repo's dogfood (run-from-source). The only thing that
 * varies between the two is `cmd`; the protocol text is identical, so a change
 * here lands in both at once.
 */
function protocolCard(cmd: string): string {
  return `Run plan reviews through the otacon CLI instead of your native plan mode. The
user reviews in a browser. Every \`${cmd}\`
command prints exactly one JSON line on stdout. Exit 0 = proceed; exit 1 = a
machine-readable error you can fix (read the JSON); exit 2 = you invoked it wrong.

## The loop

1. \`${cmd} start --title <kebab-title>\` **first, before you research** — it mints
   the session and prints the review URL. Tell the user to open it (\`${cmd} open\`
   launches it in their browser) so they can watch the whole thing from the first second.
   \`--quick\` skips the interview — only when the user explicitly asks.
2. **Research the codebase**, narrating as you go with
   \`${cmd} progress "<what you're doing>"\` — call it whenever you start a chunk of
   work the user can't otherwise see (reading a module, drafting, revising). It is
   a non-blocking one-liner that feeds the live activity log and the draft chip; no
   answer comes back, so never park on it. Read enough to propose answers, not
   collect questions.
3. **Grill** (mandatory unless --quick): Interview me relentlessly about every
   aspect of this plan until we reach a shared understanding. Walk down each branch
   of the design tree, resolving dependencies between decisions one-by-one. For
   each question, provide your recommended answer. Explore the code before asking.
   Never ask what the code can answer.
   - \`${cmd} ask --question "..." --options "A|B|C" --recommend A\` — always lead
     with your recommended answer. \`--multi\` for multi-select; omit \`--options\`
     for free text. The user can always answer with free-form custom text instead
     of (or alongside) the chips, so frame options as a starting point, not a cage.
   - Independent questions whose answers don't shape each other? Post them in one
     call: \`${cmd} ask --batch questions.json\` (or \`--batch -\` for stdin) — a JSON
     array of the same specs (\`{question, options?, recommend?, multi?}\`). They land
     as ordinary cards; loop \`wait\` to collect each answer. Dependent questions
     still go one at a time.
   - Park for the answer: \`${cmd} wait --timeout 540\` (set the Bash tool timeout
     to 600000 ms). The answer arrives as \`{"event":"answer","question":"q<n>",...}\`.
4. **Draft** the plan at \`.otacon/<session>/plan.md\` in the schema below, then
   \`${cmd} submit\`. On exit 1, fix every reported lint issue and resubmit until
   accepted.
5. **Review loop** — park in \`${cmd} wait --timeout 540\` (Bash timeout 600000 ms)
   and handle the one event it prints:
   - \`comments\` → revise plan.md; write \`resolutions.json\` as
     \`{"changelog":"what changed","threads":{"t1":"how you resolved it"}}\` with
     one reply per comment thread; \`${cmd} submit --resolutions resolutions.json\`
     (loop on lint errors); park again. A \`comments\` batch with \`"final":true\` is
     the reviewer's **comment & approve**: resolve every thread the usual way, but
     your next clean submit **finalizes** — you'll get \`approved\` (which may carry
     \`implement:true\`), not another review round. So fold them all in, submit, then
     park and handle the \`approved\` that follows (do NOT expect more comments).
   - \`question\` → \`${cmd} answer <q-id> --body "..."\` (or \`--file\`); park again. A
     \`question\` may carry \`replyTo\` (a follow-up on an earlier question) — skim that
     thread's prior turns for context, but still answer the new \`q<n>\`.
   - \`answer\` → use it and continue; park again whenever you are waiting.
   - \`timeout\` → park again immediately. A timeout is NEVER completion.
   - \`approved\` → the plan is saved at \`path\`. Plain \`approved\` (Save, no
     \`implement\`) → print a one-line summary naming where it was saved (\`path\`),
     then STOP. \`approved\` **with \`implement:true\`** → read the plan at \`path\` to
     guide the build and enter the **Implement loop** (below) — do NOT stop; the
     session is now \`implementing\`.
   - \`deleted\` → the user deleted this session in the review UI. It is over:
     STOP. There is no approved plan.
6. **Never end your turn while the session is open.** Nothing to do = park in
   \`${cmd} wait\` again. Confused, crashed, or compacted? \`${cmd} status\` returns
   the open session, revision, and pending events — resume the loop from it.

## CLI quick reference

- \`${cmd} start --title <t> [--quick]\` · \`${cmd} progress "<note>"\` ·
  \`${cmd} ask ...\` · \`${cmd} wait --timeout 540\` · \`${cmd} submit [--resolutions f]\` ·
  \`${cmd} answer <q> --body "..."\` · \`${cmd} implement-done [--pr <url>] [--failed]\` ·
  \`${cmd} status\` · \`${cmd} open\` · \`${cmd} config [get <key>]\`

## Implement loop (on \`approved\` with \`implement:true\`)

You are the **orchestrator**: you only coordinate and narrate
(\`${cmd} progress\` at each checkpoint) — every phase's real work runs in a fresh
native subagent (Task tool) so your own context stays lean.

1. **Setup.** On Implement the plan lives only in the home archive at the event
   \`path\` (read the phases from there). Branch off the repo's current default branch
   HEAD: create the
   worktree under the configured \`worktree.dir\`
   (\`${cmd} config get worktree.dir\` — default \`~/.otacon/worktrees\`, outside the repo):
   \`git worktree add <worktree.dir>/<slug> -b otacon/impl-<slug>\` (off the default
   branch). \`${cmd} progress\` each checkpoint throughout.
2. **Per phase, in order** (read the phases from the home plan at the event \`path\`):
   - \`${cmd} progress "phase N — implementing"\`; spawn an **implement+test**
     subagent (Task tool) scoped to that phase's Goal/Files/Verification — it
     implements and runs the phase Verification plus the repo gates.
   - spawn a **separate** \`/code-review --fix\` subagent on the phase's working
     diff; it applies findings; re-review. (\`/code-review\` effort is config — start
     moderate so false positives don't become needless pauses.)
   - **clean + green** → commit the phase and continue. **Blocked** (tests stay red,
     review still flags, or a subagent is stuck) → on the FIRST blocker,
     \`${cmd} ask\` with options \`retry|skip|abort|guidance\`, park in \`${cmd} wait\`,
     and act on the answer. No auto-retry.
3. **Finish.** On success, open a PR against the default branch with \`gh pr create\`
   (PR body = the plan summary + the per-phase log; fall back to the local branch +
   path when there is no remote), then \`${cmd} implement-done --pr <url>\`. On abort,
   run \`${cmd} implement-done --failed\`.

While \`implementing\` the Stop hook still keeps you on the line — never end the turn
until \`implement-done\`.

## Plan schema (linted on submit)

Frontmatter (\`title\`, \`session\`, \`revision\`, \`status\`, \`created\`), then these
H2 sections in order — the five required ones plus optional review-altitude
sections slotted in place (include them when the change warrants; skip them on
trivial plans): \`## Summary\` (≤5 lines, lead with a diagram — see below) ·
*(optional)* \`## Contract\` (≤12 lines —
the interface surface the reviewer signs off instead of reading code: inputs,
outputs, types, errors; one signature fence is fine under the 1-fence rule) ·
\`## Decisions\` (entries ≤3 lines, \`- D<n>: ... ← q<n>\` citing the grill answer
that produced it, or \`[assumed]\`) · *(optional)* \`## Impact\` (≤10 lines — blast
radius: the upstream modules this plan leans on and the downstream modules it can
break; a dependency mermaid is fine under the 1-fence rule) · \`## Phases\`
(\`### Phase <n> — <name>\`, each with \`Goal:\` ≤3 lines, \`Files:\` list,
\`Verification:\` ≤3 lines plus an optional \`\`\`gwt scenario block — see below,
optional collapsible \`#### Details\` block) ·
\`## Risks\` (≤5 items, ≤2 lines each) ·
\`## Open Questions\`. Mermaid / code / \`before\`+\`after\` fences are budget-exempt,
max one per read-path section; the markdown-native review visuals below share a
separate per-section cap. Details may elaborate on the read path, never
introduce new scope.

**Lead with a diagram.** Put a \`\`\`mermaid state / sequence / flow diagram right
under the \`## Summary\` headline — strongly recommended on ~90% of plans, so the
reviewer grasps the change's shape before reading prose. Keep the headline as the ≤5-line
Summary.

## Visuals — prefer them over prose where they carry the information

Four markdown-native primitives the review UI styles. They degrade to readable
markdown if rendering fails, and a comment can anchor to one specific risk, row,
or callout.

- **Callouts** — a blockquote whose first line is a type marker
  (\`[!risk]\`, \`[!note]\`, \`[!decision]\`, \`[!assumption]\`). Risks and
  assumptions SHOULD be callouts, not bullets buried in prose:
  > [!risk]
  > The JWT cutover locks out sessions issued before it.
- **Decision matrix** — a GFM table comparing options, the chosen row led by a
  \`✓\`. A Decisions section weighing 2+ options SHOULD use a matrix:
  | Pick | Option | Tradeoff                        |
  | ---- | ------ | ------------------------------- |
  | ✓    | RS256  | rotate keys without redeploy    |
  |      | HS256  | shared secret on every verifier |
- **Scope pills** — inline tags \`[new]\` \`[breaking]\` \`[risky]\` \`[deletes]\`
  for flagging scope mid-sentence ("adds a [new] issuer; [breaking] cookie removal").
- **Behavioral assertions** — a \`\`\`gwt fence inside a phase's \`Verification\`
  holding one or more Given/When/Then scenarios (blank line between scenarios;
  \`And\`/\`But\` continue a clause). They render as scenario cards that double as
  the human's approve checklist (Test-Driven Review), so write the observable
  behavior the reviewer signs off, not the test code:
  \`\`\`gwt
  Given a plan with no Contract section
  When the agent submits it
  Then the lint passes and review opens
  \`\`\`
  Capped at 6 scenarios per block; must sit under \`Verification\`.

Callouts and matrices are budget-exempt but capped (default 2 per read-path
section); pills are free. Reach for a visual when it carries the point better
than a sentence — never as decoration.

## Rules

- Never use native plan mode, AskUserQuestion, or any built-in question UI while
  the session is open — every question goes through \`${cmd} ask\`.
- Long review or build ahead? Remind the user to keep the Mac awake: \`caffeinate -i\`
  while the session runs.
`;
}

/** The SKILL.md every agent's skills dir gets (Claude, Codex, OpenCode — same format). */
export function skillMd(): string {
  return `---
name: otacon
description: Plan a feature through an otacon review session — grill interview, schema'd plan, phone review with anchored comments, approved plan saved to a home archive (and your project on Save). Use when the user asks to plan something with otacon, types /otacon, or wants a reviewed implementation plan before coding. Replaces native plan mode.
---

<!-- ${MANAGED_MARKER} — reinstall overwrites this file. -->

# Otacon plan session protocol

${protocolCard('otacon')}`;
}

/**
 * THIS repo's dogfood wrapper — the committed \`.claude/skills/otacon/SKILL.md\`.
 * It is the same protocol card as \`skillMd()\`, but with the
 * \`./bin/otacon\` run-from-source command prefix and a repo preamble (run from
 * source, restart after daemon edits). Generated from this function and never
 * hand-edited; \`assets.test.ts\` asserts the committed file equals this output,
 * so a protocol change that updates the card but forgets to regenerate the
 * dogfood file fails CI (D7).
 */
export function dogfoodSkillMd(): string {
  return `---
name: otacon
description: Plan a feature for THIS repo through an otacon review session — grill interview, schema'd plan, browser/phone review with anchored comments, approved plan saved to a home archive (and your project on Save). Use when the user asks to plan something with otacon, types /otacon, or wants a reviewed implementation plan before coding. Replaces native plan mode. Dogfoods otacon on its own development.
---

<!-- Generated from src/cli/install/assets.ts (dogfoodSkillMd) — do NOT hand-edit;
     assets.test.ts guards that this file equals that output. Regenerate after any
     protocol change. -->

# Otacon plan session protocol (dogfooding this repo)

This repo **is** otacon. You plan features for it by running otacon's own CLI from
source via the \`./bin/otacon\` shim, so every command below exercises the code in
this checkout. That shim runs the CLI from \`src/\` via bun — no build needed; it
always reflects current source. The daemon auto-spawns from source on the first
command. Working state lives in \`.otacon/\`; the approved plan is archived in the
home store (\`~/.otacon/sessions/<id>/\`) and, on Save, copied into the repo under
\`plans.dir\` (default \`.otacon/plans\`).

After editing **daemon** source (\`src/daemon/**\`) mid-session, restart the running
daemon so your change loads: \`./bin/otacon restart\` (the next command respawns it
from current source). Use \`./bin/otacon restart\`, not a raw curl to a fixed port —
in a git worktree the shim runs the daemon on a derived port, and \`restart\` always
targets the one this checkout talks to. CLI/linter/parser edits need no restart.

These commands implement otacon's full review loop, grill discipline, and
failure habits; the canonical wrapper text lives in \`src/cli/install/assets.ts\`.

---

${protocolCard('./bin/otacon')}`;
}

/**
 * The Claude Code Stop hook: blocks ending the turn while an
 * open otacon session exists in the cwd's repo. Plain sh, fast, fail-open —
 * any failure (daemon down, curl missing, no match) allows the stop. With no
 * local pointer, the open session is found by scanning the daemon registry for
 * a non-terminal session whose repo equals the cwd's git root —
 * `implementing` still blocks (the build is live); only the terminal states
 * (approved/implemented/implement_failed) let the agent end its turn.
 */
export const STOP_HOOK_SCRIPT = `#!/bin/sh
# otacon Stop hook — ${MANAGED_MARKER}; reinstall overwrites this file.
# Blocks Claude Code from ending its turn while the cwd's repo has an open
# otacon plan session. Fail-open by design: when anything here
# fails (daemon unreachable, curl missing, no match), the stop is allowed.
input=$(cat 2>/dev/null) || input=""
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
[ -n "$cwd" ] || cwd=$PWD
root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || root=$cwd
root=$(cd "$root" 2>/dev/null && pwd -P) || exit 0
port=\${OTACON_PORT:-4747}
list=$(curl -fsS --max-time 2 "http://127.0.0.1:$port/api/sessions" 2>/dev/null) || exit 0
# Split the compact registry array one session-object per line, keep this repo's
# open (non-terminal) sessions, take the first id. The repo match is exact: the
# pattern includes the closing quote of the JSON value. Terminal statuses
# (approved/implemented/implement_failed) are over -- drop them so a finished
# build no longer traps the agent, while an in-flight implementing still blocks.
sid=$(printf '%s' "$list" | sed 's/},{/}\\
{/g' | grep -F "\\"repo\\":\\"$root\\"" | grep -vE '"status":"(approved|implemented|implement_failed)"' | sed -n '1s/.*"id":"\\([^"]*\\)".*/\\1/p')
[ -n "$sid" ] || exit 0
printf '{"decision":"block","reason":"otacon plan session %s is still open — run otacon wait --timeout 540 (Bash timeout 600000 ms) and keep handling events until the plan is approved; run otacon status to re-orient."}\\n' "$sid"
exit 0
`;
