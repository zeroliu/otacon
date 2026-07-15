// The wrapper content `otacon install` writes — these are the product-critical
// cards that teach an agent the plan and PR-review protocols. Two protocol
// cards, three destinations — Claude Code, Codex, and OpenCode each get both as
// SKILL.md files in their own skills dirs. Plus the shared Stop hook script.
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

## Hard implementation gate

When this skill is triggered, you MUST NOT create, edit, delete, or format project
files, run code-modifying commands, or implement the requested change until a
\`${cmd} wait\` event returns \`{"event":"approved",...,"implement":true}\`.

Before that event, allowed actions are only:
- \`${cmd} start\` / \`${cmd} status\` / \`${cmd} open\` / \`${cmd} progress\` /
  \`${cmd} ask\` / \`${cmd} wait\` / \`${cmd} submit\` / \`${cmd} answer\`.
- Read-only research commands.
- Writing the plan and resolutions files under the session's home dir (\`~/.otacon/sessions/<id>/\`, the \`plan\` path \`start\` prints).

A user request phrased as "can you make/fix/implement..." is still a plan-review
request when this skill is active. Approval is not implied by the original request.

## Starting: resume an amendment, or plan fresh

Before \`${cmd} start\`, check where you are: run \`${cmd} status\`. If its output
carries a \`resumeCandidate\`, you are standing inside a build worktree otacon
created for a finished plan: a chance to AMEND that plan in place instead of
spawning a second worktree.

- Read the candidate plan at \`resumeCandidate.plan\` and judge whether the user's
  request is about THAT feature.
  - **Clearly unrelated** (a different feature) → just \`${cmd} start\` a fresh
    session and ignore the candidate.
  - **Related, or you are unsure** → ask the user, here in the terminal, whether to
    resume and amend the existing plan or start new. This is the ONE question that
    does not go through \`${cmd} ask\` (no session is open yet); wait for the answer
    before acting.
- On **resume**: \`${cmd} resume\` (it auto-detects the session from this worktree,
  reopens it to \`revising\`, and prints the \`plan\` path). SKIP research and grill,
  since the plan exists. Edit that \`plan\` file into revision N+1 directly from the user's
  request (grill only if it is genuinely ambiguous), \`${cmd} submit\`, then go to
  the **Review loop** (step 5). The review diffs against the approved revision.
- No \`resumeCandidate\` → the normal flow below.

## The loop

1. \`${cmd} start --title <kebab-title>\` **first, before you research** — it mints
   the session and prints the review URL plus the \`plan\` draft path (under
   \`~/.otacon/sessions/<id>/\`). Tell the user to open the URL (\`${cmd} open\`
   launches it in their browser) so they can watch the whole thing from the first second.
   Pass the user's ORIGINAL request verbatim as \`--prompt "<their words>"\`: strip ONLY
   the \`/otacon\` skill-invocation boilerplate (the slash-command wrapper), never the
   actual ask. It populates a "Prompt" card at the top of the reviewer's screen so they
   never lose track of what they asked for.
   \`--quick\` skips the interview — only when the user explicitly asks.
2. **Research the codebase.** On supported agents the daemon now auto-streams your
   tool calls, text, and thinking to the reviewer's now-playing console, so it
   already sees the routine work. Use \`${cmd} progress "<what you're doing>"\` for
   OCCASIONAL highlights and chapter markers (a milestone, a phase boundary, "what
   I'm about to do next"), not per-step narration. It is the universal floor: on an
   agent with no auto-capture those notes are the ONLY thing keeping the now-playing
   bar alive, so still drop one whenever you start a chunk of work the user can't
   otherwise see. It is a non-blocking one-liner that feeds the live stream and the
   draft chip; no answer comes back, so never park on it. Read enough to propose
   answers, not collect questions.
3. **Grill** (mandatory unless --quick): Interview me relentlessly about every
   aspect of this plan until we reach a shared understanding. Walk down each branch
   of the design tree, resolving dependencies between decisions one-by-one. For
   each question, provide your recommended answer. Explore the code before asking.
   Never ask what the code can answer.
   - \`${cmd} ask --question "..." --options "A|B|C" --recommend A\` — always lead
     with your recommended answer. \`--multi\` for multi-select; omit \`--options\`
     for free text. The user can always answer with free-form custom text instead
     of (or alongside) the chips, so frame options as a starting point, not a cage.
   - **One question, well-shaped.** Ask one decision per card and keep it short by
     default. When a question genuinely needs length (the user asked for that depth, or
     in socratic mode you are feeding context like a professor), break it into short
     paragraphs with blank lines between them; never post one unbroken wall. Newlines
     render fine (the card preserves them); the only friction is shell-quoting a
     multi-line flag, so author the long question in a temp file under \`$TMPDIR\` and
     pass it in, then delete it:
     \`${cmd} ask --question "$(cat "$TMPDIR/otacon-q.txt")"\` then \`rm\` the temp file.
     Wall (avoid): "...five modes: (1)... (2)... my one-line test:... does it match?..."
     Formatted (do): the same content, one short paragraph per idea, blank lines between.
   - Independent questions whose answers don't shape each other? Post them in one
     call: \`${cmd} ask --batch questions.json\` (or \`--batch -\` for stdin) — a JSON
     array of the same specs (\`{question, options?, recommend?, multi?}\`). They land
     as ordinary cards; loop \`wait\` to collect each answer. Dependent questions
     still go one at a time.
   - Park for the answer: \`${cmd} wait --timeout 540\` (set the Bash tool timeout
     to 600000 ms). The answer arrives as \`{"event":"answer","question":"q<n>",...}\`.
4. **Draft** the plan at the \`plan\` path \`start\` printed (\`~/.otacon/sessions/<id>/plan.md\`) in the schema below, then
   \`${cmd} submit\`. On exit 1, fix every reported lint issue and resubmit until
   accepted. After a clean submit, stop all implementation work and park in
   \`${cmd} wait\`; only an \`approved\` event with \`implement:true\` enters the
   Implement loop.
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

## Socratic mode (opt-in)

When the user asks to plan socratically (says "socratic", "grill me socratically",
"use socratic mode", or passes \`--socratic\`), start the session with
\`${cmd} start --title <t> --socratic\`. Recognizing that request and passing the flag
is YOUR job; the daemon then enforces the posture below for the session's whole life.
A repo can also opt in by default via \`socratic.default\` config.

In socratic mode you are a thinking-partner and professor, not an answer vending
machine. Invert your usual posture:

- **Do not lead with the answer.** Surface the real situation, the genuine tradeoffs,
  and the relevant code/context, then ask the user to reason it out and decide
  themselves. You frame the problem; they make the call.
- **Free-text only.** Every grill question is free text: \`${cmd} ask\` refuses
  \`--options\` and \`--recommend\` in socratic mode (\`E_SOCRATIC_FREE_TEXT_ONLY\`). If a
  question has a bounded set of choices, name them in the question prose; the user
  answers in their own words.
- **Feed context like a professor.** When the user is missing a fact, teach it (cite
  the code, state the constraint), then ask the question that lets them draw the
  conclusion themselves. Still never ask what the code can answer for you. Format that context into short paragraphs, never one wall (see the question-shape rule above).
- **Do not always agree.** Challenge weak, shallow, or hand-wavy answers. Probe with a
  follow-up question (it carries \`replyTo\`): surface the case their answer breaks on
  and make them defend or revise it. Push until the reasoning is sound, not just until
  they reply.
- **Decisions trace to their reasoning.** Every \`## Decisions\` entry must cite the
  \`← q<n>\` whose answer is the user's own free-text reasoning. \`[assumed]\` is banned
  (\`E_ASSUMED_NOT_ALLOWED\`): you may not decide for them. If you are tempted to assume,
  ask instead.
- **No downgrade.** The mode is fixed for the session's life. If the user wants out of
  socratic mode, they start a fresh (non-socratic) session.

## CLI quick reference

- \`${cmd} start --title <t> [--prompt "<request>"] [--quick]\` · \`${cmd} resume [--session <id>]\` ·
  \`${cmd} progress "<note>"\` (occasional highlights / chapter markers; the activity
  floor on agents without auto-capture) ·
  \`${cmd} ask ...\` · \`${cmd} wait --timeout 540\` · \`${cmd} submit [--resolutions f]\` ·
  \`${cmd} answer <q> --body "..."\` · \`${cmd} implement-done [--pr <url>] [--failed]\` ·
  \`${cmd} status\` · \`${cmd} open\` · \`${cmd} config [get <key>]\`

## Implement loop (on \`approved\` with \`implement:true\`)

You are the **orchestrator**: you only coordinate and mark progress
(\`${cmd} progress\` at phase boundaries, an occasional chapter marker rather than
every action; on supported agents the now-playing console already streams the work).
Every phase's real work runs in a fresh native subagent (Task tool) so your own
context stays lean.

1. **Setup.** Read the plan from the home archive at the event \`path\`.
   - **Amending** (you resumed this session, so its build worktree already exists
     and you are standing in it): do NOT create a worktree. \`cd\` into
     \`<worktree.dir>/<slug>\`, make sure you are on \`otacon/impl-<slug>\`, and build
     on top of the existing commits. Pushing later updates the SAME PR.
   - **Fresh** (no existing worktree): branch off the repo's default-branch HEAD and
     create the worktree under \`worktree.dir\` (\`${cmd} config get worktree.dir\`,
     default \`~/.otacon/worktrees\`, outside the repo):
     \`git worktree add <worktree.dir>/<slug> -b otacon/impl-<slug>\` (off the default
     branch).
   Drop a \`${cmd} progress\` highlight at each phase boundary throughout, not at
   every step.
2. **Per phase, in order** (read the phases from the home plan at the event \`path\`;
   on an amendment, implement only the phases this revision changed, using the
   changelog and the diff to scope):
   - \`${cmd} progress "phase N — implementing"\` (one marker per phase); spawn an
     **implement+test**
     subagent (Task tool) scoped to that phase's Goal/Files/Verification — it
     implements and runs the phase Verification plus the repo gates.
   - spawn a **separate** \`/code-review --fix\` subagent on the phase's working
     diff; it applies findings; re-review. (\`/code-review\` effort is config — start
     moderate so false positives don't become needless pauses.)
   - **clean + green** → commit the phase and continue. **Blocked** (tests stay red,
     review still flags, or a subagent is stuck) → on the FIRST blocker,
     \`${cmd} ask\` with options \`retry|skip|abort|guidance\`, park in \`${cmd} wait\`,
     and act on the answer. No auto-retry.
3. **Finish — write a reviewer-first PR body.** Author the body by PORTING the approved
   plan (read from the home \`path\`), not by re-describing the diff:
   - \`## Summary\` — lead with the plan's Summary visual when it shows the change's
     shape, then **Why** (the problem this PR fixes) and **What** (the behavior/output
     that changes, not which files or modules moved).
   - \`## Decisions\` — port the plan's Decisions (decision + rationale); drop the
     \`← q<n>\` cites, which only index local grill questions.
   - \`## Changes\` — one bullet per commit, led by its short SHA: what that commit
     achieves + the behavior to verify (port each phase's Goal + Verification/gwt). No
     file-by-file lists; the diff carries those.
   - \`## Notes / follow-ups\` (optional) — pre-existing failures or deferred scope.
   Omit the otacon session id/hash (local-only) and any mechanical test report
   (\`bun test N pass\`, typecheck clean).
   Open the PR against the default branch with \`gh pr create\`, as a **draft by
   default**: run \`${cmd} config get pr.draft\` and pass \`--draft\` to \`gh pr create\`
   unless it returns \`false\` (fall back to noting the local branch + \`path\` when there
   is no remote). \`pr.draft\` governs creation only. On an **amendment** the PR already
   exists: push to update it and **refresh the whole body** to the PR's current
   cumulative state — do not append \`### Update: Phase N\` stubs — then reuse its URL (on
   the session; \`${cmd} status\` reports \`prUrl\`); the amendment does NOT change the PR's
   draft or ready state. Either way finish with
   \`${cmd} implement-done --pr <url>\`; on abort, run \`${cmd} implement-done --failed\`.

While \`implementing\` the Stop hook still keeps you on the line — never end the turn
until \`implement-done\`.

## Plan schema (linted on submit)

Frontmatter (\`title\`, \`session\`, \`revision\`, \`status\`, \`created\`), then these
H2 sections in order — the five required ones plus optional review-altitude
sections slotted in place (include them when the change warrants; skip them on
trivial plans): \`## Summary\` (≤5 lines, lead with a visual — see below) ·
*(optional)* \`## Contract\` (≤12 lines —
the interface surface the reviewer signs off instead of reading code: inputs,
outputs, types, errors; one signature fence is fine under the 1-fence rule) ·
\`## Decisions\` (entries ≤3 lines, \`- D<n>: ... ← q<n>\` citing the grill answer
that produced it, or \`[assumed]\`) · *(optional)* \`## Impact\` (≤10 lines — blast
radius: the upstream modules this plan leans on and the downstream modules it can
break; a dependency mermaid is fine, and is exempt from the fence cap) · \`## Phases\`
(\`### Phase <n> — <name>\`, each with \`Goal:\` ≤3 lines, \`Files:\` as a
\`| File | What changed |\` table (fill every row's 'What changed' cell) or a
plain list (the review shows Verification above Files, so Files reads last),
\`Verification:\` ≤3 lines plus an optional \`\`\`gwt scenario block — see below,
optional collapsible \`#### Details\` block) ·
\`## Risks\` (≤5 items, ≤2 lines each) ·
\`## Open Questions\`. Fenced blocks are line-budget-exempt; code and
\`before\`+\`after\` fences are capped at one per read-path section, but \`mermaid\`
diagrams are exempt from that cap (they count only toward the lead-visual check),
so a lead diagram and a structural diagram can coexist in one section. The
markdown-native review visuals below share a separate per-section cap. Details may
elaborate on the read path, never introduce new scope.

**Lead with a visual, but the right one.** Open the \`## Summary\` with a visual so the
reviewer sees the change's shape before the prose. This stays the strong default (about
90% of plans want one). But a visual only helps when its shape matches the content. The
test: a diagram earns its place only when it reveals structure (a branch, a cycle,
fan-in/fan-out, parallelism, or a true hierarchy) that prose or a table can't show at a
glance. If the content redraws losslessly as a 2-column table or one sentence, lead with
that instead (a decision-matrix table counts as a visual): a forced diagram is worse than
none. Keep the headline as the ≤5-line Summary.

**Match the representation to the content's shape. \`graph TD\` is one option, not the
default; reach for it only for a genuine branching flow or a true hierarchy:**

| When the content is… | Lead with | Not |
| --- | --- | --- |
| things resting in conditions; edges are *events* (a lifecycle) | \`stateDiagram-v2\` | a flowchart of "steps" |
| an ordered exchange between 2+ actors or systems over time | \`sequenceDiagram\` | a flowchart |
| ONE process with a real decision point and/or a feedback loop | \`flowchart\` (LR/TD) | (fine as is) |
| a dependency or blast-radius graph (every edge means "depends on") | \`flowchart\`, one arrow-meaning, every edge labeled | mixed-meaning arrows |
| a classification, key→value map, or option comparison | a **decision-matrix table** | a decision-diamond fan-out |
| a problem→fix or symptom→cause mapping | a **table** | a graph of disconnected pairs |
| a straight A→B→C→D with no branch | **one sentence** or a numbered list | a flowchart |

**Diagram anti-patterns. Each one shipped in a real plan; do not repeat them:**
- A decision diamond fanning to N leaves where nothing nests further. That is a lookup table, not a decision. Use a table.
- A linear call or import chain (\`A→B→C→D\`). It just restates code reading order. Keep only the structural fact (a shared dependency, a fan-in), else use prose.
- Two unrelated concerns in one chart joined by a shared "hinge" node. Split them; lead with the one that is the actual change.
- One arrow glyph meaning three things (calls, then, depends-on) in the same diagram. Pick ONE meaning per diagram and label every edge.
- A flowchart whose every arrow just means "and then." That is a sentence.

When the content has no shape worth drawing and you lead with plain prose (no diagram and
no table), add a \`<!-- no-lead-diagram: <why> -->\` marker in Summary so the L7 nudge stays
quiet. A lead decision-matrix table already satisfies L7, so a table-lead never needs the
marker. The marker makes a no-visual lead a deliberate, visible choice, not an oversight.

## Visuals — prefer them over prose where they carry the information

Four markdown-native primitives the review UI styles. They degrade to readable
markdown if rendering fails, and a comment can anchor to one specific risk or
row.

- **Callouts** — an inline type marker (\`[!risk]\`, \`[!note]\`, \`[!decision]\`,
  \`[!assumption]\`) anywhere in prose renders as a small inline badge; the rest
  of the line stays normal prose. Risks and assumptions SHOULD lead with a
  callout marker, not be bullets buried in prose:
  [!risk] The JWT cutover locks out sessions issued before it.
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

When plan content is itself a hierarchy or tree (a taxonomy, a doc or file structure, a
nested option space, a state hierarchy), draw it as a \`\`\`mermaid diagram, never as a
monospace nested outline in a \`\`\`text fence (an outline forces the reviewer to
reconstruct the shape line by line). Pick the shape from the table above. Put it in the
section that owns that structure (Contract, Impact, or a phase's Details); \`mermaid\`
diagrams don't count toward the per-section fence cap, so a lead diagram and a structural
one can coexist.

A decision matrix is budget-exempt but capped (default 2 per read-path
section); callout badges and pills are inline and free. Reach for a visual when
it carries the point better than a sentence — never as decoration.

## Rules

- Never use native plan mode, AskUserQuestion, or any built-in question UI while
  the session is open: every question goes through \`${cmd} ask\`. The sole exception
  is the resume-vs-new question at the very start, before any session exists.
- If you notice you edited project files before \`approved implement:true\`, stop
  immediately, disclose the mistake, and ask whether to revert or keep the
  uncommitted changes.
- Long review or build ahead? Remind the user to keep the Mac awake: \`caffeinate -i\`
  while the session runs.
`;
}

