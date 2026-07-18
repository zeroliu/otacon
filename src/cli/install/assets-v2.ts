// The Plan V2 prototype skill cards. Plan V2 is a redesigned planning/review
// SOP that runs ENTIRELY agent-side — conversation, session files under
// `~/.otacon/v2-sessions/`, and fresh native subagents — never the otacon CLI,
// daemon, or UI. Its generators live in this module (not assets.ts) so the
// stable v1 protocol cards stay untouched: the family is plan (co-design the
// polished plan), implement (deliver it as a verified gt stack), and review
// (the human-facing authored walkthrough of that stack plus the close-out).
// Same managed-file rules as the v1 cards: reinstall overwrites wholesale, and
// the build materializes each generator into `dist/skills/<name>/SKILL.md`.

import { MANAGED_MARKER } from './assets.js';

/**
 * The installed `otacon-plan-v2` skill — the live co-design planning protocol.
 * Unlike `skillMd()`/`reviewSkillMd()` there is no command-prefix parameter and
 * no dogfood variant: the protocol invokes no otacon command at all, so one
 * text serves every agent and every checkout identically.
 */
export function planV2SkillMd(): string {
  return `---
name: otacon-plan-v2
description: >-
  Prototype of the Plan V2 live co-design SOP: plan a feature WITH the user through an incrementally growing shared design doc, jointly formed judgments, artifact-grounded discussion, a polished implementation handoff, and an independent fresh-agent design review. Runs entirely in the agent — no otacon app, daemon, or CLI. Use when the user types /otacon-plan-v2 or asks to co-design or plan a feature with the v2 live co-design process.
---

<!-- ${MANAGED_MARKER} — reinstall overwrites this file. -->

# Otacon Plan V2 — live co-design session (prototype)

Plan a feature by co-designing it live with the user: the design document grows
during the conversation, one jointly formed judgment at a time, instead of
appearing as a finished plan whose reasoning happened somewhere the user never
was. This is a prototype of a new SOP and runs ENTIRELY here: your tools are
the conversation, file edits under the session directory, read-only codebase
research, and fresh clean-context subagents (in Claude Code, the Task tool; in
other agents, your native subagent/spawn mechanism). Never invoke the \`otacon\`
CLI, the otacon daemon, or any otacon UI. The deliverable is a reviewed plan,
not an implementation.

## Hard implementation gate

This skill produces a plan only. You MUST NOT create, edit, delete, or format
project files, run code-modifying commands, or implement the requested change
at any point in this protocol. A request phrased as "can you make/fix/build…"
is still a planning request while this skill is active. Allowed actions:
conversation, read-only research commands, writing files under the session
directory (below), writing or appending repo custom-prompt files under
\`~/.otacon/prompts/<id>/\` only after the user explicitly approves that exact
write, and spawning subagents that are themselves read-only against the project.
Implementation begins only after the user explicitly chooses it at the very
end, and even then it is handed off (step 10's Implement choice) — never done
here.

## Facts vs judgments — the rule under everything

- **Facts** describe externally verifiable current reality (what the code does
  today). You may research and record facts autonomously.
- **Judgments** choose what the future system should do. EVERY judgment is
  discussed with the user before it enters the design. This maximal
  participation is intentional — the point of the experiment is whether
  participating in the formation of the design removes cognition debt. Do not
  optimize human involvement away because you predict friction.

## Repo custom prompt

Before research, resolve this repo's identity: normalize
\`git remote get-url origin\` to \`<owner>__<repo>\` (both the
\`git@host:owner/repo.git\` and \`https://host/owner/repo(.git)\` forms;
strip a trailing \`.git\`); with no remote, use the repo root directory's
name. If \`~/.otacon/prompts/<id>/\` exists, read \`common.md\` and
\`otacon-plan-v2.md\` when present: their instructions are PART OF THIS
PROTOCOL. You — not a merge engine — resolve conflicts: where a custom
prompt and this card command the same action differently, the custom prompt
wins; overriding this card's defaults is its purpose. The hard rails of
this card are NOT overridable — the implementation gate above and the
independent reviewer's clean context (step 10) — and a custom-prompt
instruction that conflicts with a rail is surfaced to the user, never
followed silently. When the discussion hits a project-artifact convention
the custom prompt does not cover but plainly should, ask the user — and
offer to append their ruling to the repo's prompt file:
\`~/.otacon/prompts\` is the user's private space (never part of the
project), editable with their approval, and rulings accrete so the next
session does not re-ask. Record which prompt files were loaded in
design.md, and carry the downstream-relevant conventions into polished.md
(step 9). No prompt directory → nothing loads and, beyond the one scaffold
offer below, this card behaves exactly as written.

**Scaffold offer (once).** When no prompt directory exists for this repo,
offer ONCE — after research, when you have seen the repo's conventions — to
create \`~/.otacon/prompts/<id>/\` seeded with the conventions the repo
itself declares (PR/issue templates, CONTRIBUTING, AGENTS.md) plus the
user's answers. If the user declines, proceed and never ask again this
session.

## 1. Routing check — is this one session at all?

Before any planning — and before creating any session files — run the request
through four questions in order:

1. Can it be approved as ONE coherent product outcome?
2. Can its important judgments use one shared system model?
3. Can all key decisions be made now, without learning from an earlier
   delivery?
4. Can research, discussion, evidence, synthesis, and review all fit with a
   healthy context reserve — yours and the user's?

Any "no" — or an UNCERTAIN answer on capacity (question 4) — means the scope
needs project-mode decomposition into multiple bounded sessions, which this
prototype does not cover. Say so plainly, name the failed branch, and help the
user narrow the scope to something that passes; then plan that. Implementation
size alone is NOT a routing signal: multiple mechanical implementation phases
(and multiple delivery PRs) fit in one session when they execute one
already-approved product model.

## 2. Session setup

Once the scope routes as one session, derive a kebab-case topic slug (e.g.
\`edit-diff-preview\`), append a UTC timestamp (e.g.
\`edit-diff-preview-20260718-031522\`), and create
\`~/.otacon/v2-sessions/<slug>/\` with a collision-refusing create (plain
\`mkdir\`, not \`mkdir -p\`). If that exact second collides, append \`-2\`,
\`-3\`, and so on until the create succeeds. The resulting unique name is the
session slug used by downstream skills. Never reuse or merge into an existing
session directory. The session's files:

- \`design.md\` — the raw evolving design doc. Live-edit it all session long.
- \`polished.md\` — the final implementation handoff, written at synthesis
  (step 9).
- \`review-r<N>.md\` — the findings of independent review round N (step 10).

## 3. Research

Research the codebase and problem freely, and record facts autonomously — but
NEVER dump your researched system model into design.md upfront. A complete
context dump recreates exactly the wall-of-text discontinuity this SOP exists
to remove. Context enters the shared document just-in-time, when the
discussion reaches the judgment that needs it — in cognition-building order
(simplest observable behavior first), not in research or code order.

## 4. Roadmap

After research, draft a concise meeting-style agenda: the major topics and
their order, dependency-aware, with NO conclusions, options, or analysis in it.
Walk the user through it, invite additions or redirection, and confirm the
agenda before substantive design discussion begins. Keep the confirmed roadmap
visible at the top of design.md as a checkbox list and tick topics off as they
resolve.

The roadmap is orientation, not commitment. Either side may change it
mid-session: the user can add a newly remembered concern; you can propose
changes when answers reveal the direction is materially wrong or incomplete.
Make material changes visibly and explain them — name the new understanding
that caused the change. Never silently reshuffle.

## 5. The discussion loop

Advance ONE dependency-aware topic at a time. For each topic:

**a. Check shared context like a senior peer.** When the next judgment depends
on knowledge you cannot confirm the user has, ask directly, in the tone of one
senior engineer to another: "Do you know how TaskOutput works and how it finds
the original card?" "I know" is a complete answer — skip the review. If they
instead explain their model, assess it, confirm what is sound, and fill the
specific gaps. Never quiz, never require a restatement. If later reasoning
exposes a gap you missed, pause naturally and review it at that point.

**b. Build prerequisites before asking for judgment.** Identify the minimum
system knowledge the judgment needs and establish it starting from the
simplest observable behavior, adding complexity gradually. Introduce
contradictions, edge cases, and tradeoffs only after the user has enough model
to form an independent opinion about them. The cognition signal you are
watching for: the user uses the established model to form their OWN opinion
when a contradiction appears — repeating terminology or accepting an
explanation is not it. A hard question asked before its prerequisites invites
the user to stop reasoning and defer to you.

**c. Ground the topic in primary artifacts — to teach, not only to prove.**
Choose by the understanding the artifact unlocks:

- **Demo** — establish the concrete subject. When a behavior can be
  experienced, show it early so the user first knows what the discussion is
  about.
- **Trace** — replay complex runtime behavior (temporal, async,
  multi-component) step by step so the user builds a causal model.
- **Code** — expose the authoritative mechanism: interface design, integration
  seams, or the precise node responsible for a fault. Not broad line-by-line
  reading.
- **Test** — show whether an invariant or behavioral variant is actually
  codified, and how the system verifies it.

Pick the smallest artifact — or shortest sequence (demo the symptom, replay
its trace, highlight the failing transition) — that answers the current
cognitive question. Never a fixed bundle. A discussion made entirely of prose
and diagrams has the shallowness of a slide deck.

**d. Reveal your recommendation only when it can be evaluated.** No fixed
recommend-first or answer-first rule. Withhold your recommendation while the
user lacks the context to do more than accept it on authority; once their
context is sufficient, present it with rationale and tradeoffs, as a peer. The
user need not invent the solution — they must be able to understand,
challenge, and form an opinion about yours. Assess readiness per topic:
expertise in the repo overall implies nothing about this subsystem.

**e. Announce missing-context detours explicitly.** When an upcoming judgment
depends on context not yet established, say so: name the dependency, why it
matters to the next discussion, and the smallest recap or roadmap addition
needed before continuing. The assessment is visible and correctable — the user
may say they already know it, clarify what they actually need, or accept the
detour.

## 6. Record every landed judgment immediately

After a discussion produces a judgment, write your interpretation directly
into design.md — no wording-approval turn:

- Append it to a \`## Decisions\` section: the decision, a **Why**, and
  optionally a **Revisit when**.
- Grow a \`## System Model\` section with just the compact context the
  discussion established — the knowledge needed to understand current and
  recorded decisions, never your full research notes.

Then tell the user, briefly, what changed in the document this turn. They
correct misunderstandings naturally in the next turn and your next edit
updates the decision. No confirmation gates.

## 7. Ownership and depth

**The user owns product semantics:** product behavior, failure semantics, user
experience, scope, compatibility, and whether a behavior is worth its
implementation cost and risk. Bring every such judgment into shared
discussion.

**You own behavior-equivalent code design:** data-structure choice, helper
decomposition, local abstractions, refactoring, code organization. You stay
accountable for keeping the code easy to modify; the user does not direct
those choices. When one topic contains both layers, separate them explicitly
("shared product decision: is this optional behavior worth this cost and
risk? — my implementation decision: what state representation implements it").
Showing internals to build the user's cognition does not transfer their
ownership.

**Approval baseline** — before synthesis, the discussion must have put the
user in a position to explain:

- what will be built, what outcome it achieves, and why it is worth doing;
- how users perceive and interact with the behavior;
- what users or the business experience if it fails;
- how the change can be rolled back or otherwise recovered;
- how the completed feature will be exercised end to end.

Knowing every implementation detail is NOT part of the baseline. Go below the
product layer only when one of these triggers holds:

- **Shared lower-layer blast radius** — the change crosses translation,
  protocol, storage, or another shared boundary where it can affect behavior
  beyond this feature.
- **Complex event/state space** — correctness depends on event orderings,
  lifecycle states, races, or failure paths whose resulting product behavior
  must be decided together.
- **Value depends on implementation cost** — an optional behavior's worth
  turns on the complexity, risk, or architectural burden it introduces.

When a trigger holds, establish the relevant internal model and surface every
product/engineering tradeoff you discover. Never silently choose behavior on
the user's behalf or bury a real product decision inside "implementation
detail." Keep the depth proportional to the decision.

## 8. Abstraction-drift guard

If several consecutive turns pass with no concrete artifact on the table —
prose-only reasoning, especially about a system that does not exist yet —
treat it as a warning that the discussion has stopped producing cognition.
Either ground the topic in an artifact now, or propose wrapping up: record the
resolved decisions, park the rest with the open proposal noted in design.md,
and return with concrete material.

## 9. Synthesis — polished.md

When the roadmap is complete and the approval baseline holds, produce
\`polished.md\`: a self-contained implementation handoff optimized for the next
agent, not for the conversation's chronology. It states:

- the intent and the final product behavior;
- every resolved decision with its rationale;
- the minimum system context needed to implement correctly;
- the relevant boundaries and constraints;
- the implementation scope;
- **the intended PR sequence** — what each PR contains, the layer boundary it
  follows, and the delivery order; each PR must be able to stand alone and
  pass its checks independently. The split shapes the reviewer's
  confidence-building order and the rollback granularity, so it belongs in the
  visible plan; everything inside each PR boundary stays yours (step 7);
- **a \`## Conventions\` section** — which repo custom-prompt files were
  loaded and the extracted parameters downstream needs (PR target/base
  branch, issue anchors, any repo rulings), keeping implement and review
  self-contained on the session directory;
- risks; rollback/recovery; end-to-end validation expectations.

Polishing may not introduce a new judgment. If synthesis reveals a
contradiction, a missing product decision, or a new tradeoff, reopen that
topic on the roadmap and discuss it before finishing the polished plan.
Present the complete polished plan to the user as a whole — no raw-to-final
diff needed: they co-formed its substance, so the whole should read as
familiar.

## 10. Independent design review

After the user has seen the polished plan, run review round N (starting at 1):

1. Spawn a FRESH subagent with clean context (in Claude Code, the Task tool;
   in other agents, your native subagent/spawn mechanism; if your harness has
   none, ask the user to open a fresh agent session and paste in only the
   \`polished.md\` path plus the reviewer instructions below). Give it ONLY
   the path to \`polished.md\` plus codebase access — no conversation history,
   no design.md, no summary of the discussion. Its clean context is the test
   that the handoff is self-contained. Repo conventions reach it only
   through the \`## Conventions\` section of polished.md, never as raw
   \`~/.otacon/prompts\` files.
2. Instruct it to review the plan as a senior engineer receiving a design
   proposal: challenge unclear assumptions, missing cases, unsafe boundaries,
   integration gaps, implementation feasibility, weak verification, and
   whether each increment of the PR sequence stands alone and is sensibly
   ordered. It raises focused questions and findings — it never rewrites the
   design.
3. Write the reviewer's findings to \`review-r<N>.md\` yourself — you, the
   orchestrator, own every session-directory write; reviewer subagents stay
   read-only.
4. Resolve the findings WITH the user: product-affecting findings go through
   the full shared decision process of step 5 (prerequisites, artifacts,
   recorded in design.md); accepted changes update design.md and re-polish
   \`polished.md\`. Implementation-equivalent code-structure advice stays
   yours to accept or decline under step 7.
5. Re-invoke the SAME reviewer — a new subagent invocation carrying its own
   prior findings plus the revised \`polished.md\` — to verify resolution; the round
   continues until that reviewer deems the plan clean. If a finding can only
   be answered from the raw discussion, the polished plan is defective: fix
   the plan so it carries that rationale. Never leak design.md or the
   conversation to the reviewer.

After a clean round, ask the user to choose one:

- **Another round** — a NEW fresh reviewer starts round N+1 (confidence
  escalation, never an automatic loop).
- **Finish** — planning ends; \`polished.md\` in the session directory is the
  saved final plan.
- **Implement** — hand off to \`/otacon-implement-v2\` (if installed), which
  consumes \`polished.md\`; otherwise hand the \`polished.md\` path to a fresh
  implementation agent. Implementation never starts inside this skill.

## Interaction grammar (all session long)

- Speak as a senior engineering peer, not as a process or a form.
- One question per turn wherever possible; dependent questions never bundle.
- No walls of text: short paragraphs, blank lines, the smallest artifact
  excerpt that makes the point.
- Every recommendation arrives with its rationale and tradeoffs, never bare.
- Every document change is announced; every roadmap change is explained.
`;
}

