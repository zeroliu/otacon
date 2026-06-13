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

/** The protocol card — §6 full loop + §8 grill discipline + §13 failure habits. */
const PROTOCOL_CARD = `Run plan reviews through the otacon CLI instead of your native plan mode. The
user reviews in a browser — often a phone over Tailscale. Every \`otacon\`
command prints exactly one JSON line on stdout. Exit 0 = proceed; exit 1 = a
machine-readable error you can fix (read the JSON); exit 2 = you invoked it wrong.

## The loop

1. **Research the codebase first.** Read enough to propose answers, not collect
   questions.
2. \`otacon start --title <kebab-title>\` — mints the session, prints the review
   URL. Tell the user to open it (\`otacon open\` prints it again). \`--quick\`
   skips the interview — only when the user explicitly asks.
3. **Grill** (mandatory unless --quick): walk the design tree ONE question at a
   time, dependencies first. Explore the code before asking — never ask what the
   code can answer.
   - \`otacon ask --question "..." --options "A|B|C" --recommend A\` — always lead
     with your recommended answer. \`--multi\` for multi-select; omit \`--options\`
     for free text. The user can always answer with free-form custom text instead
     of (or alongside) the chips, so frame options as a starting point, not a cage.
   - Independent questions whose answers don't shape each other? Post them in one
     call: \`otacon ask --batch questions.json\` (or \`--batch -\` for stdin) — a JSON
     array of the same specs (\`{question, options?, recommend?, multi?}\`). They land
     as ordinary cards; loop \`wait\` to collect each answer. Dependent questions
     still go one at a time.
   - Park for the answer: \`otacon wait --timeout 540\` (set the Bash tool timeout
     to 600000 ms). The answer arrives as \`{"event":"answer","question":"q<n>",...}\`.
4. **Draft** the plan at \`.otacon/<session>/plan.md\` in the schema below, then
   \`otacon submit\`. On exit 1, fix every reported lint issue and resubmit until
   accepted.
5. **Review loop** — park in \`otacon wait --timeout 540\` (Bash timeout 600000 ms)
   and handle the one event it prints:
   - \`comments\` → revise plan.md; write \`resolutions.json\` as
     \`{"changelog":"what changed","threads":{"t1":"how you resolved it"}}\` with
     one reply per comment thread; \`otacon submit --resolutions resolutions.json\`
     (loop on lint errors); park again.
   - \`question\` → \`otacon answer <q-id> --body "..."\` (or \`--file\`); park again.
   - \`answer\` → use it and continue; park again whenever you are waiting.
   - \`timeout\` → park again immediately. A timeout is NEVER completion.
   - \`approved\` → \`git add\` + commit the plan file at the printed \`path\`, print a
     one-line summary, and STOP. Planning only — implementation is another
     session's job.
6. **Never end your turn while the session is open.** Nothing to do = park in
   \`otacon wait\` again. Confused, crashed, or compacted? \`otacon status\` returns
   the open session, revision, and pending events — resume the loop from it.

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

- Never use native plan mode, AskUserQuestion, or any built-in question UI while
  the session is open — every question goes through \`otacon ask\`.
- Dependencies first, one question at a time; only batch independent siblings.
  Recommended option first; the phone is the review surface.
- Long review ahead? Remind the user to keep the Mac awake: \`caffeinate -i\`
  while the session runs.
`;

/** ~/.claude/skills/otacon/SKILL.md and the OpenCode equivalent (same format). */
export function skillMd(): string {
  return `---
name: otacon
description: Plan a feature through an otacon review session — grill interview, schema'd plan, phone review with anchored comments, approved committed artifact. Use when the user asks to plan something with otacon, types /otacon, or wants a reviewed implementation plan before coding. Replaces native plan mode.
---

<!-- ${MANAGED_MARKER} — reinstall overwrites this file; the spec lives in otacon's DESIGN.md -->

# Otacon plan session protocol

${PROTOCOL_CARD}`;
}

/** The marker-delimited block upserted into ~/.codex/AGENTS.md. */
export function codexBlock(): string {
  return `${CODEX_BEGIN}

# Otacon plan sessions

When the user asks you to plan a feature "with otacon" (or to run a plan
review), follow this protocol exactly.

${PROTOCOL_CARD}
${CODEX_END}`;
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