/** The SKILL.md every agent's skills dir gets (Claude, Codex, OpenCode — same format). */
export function skillMd(): string {
  return `---
name: otacon
description: Plan a feature through an otacon review session: grill interview, schema'd plan, phone review with anchored comments, approved plan saved to a home archive (and your project on Save). Use when the user asks to plan something with otacon, types /otacon, or wants a reviewed implementation plan before coding. Replaces native plan mode. Also resumes and amends an implemented plan when run from inside its build worktree.
---

<!-- ${MANAGED_MARKER} — reinstall overwrites this file. -->

# Otacon plan session protocol

${protocolCard('otacon')}`;
}

/**
 * THIS repo's dogfood wrapper — the committed \`.claude/skills/otacon-dev/SKILL.md\`.
 * Named \`otacon-dev\` (not \`otacon\`) so it never collides with the installed
 * product skill (\`otacon\`) when developing otacon itself: \`/otacon\` stays the
 * real product, \`/otacon-dev\` is this source-mode wrapper.
 * It is the same protocol card as \`skillMd()\`, but with the
 * \`./bin/otacon\` run-from-source command prefix and a repo preamble (run from
 * source, restart after daemon edits). Generated from this function and never
 * hand-edited; \`assets.test.ts\` asserts the committed file equals this output,
 * so a protocol change that updates the card but forgets to regenerate the
 * dogfood file fails CI (D7).
 */