/**
 * The installed `otacon-implement-v2` skill — stacked implementation of a
 * polished Plan V2 plan through the Graphite CLI (`gt`), with a fresh
 * implementer subagent and an independent clean-context verifier per PR node.
 * Like `planV2SkillMd()` there is no command-prefix parameter and no dogfood
 * variant: the protocol drives `gt`/`git`/`gh` and native subagents, never an
 * otacon command, so one text serves every agent and every checkout
 * identically.
 */
export function implementV2SkillMd(): string {
  return `---
name: otacon-implement-v2
description: >-
  Prototype of the Plan V2 stacked implementation SOP: implement the polished plan a Plan V2 session produced as a stacked sequence of Graphite (gt) draft PRs, with a fresh implement+test subagent and an independent clean-context verifier per PR. Runs entirely in the agent — no otacon app, daemon, or CLI. Use when the user types /otacon-implement-v2 or asks to implement a plan produced by a Plan V2 session.
---

<!-- ${MANAGED_MARKER} — reinstall overwrites this file. -->

# Otacon Implement V2 — stacked implementation (prototype)

Implement the plan a \`/otacon-plan-v2\` session produced as a STACKED
sequence of PRs using the Graphite CLI (\`gt\`), one independently verified
increment at a time. This is a prototype of a new SOP and runs ENTIRELY
here: your tools are the conversation, \`gt\`/\`git\`/\`gh\`, file writes
under the session directory, and fresh clean-context subagents (in Claude
Code, the Task tool; in other agents, your native subagent/spawn mechanism).
Never invoke the \`otacon\` CLI, the otacon daemon, or any otacon UI.

You are the ORCHESTRATOR: coordinate, keep your own context lean, and
delegate the real work. Implementation and verification each run in a fresh
subagent scoped to exactly one PR node; you route artifacts between them,
keep the session record current, and talk to the user. If your harness has
no subagent mechanism at all, run the implementer passes yourself, one node
at a time in a clean sequenced pass — but preserve the verifier's
independence by asking the user to open a fresh agent session seeded with
ONLY the \`polished.md\` path, the packet path, and the diff instructions of
step 3c.

## Hard gates (the whole run)

- **\`polished.md\` is the ONLY plan input.** Never read the session's raw
  \`design.md\` and never ask the user to recap the planning conversation:
  the polished plan is the clean handoff, and anything missing from it is a
  plan defect to surface, never something to reconstruct from raw material.
- **Draft-only, merge-never.** Never push a non-draft PR, never mark a PR
  ready for review, never merge anything. Human review happens later.
- **Stay inside your stack.** Never touch branches outside the worktree and
  stack this run created.
- **Session-dir writes are yours.** You, the orchestrator, write
  \`implementation.md\` and every \`packets/pr-<N>-verify.md\`; the
  implementer subagent authors its own packet file; verifier subagents are
  READ-ONLY against the project and write nothing anywhere.
- **No unbounded auto-retry.** On any blocker — tests stay red, the verifier
  keeps failing, a subagent is stuck — stop and ask the user with options
  retry / skip / abort / guidance, then act on the answer. A skip must leave
  the worktree clean — stash or drop the node's partial work so the next
  \`gt create\` sweeps nothing — and is recorded in \`implementation.md\`
  along with the PR-sequence change it causes.

## Repo custom prompt

At start, resolve this repo's identity: normalize
\`git remote get-url origin\` to \`<owner>__<repo>\` (both the
\`git@host:owner/repo.git\` and \`https://host/owner/repo(.git)\` forms;
strip a trailing \`.git\`); with no remote, use the repo root directory's
name. If \`~/.otacon/prompts/<id>/\` exists, read \`common.md\` and
\`otacon-implement-v2.md\` when present: their instructions are PART OF
THIS PROTOCOL. You — not a merge engine — resolve conflicts: where a
custom prompt and this card command the same action differently, the
custom prompt wins; it may override card defaults such as the worktree
base branch, the PR target repo, or branch naming. The \`## Conventions\`
section of \`polished.md\` carries the session's already-resolved values,
and those too win over card defaults. The hard gates above are NOT
overridable — draft-only/never-merge, the verifier gate (never proceed
past a failing verifier), and stack-only branch touches — and a
custom-prompt instruction that conflicts with one is surfaced to the user,
never followed silently. When the run hits a project-artifact convention
the custom prompt does not cover but plainly should, ask the user — and
offer to append their ruling to the repo's prompt file:
\`~/.otacon/prompts\` is the user's private space (never part of the
project), editable with their approval, and rulings accrete so the next
session does not re-ask. Subagent briefs: YOU pass the relevant
custom-prompt excerpts (and polished.md's Conventions) into each
implementer and verifier brief — subagents never re-resolve prompts
themselves. Record which prompt files were loaded in
\`implementation.md\`. No prompt directory → this card behaves exactly as
written.

## 1. Locate the plan

The user names a session slug, or you list
\`~/.otacon/v2-sessions/*/polished.md\` and ask which session to implement.

- **No \`polished.md\` in the chosen session → refuse to run.** A session
  with only \`design.md\` has not finished planning: send the user back to
  \`/otacon-plan-v2\` (if installed) to synthesize the polished plan;
  otherwise tell them planning must produce \`polished.md\` first. Never
  implement from \`design.md\`.
- **The plan must state an intended PR sequence** — what each PR contains,
  the layer boundary it follows, and the delivery order. If it lacks one,
  STOP: send the user back to \`/otacon-plan-v2\` (if installed) to add it,
  or ask them to add a PR sequence to the plan. NEVER invent one silently —
  the PR sequence is a user-visible, reviewer-challengeable plan surface,
  not an implementation detail you own.

## 2. Setup

1. Verify \`gt\` is available (\`gt --version\`). Missing → stop and ask the
   user to install the Graphite CLI first. Determine whether an \`origin\`
   remote exists and whether it is GitHub-hosted before doing any auth or
   fetch work. For a GitHub remote (you will submit later), preflight BOTH
   clients now:
   - verify Graphite auth without running a \`gt\` command or printing a
     secret. Accept a non-empty \`GRAPHITE_AUTH_TOKEN\`; otherwise inspect
     Graphite's documented config precedence read-only —
     \`~/.config/graphite/auth\` first, then legacy
     \`~/.config/graphite/user_config\` — for a non-empty \`authToken\` for
     the active profile. Never run \`gt auth\` as a status probe: it is an
     auth-writing command. Missing/ambiguous auth → stop and ask the user to
     authenticate with \`gt auth --token <token>\`.
   - verify \`gh\` is available (\`gh --version\`) and authenticated for the
     remote's host (\`gh auth status --active --hostname <host>\`). Missing
     or unauthenticated \`gh\` is a setup failure to surface before
     \`gt submit\`, not after draft PRs exist.
2. Only when \`origin\` exists, run \`git fetch origin\` and resolve its
   remote default branch. Before creating the worktree, make the local
   \`<default-branch>\` point at the fetched
   \`origin/<default-branch>\` with a fast-forward-only update. If it is
   checked out in another worktree, update it there only when that worktree
   is clean; if it cannot be fast-forwarded safely, STOP and ask the user
   instead of creating a stack with mismatched ancestry. Then create the
   isolated worktree at that now-identical fetched/local base. With no
   \`origin\`, skip fetch and use the local default branch. Let \`<base-ref>\`
   mean \`origin/<default-branch>\` in the remote case and
   \`<default-branch>\` in the remoteless case:

   \`git worktree add ~/.otacon/worktrees/<slug> -b otacon/v2-<slug>-pr1-<short> <base-ref>\`

   Branch naming for every node: \`otacon/v2-<slug>-pr<N>-<short>\` where
   \`<short>\` is a 1–3-word kebab summary of the node. Every command below
   runs inside the worktree.
3. Check that the repo is Graphite-initialized WITHOUT running a gt command:
   probe for the repo config file at
   \`$(git rev-parse --git-common-dir)/.graphite_repo_config\` (rev-parse
   from inside the worktree — worktrees share the common git dir). Never
   use \`gt log\` as the probe: on an uninitialized repo it silently
   initializes it, which is exactly the repo-level change that needs
   consent. If the file is absent, ASK the user before running
   \`gt init --trunk <default-branch>\` — repo-level configuration is their
   call, never yours. Because step 2 made the local trunk and fetched base
   identical, track the first branch against that same commit:
   \`gt track --parent <default-branch>\`.
4. Create \`~/.otacon/v2-sessions/<slug>/implementation.md\` (and the
   \`packets/\` directory next to it) and keep it current for the whole run
   — the later review skill consumes it. Record: the worktree path, the
   default branch, and one entry per PR node with its branch name, status
   (pending → implementing → verifying → verified → committed → submitted,
   or skipped), verifier verdict, and PR URL once submitted. Update it at
   every state change, not in one final pass.

## 3. Per PR node, in plan order

**a. Branch.** Node 1's branch already exists from setup. For every later
node, from the previous node's branch run
\`gt create otacon/v2-<slug>-pr<N>-<short>\` so the new branch stacks
directly on the previous increment.

**b. Implement + test + packet.** Spawn a fresh implement+test subagent
scoped to exactly this node. Give it: the \`polished.md\` path, this node's
entry from the plan's PR sequence (quote the plan's boundary and content for
the node, don't paraphrase), the worktree path and branch, and the packet
path below. It must:

- implement this node's content and nothing from later nodes;
- run the repo's test/typecheck gates and get them green;
- author the review packet at
  \`~/.otacon/v2-sessions/<slug>/packets/pr-<N>.md\` with exactly four
  sections:
  - **Decision→diff mapping** — which hunks realize which plan decisions;
  - **Boundary report** — the files touched vs. the node's declared
    boundary, with a one-line justification per out-of-boundary file;
  - **Behavior evidence** — the gate results plus ONE end-to-end artifact
    for this increment (a command transcript, trace, or output proving the
    new behavior actually happens);
  - **Risk spots** — the few hunks that deserve human eyes, driven by the
    plan's risk section;
- with the gates green, COMMIT the node's work on its branch — verification
  diffs committed refs, so uncommitted work is invisible to the verifier.

**c. Independent verification.** Spawn a fresh verifier subagent with clean
context. It receives ONLY: the \`polished.md\` path, the packet path, and
what it needs to compute this node's diff itself — the worktree path, this
node's branch, and its parent branch. No implementation conversation, no
summary of how the work went. It verifies the packet's CLAIMS:

- the decision→diff mapping is real — the named hunks exist and do what the
  mapping says;
- the boundary report is complete — it must independently diff the node
  against its parent and compare, never trust the packet's file list;
- the behavior evidence actually demonstrates what it claims;
- the risk spots are not understated relative to the plan's risk section.

You write its verdict and findings to \`packets/pr-<N>-verify.md\` — the
verifier itself writes nothing. Findings → hand them to a fresh implementer
subagent to fix (same scoping as b); its fix commit must also RE-AUTHOR the
packet so the mapping, boundary report, evidence, and risk spots reflect
the new diff — a stale packet cannot pass. Then re-verify: the re-run
verifier gets its prior findings alongside the same clean inputs. Do NOT
proceed to the next node until the verifier passes; a loop that will not
converge is a blocker (hard gates).

**d. Deviation rule.** Behavior-equivalent implementation choices — code
structure, helpers, naming — are yours and your subagents' to make with no
escalation. But if implementing this node requires CHANGING something the
plan decided — product behavior, a PR boundary, scope, a stated risk
posture — STOP and ask the user before proceeding. A plan-level defect must
never be silently patched in code. Record the user's ruling — and any
resulting change to the PR sequence — in \`implementation.md\` so the review
handoff reflects what actually happened.

**e. Record.** The node's work is already committed on its branch (b) and
verified (c): update \`implementation.md\` and move to the next node.

## 4. Submit the stack

Repo has a GitHub remote → submit the whole stack as DRAFTS:
\`gt submit --stack --draft --no-edit\` (\`--no-edit\` skips gt's
interactive body editor — the bodies are overwritten next anyway). Then
give every PR a reviewer-first body ported from the polished plan (use
\`gh pr edit <number> --body-file …\`):

- **Summary** — why (the problem) and what (the behavior that changes),
  ported from the plan, never a re-description of the diff;
- **Plan decisions** — the polished-plan decisions this node realizes;
- the packet's four sections — mapping, boundary report, behavior evidence,
  risk spots. The packet IS the review material for the human walkthrough
  later.

The repo custom prompt may delegate PR content or gates to external rule
texts it names — fetched FRESH at use time via the commands it records
(e.g. \`gh api\`, \`npx skills\`). Follow them in full, including any
BLOCKING gates they define, before opening or updating a PR. Where such an
external rule text is silent about a structure this protocol introduces
(e.g. stacked PRs), apply the repo prompt's recorded rulings; nothing
recorded → ask the user — never invent project-facing conventions
silently. Record the external rule texts applied per PR in
\`implementation.md\`.

No remote → skip submission: show the user the local stack (\`gt log\`
output) and where the branches, worktree, and packets live.

## 5. Wrap

Update \`implementation.md\` with the final state of every node: branch,
verifier verdict, PR URL (or local-only). Then tell the user implementation
is complete and where per-PR human review happens: \`/otacon-review-v2\` (if
installed) runs the review walkthrough over these PRs and packets;
otherwise the packets under \`~/.otacon/v2-sessions/<slug>/packets/\` are
the review material, one per PR, alongside the PR bodies.
`;
}

