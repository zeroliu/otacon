// The wrapper content `otacon install` writes (DESIGN.md §16) — this is the
// product-critical text that teaches an agent the whole protocol: the §6 full
// loop, §8 grill discipline, and §13 "never end your turn". One protocol card,
// three destinations: Claude Code and OpenCode get it as a SKILL.md; Codex gets
// it as a marker-delimited block inside its shared ~/.codex/AGENTS.md. Plus the
// Stop hook shell script (§13). Wrappers are managed files: reinstall
// overwrites them wholesale (DECISIONS.md "Wrappers are managed files").

/** Present in every wrapper this tool owns; doctor greps for it. */
export const MANAGED_MARKER = "managed by `otacon install`";

export const CODEX_BEGIN =
  "<!-- BEGIN OTACON — managed by `otacon install`; content inside these markers is overwritten on reinstall -->";
export const CODEX_END = "<!-- END OTACON -->";

/**
 * The protocol card — §6 full loop (start-first) + §8 grill discipline + §13
 * failure habits — parametrized by the command prefix so one source feeds both
 * wrappers (D7): `otacon` for what `otacon install` writes into any repo,
 * `./bin/otacon` for this repo's dogfood (run-from-source). The only thing that
 * varies between the two is `cmd`; the protocol text is identical, so a change
 * here lands in both at once.
 */
function protocolCard(cmd: string): string {
  return `Run plan reviews through the otacon CLI instead of your native plan mode. The
user reviews in a browser — often a phone over Tailscale. Every \`${cmd}\`
command prints exactly one JSON line on stdout. Exit 0 = proceed; exit 1 = a
machine-readable error you can fix (read the JSON); exit 2 = you invoked it wrong.

## The loop

1. \`${cmd} start --title <kebab-title>\` **first, before you research** — it mints
   the session and prints the review URL. Tell the user to open it (\`${cmd} open\`
   prints it again) so they can watch the whole thing from the first second.
   \`--quick\` skips the interview — only when the user explicitly asks.
2. **Research the codebase**, narrating as you go with
   \`${cmd} progress "<what you're doing>"\` — call it whenever you start a chunk of
   work the user can't otherwise see (reading a module, drafting, revising). It is
   a non-blocking one-liner that feeds the live activity log and the draft chip; no
   answer comes back, so never park on it. Read enough to propose answers, not
   collect questions.
3. **Grill** (mandatory unless --quick): walk the design tree ONE question at a
   time, dependencies first. Explore the code before asking — never ask what the
   code can answer.
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
     (loop on lint errors); park again.
   - \`question\` → \`${cmd} answer <q-id> --body "..."\` (or \`--file\`); park again.
   - \`answer\` → use it and continue; park again whenever you are waiting.
   - \`timeout\` → park again immediately. A timeout is NEVER completion.
   - \`approved\` → \`git add\` + commit the plan file at the printed \`path\`, print a
     one-line summary, and STOP. Planning only — implementation is another
     session's job.
6. **Never end your turn while the session is open.** Nothing to do = park in
   \`${cmd} wait\` again. Confused, crashed, or compacted? \`${cmd} status\` returns
   the open session, revision, and pending events — resume the loop from it.

## CLI quick reference

- \`${cmd} start --title <t> [--quick]\` · \`${cmd} progress "<note>"\` ·
  \`${cmd} ask ...\` · \`${cmd} wait --timeout 540\` · \`${cmd} submit [--resolutions f]\` ·
  \`${cmd} answer <q> --body "..."\` · \`${cmd} status\` · \`${cmd} open\`

## Plan schema (linted on submit)

Frontmatter (\`title\`, \`session\`, \`revision\`, \`status\`, \`created\`), then exactly
these H2 sections in order: \`## Summary\` (≤5 lines) · \`## Decisions\` (entries
≤3 lines, \`- D<n>: ... ← q<n>\` citing the grill answer that produced it, or
\`[assumed]\`) · \`## Phases\` (\`### Phase <n> — <name>\`, each with \`Goal:\` ≤3
lines, \`Files:\` list, \`Verification:\` ≤3 lines, optional collapsible
\`#### Details\` block) · \`## Risks\` (≤5 items, ≤2 lines each) ·
\`## Open Questions\`. Mermaid / code / \`before\`+\`after\` fences are budget-exempt,
max one per read-path section. Details may elaborate on the read path, never
introduce new scope.

## Rules

- Keep the user in the loop: \`${cmd} progress\` at every checkpoint they can't see
  (research phase boundaries, drafting, each revision) so the activity log and the
  draft chip show work happening — silence past a while reads as "agent gone".
- Never use native plan mode, AskUserQuestion, or any built-in question UI while
  the session is open — every question goes through \`${cmd} ask\`.
- Dependencies first, one question at a time; only batch independent siblings.
  Recommended option first; the phone is the review surface.
- Long review ahead? Remind the user to keep the Mac awake: \`caffeinate -i\`
  while the session runs.
`;
}