export function dogfoodSkillMd(): string {
  return `---
name: otacon-dev
description: Plan a feature for THIS repo through an otacon review session: grill interview, schema'd plan, browser/phone review with anchored comments, approved plan saved to a home archive (and your project on Save). Use when the user asks to plan something with otacon, types /otacon, or wants a reviewed implementation plan before coding. Replaces native plan mode. Dogfoods otacon on its own development. Also resumes and amends an implemented plan when run from inside its build worktree.
---

<!-- Generated from src/cli/install/assets.ts (dogfoodSkillMd) — do NOT hand-edit;
     assets.test.ts guards that this file equals that output. Regenerate after any
     protocol change. -->

# Otacon plan session protocol (dogfooding this repo)

This repo **is** otacon. You plan features for it by running otacon's own CLI from
source via the \`./bin/otacon\` shim, so every command below exercises the code in
this checkout. That shim runs the CLI from \`src/\` via bun — no build needed; it
always reflects current source. The daemon auto-spawns from source on the first
command. Working state lives in the home store (\`~/.otacon/sessions/<id>/\`); on
Save the approved plan is also copied into the repo under \`plans.dir\` (default
\`.otacon/plans\`). \`<repo>/.otacon/\` itself holds only config and those Save copies.

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
 * The PR-review orchestration protocol. It is intentionally separate from the
 * plan protocol above: both skills share one daemon, but neither skill teaches
 * or emits the other session kind's commands or events.
 */
function reviewProtocolCard(cmd: string): string {
  return `Explain one GitHub pull request through Otacon's shared browser UI, then
stay with the reviewer until that review is terminal. Every \`${cmd}\` command
prints one JSON line. Exit 0 = proceed; exit 1 = fix the reported condition;
exit 2 = fix the invocation.

## Start in the PR repository

1. Require the user's PR URL or number and run inside its target git repository.
   Do not create a session from another directory. Run
   \`${cmd} review start --pr <URL-or-number>\`; pass \`--force\` only when the user
   explicitly asks to restart or review from scratch.
2. Reuse the returned session. The same unchanged PR opens its existing review;
   a changed head reopens that session with a new head revision; \`--force\` alone
   creates an independent session. Never substitute a second daemon or session.
3. Open the returned \`url\` and tell the user it is ready. If the response is
   \`readOnly:true\`, the persisted completion is the earlier \`review-done\`
   terminal result: show the historical review and stop without rewriting it.
   If it says \`authoring:false\`, the unchanged active report is already
   submitted: open it and enter the event loop without overwriting that revision.

## Author the review

For an active preparation, read both frozen knowledge files under
\`knowledge.snapshot\` completely before writing. Treat them as personalization,
not truth: use User knowledge for general depth and learning preferences; use
Project knowledge for repo architecture and prior exposure. With no evidence,
use a balanced baseline. Never read the mutable current summaries in place of
the returned frozen snapshot.

Inspect the PR description, issue/context, diff, tests, and surrounding code.
Explain in cognition-first order rather than diff order:

1. **Background** — why the change exists, what failed or was missing, and the
   constraints that shaped it.
2. **Intuition** — the smallest mental model of the change and its important
   tradeoffs before naming implementation details.
3. **Code** — group the causal read as interface changes, integration path, then
   implementation walkthrough. Use typed H3 headings beginning exactly
   \`### Interface changes —\`, \`### Integration path —\`, or
   \`### Implementation walkthrough —\`; include at least one of each, in that
   order. Within each group, order by cause and dependency, not filename or
   patch order. Include these exact labels in every group:
   \`**Purpose:**\`, \`**Changed behavior:**\`, and \`**Surfaces:**\` with concrete
   \`file#symbol\` references.
4. **Quiz** — summarize what the questions verify; keep private rubrics and keys
   only in the companion JSON.

Write the report to the returned \`report\` path with exactly this section order:
\`## Background\`, \`## Intuition\`, \`## Code\`, \`## Quiz\`. Its frontmatter is
exactly these scalar keys in order: \`type: otacon-pr-review\`, \`version: 1\`,
\`session\`, \`revision\`, \`pr\` as \`github.com/owner/repo#number\`, \`head\`,
\`knowledge-snapshot\`, and \`altitude\`. Copy every identity/hash value from the
preparation and resolved PR; do not infer one. Choose \`expert\` altitude only
when the frozen Project evidence shows architectural familiarity; otherwise
choose \`balanced\`. Write the quiz companion to
the returned \`quiz\` path: version 1, the same session/report/head identity, and
1–20 complexity-driven questions. Each question contains \`id\`,
\`concept:{id,label,scope}\`, \`prompt\`, \`mode\`, and
\`rubric:{criteria:[...]}\`; choice mode additionally contains \`options\` and
\`answerKey\`. Prefer open-ended questions that make the
reviewer explain the idea in their own words. Use a choice question only for a
genuinely crisp distinction. Give each question one concept, a User or Project
scope, and private, concrete rubric criteria. Never expose a rubric or answer key
in the report, browser response, or thread answer.

Run \`${cmd} review submit --report <report-path> --quiz <quiz-path>\`. Fix every
reported lint or identity error and resubmit. Then park with
\`${cmd} wait --session <id> --timeout 540\` (use a 600000 ms tool timeout).

## Handle review events

Handle exactly one returned event, then park again:

- \`quiz-answer\`: Compare the answer with every private rubric criterion and the
  code. Write a grade JSON containing exactly \`version:1\`, \`session\`,
  \`revision\`, \`headRevision\`, \`headSha\`, \`question\`, \`attempt\`,
  \`verdict\`, \`feedback\`, and \`knowledgeBaseHash\` copied from
  \`knowledge.baseHash\`. Choose \`pass\` only when the answer satisfies every
  rubric criterion; otherwise choose \`retry\`, say what the reviewer got right
  and what still needs correction, and invite another answer without revealing
  a model answer. Run
  \`${cmd} review grade <question> --file <grade.json>\`. The daemon records
  successful quiz evidence in the requested knowledge scope; never manufacture
  a pass or edit evidence by hand.
- \`review-thread\` with \`work:"question"\`: Answer the question only; do not
  revise the report or touch code. Write the strict response JSON and run
  \`${cmd} review respond <thread> --file <response.json>\`.
- \`review-thread\` with \`work:"report-feedback"\`: Treat this as feedback on the
  explanation, not permission to edit code. If it carries \`remember\`, perform
  the requested knowledge CAS first so the replacement report freezes the
  updated summary. Then run \`${cmd} review revise --session <id>\`, read the new
  frozen knowledge snapshot, revise the whole report and quiz at the returned
  paths, submit them, then respond with the newer submitted
  \`responseReportRevision\` and the saved receipt only when that CAS succeeded.
- \`review-thread\` with \`work:"code-change"\`: This event is the explicit second
  step from a persisted Comment and the only thread event that authorizes code
  edits. Mark it \`working\` with \`${cmd} review code-status\`, then run
  \`${cmd} review checkout --session <id>\`. If checkout reports a fork,
  insufficient permission, a stale/dirty worktree, or any read-only path, make
  no mutation; explain the advice and mark the action \`failed\`.

For a question carrying \`remember\`, complete the scope-matching knowledge
update below before answering. The report-feedback rule above performs the same
update before \`review revise\`. A later code-change event reuses that Comment's
existing acknowledgement; never record the same exchange twice.

Response files contain exactly \`version:1\`, \`session\`, \`thread\`,
\`source:{reportRevision,headRevision,headSha}\`, and \`body\`, plus only the
applicable \`responseReportRevision\` and requested \`saved\` receipt. Code-status
files use the same version/session/thread/source identity plus \`status\` and an
optional non-empty \`message\`. Copy every identity field from the private event;
never guess current values.

For an authorized code change, remain the orchestrator. Spawn one native
implementation subagent in the exact returned worktree and scope it to the
Comment. Do not implement the change in the main agent. After the subagent
returns, the main agent reviews its diff, runs the relevant tests, commits, and
pushes only to the returned remote/ref. Then run
\`${cmd} review refresh-head --session <id>\`, rebuild and submit the personalized
report/quiz for the new head, and mark the code action \`completed\`. On any
failure, preserve the worktree and mark it \`failed\` with an actionable message;
never reset, force-push, or silently switch branches.

## Remember requested knowledge

A thread's \`remember.scope\` is a request, not a receipt. Before responding, use
\`${cmd} knowledge get --scope user|project\`, edit only the high-level Markdown
summary, then use \`${cmd} knowledge put\` with the returned base hash. In Project
scope, omit \`--repo\` while cwd is the target repository or pass its local clone
root as \`--repo <root>\`; never pass \`owner/repo\` to that path flag. Add
\`saved:{scope,updated:true}\` to the response only after that exact write
succeeds. Preserve the distinction between exposure (files/functions reviewed)
and demonstrated understanding (quiz evidence).

## Finish

- \`review-done\`: the reviewer ended this session. Report the completion and stop.
- \`deleted\`: the reviewer deleted this session. Stop.
- \`timeout\`: park again immediately.

Never end the turn while an active review is open. A quiet queue is not
completion. If interrupted or compacted, run \`${cmd} status\`, recover the review
session for this repository, and continue waiting until \`review-done\` or
\`deleted\`.
`;
}