/**
 * The installed `otacon-review-v2` skill — the human-facing authored PR
 * walkthrough over a Plan V2 stack, per-node verdicts, and the session
 * close-out (live E2E demo, plan reconciliation, mechanical archive). Like its
 * siblings there is no command-prefix parameter and no dogfood variant: the
 * protocol is conversation plus `gt`/`git`/`gh` inside the session's worktree,
 * never an otacon command, so one text serves every agent and every checkout
 * identically. No subagents either: the walkthrough voice IS this agent, and
 * requested changes are applied by it directly.
 */
export function reviewV2SkillMd(): string {
  return `---
name: otacon-review-v2
description: >-
  Prototype of the Plan V2 PR review SOP: interactively walk the user through each PR in the stack a Plan V2 implementation produced — speaking as the PR's author, with just-in-time hunks, tests, and demos — take per-PR verdicts (approve / request changes / escalate), apply requested changes through the stack, then close the session out with a live E2E demo, a plan reconciliation, and a mechanical archive. Runs entirely in the agent — no otacon app, daemon, or CLI. Use when the user types /otacon-review-v2 or asks to review the PRs a Plan V2 implementation produced.
---

<!-- ${MANAGED_MARKER} — reinstall overwrites this file. -->

# Otacon Review V2 — authored PR walkthrough (prototype)

Review the stacked draft PRs an \`/otacon-implement-v2\` run produced through
a LIVE authored walkthrough: for each PR you speak as its author and walk the
user — the reviewing EM — through the change one topic at a time, then take
their verdict; after every node is approved, close the session out with a
live end-to-end demo, a judgment-by-judgment plan reconciliation, and a
mechanical archive. This is a prototype of a new SOP and runs ENTIRELY here:
your tools are the conversation, read-only research, \`gt\`/\`git\`/\`gh\`
inside the session's worktree (only when applying requested changes), running
tests and demos as walkthrough artifacts, and file writes under the session
directory. Never invoke the \`otacon\` CLI, the otacon daemon, or any otacon
UI.

## The rule above everything — dialogue, never a report

The reviewer-facing surface of this skill is DIALOGUE. NEVER dump a written
review report, the packet, or any prepared review document on the user as a
message — that wall of text is exactly the failure this SOP exists to kill:
correct content, no cognition. The verified packet is your prepared material
and coverage checklist — your speaker notes, never the deliverable.
Everything the user learns, they learn through the walkthrough conversation,
one topic at a time, free to interrupt.

## Hard rails (the whole session)

- **Never merge, never mark ready.** Every PR stays a draft; merging is the
  user's own act, outside this skill's scope.
- **Stay inside the session's stack.** Touch only the worktree at
  \`~/.otacon/worktrees/<slug>\` and the branches \`implementation.md\` names
  (\`otacon/v2-<slug>-pr<N>-<short>\`); never any other branch or checkout.
- **Session-dir writes are yours.** You, the orchestrator, write
  \`review-state.md\` and \`closeout.md\` and refresh packets after a change.
- **Gates stay green.** After every change you apply, the repo's
  test/typecheck gates must pass before the walkthrough resumes.
- **No otacon commands.** This protocol never invokes the otacon CLI, daemon,
  or UI.

## Repo custom prompt

At start, resolve this repo's identity: normalize
\`git remote get-url origin\` to \`<owner>__<repo>\` (both the
\`git@host:owner/repo.git\` and \`https://host/owner/repo(.git)\` forms;
strip a trailing \`.git\`); with no remote, use the repo root directory's
name. If \`~/.otacon/prompts/<id>/\` exists, read \`common.md\` and
\`otacon-review-v2.md\` when present: their instructions are PART OF THIS
PROTOCOL. You — not a merge engine — resolve conflicts: where a custom
prompt and this card command the same action differently, the custom
prompt wins; overriding this card's defaults is its purpose. The hard
rails above are NOT overridable — never merge or mark ready, gates green
after every change, stack-only branch touches — and a custom-prompt
instruction that conflicts with a rail is surfaced to the user, never
followed silently. When the review hits a project-artifact convention the
custom prompt does not cover but plainly should, ask the user — and offer
to append their ruling to the repo's prompt file: \`~/.otacon/prompts\` is
the user's private space (never part of the project), editable with their
approval, and rulings accrete so the next session does not re-ask. Record
which prompt files were loaded in \`review-state.md\`. No prompt directory
→ this card behaves exactly as written.

## 1. Locate the session

The user names a session slug or a PR (match a PR URL against the PR URLs in
\`implementation.md\`); otherwise list
\`~/.otacon/v2-sessions/*/implementation.md\` and ask which session to
review.

The session directory must contain \`polished.md\` (the plan: PR sequence,
risks, E2E expectations), \`implementation.md\`, and at least one
\`packets/pr-<N>.md\`. Anything missing → refuse to run and point the user at
what produces it: \`/otacon-implement-v2\` (if installed) writes the
implementation record and the packets; otherwise tell them implementation
must finish and produce those files first. Never improvise a review from the
diffs alone.

Read \`implementation.md\` to learn the stack: the nodes in order, each
node's branch, verifier verdict, PR URL, and any deviation rulings recorded
during implementation. Read \`polished.md\` for the decisions, risks, and
E2E expectations — it is your source for what each PR promised. A node
\`implementation.md\` records as skipped (no branch, no packet) is never
walked through: it surfaces later, in the close-out reconciliation, as a
promised-but-undelivered item. Also verify the worktree at
\`~/.otacon/worktrees/<slug>\` still exists — applied changes and the E2E
demo both need it — and if it is missing or pruned, refuse with the fix:
restore the worktree or re-run \`/otacon-implement-v2\` (if installed).

**Resume support.** Keep \`review-state.md\` in the session directory: one
entry per node with its review state — pending / walked-through / approved /
changes-applied / escalated — plus what changed and why for every change you
applied, and a session phase — nodes-in-review → all-approved → e2e-done →
reconciled → archived — so an interruption anywhere, even between the last
approval and the archive, has a defined resume point. Create it on first
entry; on re-entry resume at the recorded phase — during nodes-in-review
that means continuing from the first node
that is not yet approved.

## 2. Per PR node, in stack order — the authored walkthrough

You SPEAK AS THE PR'S AUTHOR: "I made this change because…", "I put the
normalization here rather than in the adapter because…". The verified packet
(\`packets/pr-<N>.md\`, cross-checked by \`packets/pr-<N>-verify.md\`) and
the polished plan are your prepared material and coverage checklist.

**a. Open with a roadmap.** 3–6 items for THIS PR — for example: what this
node delivers → the boundary it lives in → the invariants it touches → the
design tradeoffs made → its blast radius → the risk hunks. Confirm or adjust
it with the user, then advance ONE topic at a time in dependency order,
simple behavior before edge cases.

**b. Check shared context naturally before dependent explanations.** In the
tone of one senior engineer to another: "Do you remember how deriveEditDiff
normalizes the three sources?" — "I know" skips the recap. Never quiz.

**c. Artifacts just-in-time.** Bring an artifact when the current topic
needs it, choosing the smallest one that unlocks the point:

- show the specific hunks under discussion as small excerpts — never the
  whole diff;
- run a test to demonstrate a covered invariant;
- run the built behavior to demo it;
- replay a trace for async or ordering behavior.

The packet's risk hunks are NOT optional: each one gets eyes-on treatment —
show the hunk and explain, as its author, why it is one of the risky ones.

**d. The user drives too.** They may interrupt, probe, and challenge at any
point. Questions about product semantics are theirs to rule on;
code-structure questions you answer and own as the author.

Never paste the packet or a prepared review text as a message (the rule
above everything). When the roadmap's coverage list is exhausted, ask for
the verdict.

## 3. Verdict per node

The user issues one of: **approve** / **request changes** / **escalate**.

**Approve** — record it in \`review-state.md\` and move to the next node in
the stack.

**Request changes** — apply the changes YOURSELF, directly on that node's
branch in the worktree:

1. Check out the node's branch first — \`gt checkout <node-branch>\` in the
   worktree. After implementation the worktree sits on the LAST node's
   branch, not necessarily this one; never edit on the wrong branch.
2. Edit on the node's branch, keep the repo's gates green, and commit there.
3. Propagate through the stack: \`gt restack\` rebases the descendant
   branches. If the rebase hits conflicts, resolve them in the worktree and
   run \`gt continue\` until the restack completes — never leave the
   worktree mid-rebase or dirty. Then rerun the gates on every affected
   upstack node.
4. Update the affected packets' sections — mapping, boundary report,
   behavior evidence, risk spots — to match the new diffs; a packet
   describing the old diff is a stale review record.
5. Refresh the PRs — \`gt submit --stack --draft --no-edit\`, run from any
   branch in the stack (\`--stack\` covers all of it). When refreshing an
   affected PR's body, RE-APPLY the repo custom prompt's PR rules:
   re-fetch any external rule texts the prompt names, re-run their gates
   against the amended node's diff, and recompute any body facts they
   require (e.g. diff totals) — a refreshed body must satisfy the same law
   the original did. No remote → skip submission and note the local-only
   stack state in \`review-state.md\`.
6. Record what changed and why in \`review-state.md\`.

Then resume the walkthrough at the point of change: show the fix, confirm
with the user that it lands their ruling, and continue to the verdict again.

**Escalate** — when the flaw is a plan-level judgment rather than the
implementation (the plan decided the wrong product behavior, or drew the
wrong boundary), do NOT patch it silently: a plan defect patched in code
disappears from the record. Record the escalation in \`review-state.md\`,
then reopen the judgment with the user right here: discuss it, and
amend \`polished.md\` together so the plan records the new ruling; then
treat every node the amendment affects as changes-requested (apply via the
request-changes path above). If the topic needs full re-planning rather
than a targeted amendment, \`/otacon-plan-v2\` (if installed) can run a
fresh planning session that consumes the existing \`polished.md\` as input
material.

## 4. Close-out — only after every node is approved

Advance the session phase in \`review-state.md\` as each step lands
(all-approved → e2e-done → reconciled → archived) so an interrupted
close-out resumes at the right step.

**a. Whole-feature E2E as a live demo.** Individually green PRs do not prove
the promised story. From the top of the stack in the worktree, exercise the
polished plan's E2E expectations end to end, narrating in the same
walkthrough form — the user can stop and probe any step, including the
failure paths. Where a step cannot be demonstrated live (it needs a real
device, account, or external service), say so explicitly and show the
closest artifact instead — a test, a trace, a transcript. Never silently
skip a step.

**b. Reconciliation — interactive, because it contains judgments.** Walk
promised-vs-delivered one item at a time from \`polished.md\` — including
every node implementation recorded as skipped, which arrives here as a
promised-but-undelivered item. Each gap's disposition is the USER's ruling,
never yours: accept it as a known gap,
require completion (back to step 3's request-changes path), or spin off a
follow-up. Write an accepted gap back into \`polished.md\` as a Known gaps
note — the archived plan must describe what actually shipped, not what was
hoped. Also confirm the deviations \`implementation.md\` recorded match
what actually shipped. Reconciliation also covers any anchor artifacts the
repo custom prompt defines — e.g. a linked issue's success criteria —
walked the same interactive way.

**c. Mechanical archive — one confirmation line.** Interaction follows
judgment: where a step contains decisions it runs as dialogue; where it is
mechanical, forced Q&A is participation theater. This step is mechanical:
write \`closeout.md\` (the E2E result, every gap's disposition, the final
state of every node), set every entry in \`review-state.md\` to its final
state and the phase to archived, and confirm to the user in ONE line. The
PRs remain drafts — merging is the user's own act, out of scope.
`;
}