/** ~/.claude/skills/otacon/SKILL.md and the OpenCode equivalent (same format). */
export function skillMd(): string {
  return `---
name: otacon
description: Plan a feature through an otacon review session — grill interview, schema'd plan, phone review with anchored comments, approved committed artifact. Use when the user asks to plan something with otacon, types /otacon, or wants a reviewed implementation plan before coding. Replaces native plan mode.
---

<!-- ${MANAGED_MARKER} — reinstall overwrites this file; the spec lives in otacon's DESIGN.md -->

# Otacon plan session protocol

${protocolCard("otacon")}`;
}

/** The marker-delimited block upserted into ~/.codex/AGENTS.md. */
export function codexBlock(): string {
  return `${CODEX_BEGIN}

# Otacon plan sessions

When the user asks you to plan a feature "with otacon" (or to run a plan
review), follow this protocol exactly.

${protocolCard("otacon")}
${CODEX_END}`;
}

/**
 * THIS repo's dogfood wrapper — the committed \`.claude/skills/otacon/SKILL.md\`
 * (DESIGN.md §16). It is the same protocol card as \`skillMd()\`, but with the
 * \`./bin/otacon\` run-from-source command prefix and a repo preamble (run from
 * source, restart after daemon edits). Generated from this function and never
 * hand-edited; \`assets.test.ts\` asserts the committed file equals this output,
 * so a protocol change that updates the card but forgets to regenerate the
 * dogfood file fails CI (D7).
 */
export function dogfoodSkillMd(): string {
  return `---
name: otacon
description: Plan a feature for THIS repo through an otacon review session — grill interview, schema'd plan, browser/phone review with anchored comments, approved committed artifact. Use when the user asks to plan something with otacon, types /otacon, or wants a reviewed implementation plan before coding. Replaces native plan mode. Dogfoods otacon on its own development.
---

<!-- Generated from src/cli/install/assets.ts (dogfoodSkillMd) — do NOT hand-edit;
     assets.test.ts guards that this file equals that output. Regenerate after any
     protocol change. -->

# Otacon plan session protocol (dogfooding this repo)

This repo **is** otacon. You plan features for it by running otacon's own CLI from
source via the \`./bin/otacon\` shim, so every command below exercises the code in
this checkout. That shim runs the CLI from \`src/\` via bun — no build needed; it
always reflects current source. The daemon auto-spawns from source on the first
command. Working state lives in the gitignored \`.otacon/\`; the approved plan is
committed to \`docs/plans/\`.

After editing **daemon** source (\`src/daemon/**\`) mid-session, restart the running
daemon so your change loads: \`./bin/otacon restart\` (the next command respawns it
from current source). Use \`./bin/otacon restart\`, not a raw curl to a fixed port —
in a git worktree the shim runs the daemon on a derived port, and \`restart\` always
targets the one this checkout talks to. CLI/linter/parser edits need no restart.

The spec these commands implement is otacon's own DESIGN.md (§6 loop, §8 grill, §13
failure habits); the canonical wrapper text lives in \`src/cli/install/assets.ts\`.

---

${protocolCard("./bin/otacon")}`;
}

/**
 * The Claude Code Stop hook (DESIGN.md §13): blocks ending the turn while an
 * open otacon session exists in the cwd's repo. Plain sh, fast, fail-open —
 * any failure (daemon down, curl missing, no match) allows the stop. With no
 * local pointer, the open session is found by scanning the daemon registry for
 * a non-approved session whose repo equals the cwd's git root (DESIGN.md §7).
 */
export const STOP_HOOK_SCRIPT = `#!/bin/sh
# otacon Stop hook — ${MANAGED_MARKER}; reinstall overwrites this file.
# Blocks Claude Code from ending its turn while the cwd's repo has an open
# otacon plan session (DESIGN.md §13). Fail-open by design: when anything here
# fails (daemon unreachable, curl missing, no match), the stop is allowed.
input=$(cat 2>/dev/null) || input=""
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
[ -n "$cwd" ] || cwd=$PWD
root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || root=$cwd
root=$(cd "$root" 2>/dev/null && pwd -P) || exit 0
port=\${OTACON_PORT:-4747}
list=$(curl -fsS --max-time 2 "http://127.0.0.1:$port/api/sessions" 2>/dev/null) || exit 0
# Split the compact registry array one session-object per line, keep this repo's
# open (non-approved) sessions, take the first id. The repo match is exact: the
# pattern includes the closing quote of the JSON value.
sid=$(printf '%s' "$list" | sed 's/},{/}\\
{/g' | grep -F "\\"repo\\":\\"$root\\"" | grep -v '"status":"approved"' | sed -n '1s/.*"id":"\\([^"]*\\)".*/\\1/p')
[ -n "$sid" ] || exit 0
printf '{"decision":"block","reason":"otacon plan session %s is still open — run otacon wait --timeout 540 (Bash timeout 600000 ms) and keep handling events until the plan is approved; run otacon status to re-orient."}\\n' "$sid"
exit 0
`;