/** The installed PR-review skill shared byte-for-byte by all supported agents. */
export function reviewSkillMd(): string {
  return `---
name: otacon-review
description: Explain and interactively review a GitHub pull request through Otacon with a personalized Background, Intuition, Code walkthrough, adaptive quiz, anchored questions/comments, optional explicit code-change handoff, and local knowledge updates. Use when the user types /otacon-review, supplies a PR for explanation or learning, wants to understand a PR before approving it, or wants to resume an Otacon PR review.
---

<!-- ${MANAGED_MARKER} — reinstall overwrites this file. -->

# Otacon PR review protocol

${reviewProtocolCard('otacon')}`;
}

/** This repo's source-mode dogfood variant of the PR-review skill. */
export function dogfoodReviewSkillMd(): string {
  return `---
name: otacon-review-dev
description: Explain and interactively review a GitHub pull request while developing THIS Otacon repo, using the source CLI, personalized report, adaptive quiz, anchored threads, explicit code-change handoff, and local knowledge. Use when the user types /otacon-review-dev or asks to dogfood PR review behavior from this checkout.
---

<!-- Generated from src/cli/install/assets.ts (dogfoodReviewSkillMd) — do NOT hand-edit;
     assets.test.ts guards exact parity. Regenerate after any protocol change. -->

# Otacon PR review protocol (dogfooding this repo)

This repo **is** Otacon. Run every command through the \`./bin/otacon\` source
shim. After editing \`src/daemon/**\`, run \`./bin/otacon restart\` before the next
protocol command so the isolated worktree daemon loads the change. Do not use a
fixed raw HTTP port.

---

${reviewProtocolCard('./bin/otacon')}`;
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
# otacon plan or PR-review session. Fail-open by design: when anything here
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
open=$(printf '%s' "$list" | sed 's/},{/}\\
{/g' | grep -F "\\"repo\\":\\"$root\\"" | grep -vE '"status":"(approved|implemented|implement_failed|done)"' | sed -n '1p')
sid=$(printf '%s' "$open" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
[ -n "$sid" ] || exit 0
kind=$(printf '%s' "$open" | sed -n 's/.*"kind":"\\([^"]*\\)".*/\\1/p')
if [ "$kind" = "review" ]; then
  printf '{"decision":"block","reason":"otacon PR review session %s is still open — run otacon wait --session %s --timeout 540 (Bash timeout 600000 ms) and handle quiz/thread events until review-done or deleted; run otacon status to re-orient."}\\n' "$sid" "$sid"
else
  printf '{"decision":"block","reason":"otacon plan session %s is still open — run otacon wait --session %s --timeout 540 (Bash timeout 600000 ms) and keep handling events until the plan is approved; run otacon status to re-orient."}\\n' "$sid" "$sid"
fi
exit 0
`;
