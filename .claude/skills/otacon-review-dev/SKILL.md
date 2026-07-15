---
name: otacon-review-dev
description: Explain and interactively review a GitHub pull request while developing THIS Otacon repo, using the source CLI, personalized report, adaptive quiz, anchored threads, explicit code-change handoff, and local knowledge. Use when the user types /otacon-review-dev or asks to dogfood PR review behavior from this checkout.
---

<!-- Generated from src/cli/install/assets.ts (dogfoodReviewSkillMd) — do NOT hand-edit;
     assets.test.ts guards exact parity. Regenerate after any protocol change. -->

# Otacon PR review protocol (dogfooding this repo)

This repo **is** Otacon. Run every command through the `./bin/otacon` source
shim. After editing `src/daemon/**`, run `./bin/otacon restart` before the next
protocol command so the isolated worktree daemon loads the change. Do not use a
fixed raw HTTP port.

---

Explain one GitHub pull request through Otacon's shared browser UI, then
stay with the reviewer until that review is terminal. Every `./bin/otacon` command
prints one JSON line. Exit 0 = proceed; exit 1 = fix the reported condition;
exit 2 = fix the invocation.

## Start in the PR repository

1. Require the user's PR URL or number and run inside its target git repository.
   Do not create a session from another directory. Run
   `./bin/otacon review start --pr <URL-or-number>`; pass `--force` only when the user
   explicitly asks to restart or review from scratch.
2. Reuse the returned session. The same unchanged PR opens its existing review;
   a changed head reopens that session with a new head revision; `--force` alone
   creates an independent session. Never substitute a second daemon or session.
3. Open the returned `url` and tell the user it is ready. If the response is
   `readOnly:true`, the persisted completion is the earlier `review-done`
   terminal result: show the historical review and stop without rewriting it.
   If it says `authoring:false`, the unchanged active report is already
   submitted: open it and enter the event loop without overwriting that revision.

## Author the review

For an active preparation, read both frozen knowledge files under
`knowledge.snapshot` completely before writing. Treat them as personalization,
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
   `### Interface changes —`, `### Integration path —`, or
   `### Implementation walkthrough —`; include at least one of each, in that
   order. Within each group, order by cause and dependency, not filename or
   patch order. Include these exact labels in every group:
   `**Purpose:**`, `**Changed behavior:**`, and `**Surfaces:**` with concrete
   `file#symbol` references.
4. **Quiz** — summarize what the questions verify; keep private rubrics and keys
   only in the companion JSON.

Write the report to the returned `report` path with exactly this section order:
`## Background`, `## Intuition`, `## Code`, `## Quiz`. Its frontmatter is
exactly these scalar keys in order: `type: otacon-pr-review`, `version: 1`,
`session`, `revision`, `pr` as `github.com/owner/repo#number`, `head`,
`knowledge-snapshot`, and `altitude`. Copy every identity/hash value from the
preparation and resolved PR; do not infer one. Choose `expert` altitude only
when the frozen Project evidence shows architectural familiarity; otherwise
choose `balanced`. Write the quiz companion to
the returned `quiz` path: version 1, the same session/report/head identity, and
1–20 complexity-driven questions. Each question contains `id`,
`concept:{id,label,scope}`, `prompt`, `mode`, and
`rubric:{criteria:[...]}`; choice mode additionally contains `options` and
`answerKey`. Prefer open-ended questions that make the
reviewer explain the idea in their own words. Use a choice question only for a
genuinely crisp distinction. Give each question one concept, a User or Project
scope, and private, concrete rubric criteria. Never expose a rubric or answer key
in the report, browser response, or thread answer.

Run `./bin/otacon review submit --report <report-path> --quiz <quiz-path>`. Fix every
reported lint or identity error and resubmit. Then park with
`./bin/otacon wait --session <id> --timeout 540` (use a 600000 ms tool timeout).

## Handle review events

Handle exactly one returned event, then park again:

- `quiz-answer`: Compare the answer with every private rubric criterion and the
  code. Write a grade JSON containing exactly `version:1`, `session`,
  `revision`, `headRevision`, `headSha`, `question`, `attempt`,
  `verdict`, `feedback`, and `knowledgeBaseHash` copied from
  `knowledge.baseHash`. Choose `pass` only when the answer satisfies every
  rubric criterion; otherwise choose `retry`, say what the reviewer got right
  and what still needs correction, and invite another answer without revealing
  a model answer. Run
  `./bin/otacon review grade <question> --file <grade.json>`. The daemon records
  successful quiz evidence in the requested knowledge scope; never manufacture
  a pass or edit evidence by hand.
- `review-thread` with `work:"question"`: Answer the question only; do not
  revise the report or touch code. Write the strict response JSON and run
  `./bin/otacon review respond <thread> --file <response.json>`.
- `review-thread` with `work:"report-feedback"`: Treat this as feedback on the
  explanation, not permission to edit code. If it carries `remember`, perform
  the requested knowledge CAS first so the replacement report freezes the
  updated summary. Then run `./bin/otacon review revise --session <id>`, read the new
  frozen knowledge snapshot, revise the whole report and quiz at the returned
  paths, submit them, then respond with the newer submitted
  `responseReportRevision` and the saved receipt only when that CAS succeeded.
- `review-thread` with `work:"code-change"`: This event is the explicit second
  step from a persisted Comment and the only thread event that authorizes code
  edits. Mark it `working` with `./bin/otacon review code-status`, then run
  `./bin/otacon review checkout --session <id>`. If checkout reports a fork,
  insufficient permission, a stale/dirty worktree, or any read-only path, make
  no mutation; explain the advice and mark the action `failed`.

For a question carrying `remember`, complete the scope-matching knowledge
update below before answering. The report-feedback rule above performs the same
update before `review revise`. A later code-change event reuses that Comment's
existing acknowledgement; never record the same exchange twice.

Response files contain exactly `version:1`, `session`, `thread`,
`source:{reportRevision,headRevision,headSha}`, and `body`, plus only the
applicable `responseReportRevision` and requested `saved` receipt. Code-status
files use the same version/session/thread/source identity plus `status` and an
optional non-empty `message`. Copy every identity field from the private event;
never guess current values.

For an authorized code change, remain the orchestrator. Spawn one native
implementation subagent in the exact returned worktree and scope it to the
Comment. Do not implement the change in the main agent. After the subagent
returns, the main agent reviews its diff, runs the relevant tests, commits, and
pushes only to the returned remote/ref. Then run
`./bin/otacon review refresh-head --session <id>`, rebuild and submit the personalized
report/quiz for the new head, and mark the code action `completed`. On any
failure, preserve the worktree and mark it `failed` with an actionable message;
never reset, force-push, or silently switch branches.

## Remember requested knowledge

A thread's `remember.scope` is a request, not a receipt. Before responding, use
`./bin/otacon knowledge get --scope user|project`, edit only the high-level Markdown
summary, then use `./bin/otacon knowledge put` with the returned base hash. In Project
scope, omit `--repo` while cwd is the target repository or pass its local clone
root as `--repo <root>`; never pass `owner/repo` to that path flag. Add
`saved:{scope,updated:true}` to the response only after that exact write
succeeds. Preserve the distinction between exposure (files/functions reviewed)
and demonstrated understanding (quiz evidence).

## Finish

- `review-done`: the reviewer ended this session. Report the completion and stop.
- `deleted`: the reviewer deleted this session. Stop.
- `timeout`: park again immediately.

Never end the turn while an active review is open. A quiet queue is not
completion. If interrupted or compacted, run `./bin/otacon status`, recover the review
session for this repository, and continue waiting until `review-done` or
`deleted`.
