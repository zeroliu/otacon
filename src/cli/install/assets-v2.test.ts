import { describe, expect, test } from "bun:test";
import { MANAGED_MARKER, reviewSkillMd, skillMd } from "./assets.js";
import { implementV2SkillMd, planV2SkillMd, reviewV2SkillMd } from "./assets-v2.js";

function frontmatter(text: string): Record<string, unknown> {
  const close = text.indexOf("\n---\n", 4);
  return Bun.YAML.parse(text.slice(4, close)) as Record<string, unknown>;
}

describe("planV2SkillMd", () => {
  const text = planV2SkillMd();

  test("is concise and carries only name + description frontmatter plus the managed marker", () => {
    expect(text.split("\n").length).toBeLessThan(500);
    const metadata = frontmatter(text);
    expect(Object.keys(metadata)).toEqual(["name", "description"]);
    expect(metadata.name).toBe("otacon-plan-v2");
    expect(metadata.description).toContain("SOP: plan a feature");
    expect(text.startsWith("---\nname: otacon-plan-v2\n")).toBe(true);
    expect(text).toContain(MANAGED_MARKER);
  });

  test("is pure agent-side: never teaches the otacon CLI, daemon, or UI", () => {
    // The protocol's only actors are the conversation, session files, and
    // clean-context subagents — no v1 command surface may leak in. The same
    // bytes install into codex/opencode, so the subagent wording stays
    // agent-neutral: Task tool is named as Claude Code's mechanism, not the API.
    expect(text).toContain("Task tool");
    expect(text).toContain("native subagent/spawn mechanism");
    expect(text).toContain("Never invoke the");
    expect(text).not.toContain("otacon start");
    expect(text).not.toContain("otacon wait");
    expect(text).not.toContain("otacon ask");
    expect(text).not.toContain("otacon submit");
    expect(text).not.toContain("review start --pr");
    expect(text).not.toContain("./bin/otacon");
    expect(text).not.toContain("Stop hook");
  });

  test("sets up the session directory, its three artifacts, and the hard plan-only gate", () => {
    expect(text).toContain("~/.otacon/v2-sessions/<slug>/");
    expect(text).toContain("design.md");
    expect(text).toContain("polished.md");
    expect(text).toContain("review-r<N>.md");
    expect(text).toContain("## Hard implementation gate");
    expect(text).toContain("MUST NOT create, edit, delete, or format");
    expect(text).toContain("only after the user explicitly approves that exact\nwrite");
  });

  test("uses collision-safe session slugs instead of reusing a topic directory", () => {
    expect(text).toContain("append a UTC timestamp");
    expect(text).toContain("collision-refusing create");
    expect(text).toContain("append `-2`,\n`-3`, and so on");
    expect(text).toContain("Never reuse or merge into an existing\nsession directory");
  });

  test("routes through the four-question tree and defaults uncertainty to project mode", () => {
    // Routing runs BEFORE session setup, so a narrowed/failed routing never
    // leaves a stale slug directory behind.
    expect(text.indexOf("## 1. Routing check")).toBeGreaterThan(-1);
    expect(text.indexOf("## 1. Routing check")).toBeLessThan(
      text.indexOf("## 2. Session setup"),
    );
    expect(text).toContain("ONE coherent product outcome");
    expect(text).toContain("one shared system model");
    expect(text).toContain("without learning from an earlier");
    expect(text).toContain("healthy context reserve");
    expect(text).toContain("UNCERTAIN");
    expect(text).toContain("project-mode decomposition");
    // PR count / diff size is explicitly not a routing signal (D23).
    expect(text).toContain("NOT a routing signal");
  });

  test("keeps research just-in-time and the roadmap adaptable (D1/D4/D5/D8)", () => {
    expect(text).toContain("NEVER dump your researched system model");
    expect(text).toContain("just-in-time");
    expect(text).toContain("cognition-building order");
    expect(text).toContain("orientation, not commitment");
    expect(text).toContain("name the new understanding");
    // Detours are announced, visible, and correctable.
    expect(text).toContain("Announce missing-context detours explicitly");
  });

  test("teaches the discussion loop: peer context checks, prerequisites, artifacts, adaptive recommendations", () => {
    // D3: natural senior-peer context check with a skip.
    expect(text).toContain('"I know" is a complete answer');
    expect(text).toContain("Never quiz");
    // D2: simplest behavior first; the cognition signal is an independent opinion.
    expect(text).toContain("simplest observable behavior");
    expect(text).toContain("form their OWN opinion");
    // D9/D10: the four artifact kinds, chosen minimally to teach.
    for (const artifact of ["**Demo**", "**Trace**", "**Code**", "**Test**"]) {
      expect(text).toContain(artifact);
    }
    expect(text).toContain("smallest artifact");
    expect(text).toContain("Never a fixed bundle");
    // D7: withhold the recommendation until it can be evaluated; topic-specific.
    expect(text).toContain("Withhold your recommendation");
    expect(text).toContain("implies nothing about this subsystem");
  });

  test("records judgments immediately with visible changes and no approval gates (D6)", () => {
    expect(text).toContain("## Decisions");
    expect(text).toContain("**Why**");
    expect(text).toContain("**Revisit when**");
    expect(text).toContain("## System Model");
    expect(text).toContain("what changed in the document");
    expect(text).toContain("No confirmation gates");
  });

  test("splits ownership and bounds approval depth (D11/D12/D13)", () => {
    expect(text).toContain("The user owns product semantics");
    expect(text).toContain("You own behavior-equivalent code design");
    expect(text).toContain("does not transfer their\nownership");
    // The D11 baseline's five clauses.
    expect(text).toContain("worth doing");
    expect(text).toContain("if it fails");
    expect(text).toContain("rolled back");
    expect(text).toContain("end to end");
    // The three D12 escalation triggers.
    expect(text).toContain("Shared lower-layer blast radius");
    expect(text).toContain("Complex event/state space");
    expect(text).toContain("Value depends on implementation cost");
    expect(text).toContain('"implementation\ndetail."');
  });

  test("guards against abstraction drift and synthesizes a self-contained handoff with a PR sequence", () => {
    expect(text).toContain("## 8. Abstraction-drift guard");
    expect(text).toContain("no concrete artifact on the table");
    // D14/D15/D24: polished handoff, no new judgments, whole-plan presentation.
    expect(text).toContain("self-contained implementation handoff");
    expect(text).toContain("intended PR sequence");
    expect(text).toContain("stand alone and");
    expect(text).toContain("pass its checks independently");
    expect(text).toContain("may not introduce a new judgment");
    expect(text).toContain("no raw-to-final\ndiff needed");
  });

  test("runs the independent review with a clean-context reviewer that persists per round (D16–D18)", () => {
    expect(text).toContain("FRESH subagent with clean context");
    // Harness fallback: an agent with no subagent mechanism still preserves the
    // D17 clean-context guarantee via a fresh session seeded only with the plan.
    expect(text).toContain("open a fresh agent session");
    expect(text).toContain("no conversation history");
    expect(text).toContain("no design.md, no summary of the discussion");
    expect(text).toContain("it never rewrites the\n   design");
    // The orchestrator, not the read-only reviewer, writes the findings file.
    expect(text).toContain("the\n   orchestrator, own every session-directory write");
    expect(text).toContain("SAME reviewer");
    expect(text).toContain("deems the plan clean");
    expect(text).toContain("the polished plan is defective");
    // The user's three post-clean-round choices; the v2 implementer pointer
    // degrades gracefully until that companion skill ships.
    expect(text).toContain("Another round");
    expect(text).toContain("Finish");
    expect(text).toContain("/otacon-implement-v2` (if installed)");
  });

  test("loads the repo custom prompt and scaffolds it once (repo conventions hook)", () => {
    const flat = text.replace(/\s+/g, " ");
    expect(text).toContain("## Repo custom prompt");
    expect(text).toContain("git remote get-url origin");
    expect(text).toContain("<owner>__<repo>");
    expect(flat).toContain("with no remote, use the repo root directory's name");
    expect(text).toContain("~/.otacon/prompts/<id>/");
    expect(text).toContain("common.md");
    expect(text).toContain("otacon-plan-v2.md");
    expect(flat).toContain("their instructions are PART OF THIS PROTOCOL");
    // Precedence is agent-resolved: prompts beat defaults, never the rails —
    // a rail conflict is surfaced, not silently followed.
    expect(flat).toContain("the custom prompt wins");
    expect(text).toContain("NOT overridable");
    expect(flat).toContain(
      "the implementation gate above and the independent reviewer's clean context",
    );
    expect(flat).toContain("surfaced to the user, never followed silently");
    // Silence → ask → offer to append; rulings accrete in the user's space.
    expect(flat).toContain("offer to append their ruling to the repo's prompt file");
    expect(flat).toContain("rulings accrete so the next session does not re-ask");
    expect(flat).toContain("Record which prompt files were loaded in design.md");
    expect(flat).toContain("this card behaves exactly as written");
    // Scaffold at most once per session, seeded from repo-declared conventions.
    expect(text).toContain("**Scaffold offer (once).**");
    expect(flat).toContain("PR/issue templates, CONTRIBUTING, AGENTS.md");
    expect(flat).toContain("never ask again this session");
    // Downstream handoff: polished.md carries the Conventions section, and the
    // clean-context reviewer still sees only polished.md.
    expect(text).toContain("`## Conventions` section");
    expect(flat).toContain(
      "keeping implement and review self-contained on the session directory",
    );
    expect(flat).toContain(
      "Repo conventions reach it only through the `## Conventions` section of polished.md, never as raw `~/.otacon/prompts` files",
    );
  });

  test("the v1 cards and the v2 card stay isolated", () => {
    expect(skillMd()).not.toContain("otacon-plan-v2");
    expect(reviewSkillMd()).not.toContain("otacon-plan-v2");
    expect(text).not.toContain("start --title <kebab-title>");
    expect(text).not.toContain('{"event":"approved"');
  });
});

describe("implementV2SkillMd", () => {
  const text = implementV2SkillMd();

  test("is concise and carries only name + description frontmatter plus the managed marker", () => {
    expect(text.split("\n").length).toBeLessThan(500);
    const metadata = frontmatter(text);
    expect(Object.keys(metadata)).toEqual(["name", "description"]);
    expect(metadata.name).toBe("otacon-implement-v2");
    expect(metadata.description).toContain("SOP: implement the polished plan");
    expect(text.startsWith("---\nname: otacon-implement-v2\n")).toBe(true);
    expect(text).toContain(MANAGED_MARKER);
  });

  test("is pure agent-side and agent-neutral: gt/git/gh plus native subagents, never otacon", () => {
    // The same bytes install into claude/codex/opencode, so the subagent
    // wording names the Task tool only as Claude Code's mechanism.
    expect(text).toContain("Task tool");
    expect(text).toContain("native subagent/spawn mechanism");
    expect(text).toContain("Never invoke the");
    expect(text).not.toContain("otacon start");
    expect(text).not.toContain("otacon wait");
    expect(text).not.toContain("otacon ask");
    expect(text).not.toContain("otacon submit");
    expect(text).not.toContain("otacon progress");
    expect(text).not.toContain("implement-done");
    expect(text).not.toContain("review start --pr");
    expect(text).not.toContain("./bin/otacon");
    expect(text).not.toContain("Stop hook");
  });

  test("consumes only polished.md and refuses to run or invent a PR sequence without it (D17/D24)", () => {
    expect(text).toContain("~/.otacon/v2-sessions/*/polished.md");
    expect(text).toContain("is the ONLY plan input");
    expect(text).toContain("implement from `design.md`");
    expect(text).toContain("refuse to run");
    // A missing PR sequence stops the run — the sequence is a plan surface,
    // never silently invented by the implementer.
    expect(text).toContain("must state an intended PR sequence");
    expect(text).toContain("NEVER invent one silently");
    expect(text).toContain("reviewer-challengeable plan surface");
    // Both plan-defect routes degrade gracefully until plan-v2 is present.
    expect(text.split("/otacon-plan-v2` (if installed)").length).toBe(3);
  });

  test("sets up the gt stack in an isolated worktree and asks before repo-level init", () => {
    expect(text).toContain("git worktree add ~/.otacon/worktrees/<slug>");
    expect(text).toContain("otacon/v2-<slug>-pr<N>-<short>");
    expect(text).toContain("gt --version");
    // Auth is prechecked read-only so an unauthenticated submit is a setup
    // failure, not a late generic blocker or a mutating auth flow.
    expect(text).toContain("GRAPHITE_AUTH_TOKEN");
    expect(text).toContain("~/.config/graphite/auth");
    expect(text).toContain("Never run `gt auth` as a status probe");
    expect(text).toContain("gh auth status --active --hostname <host>");
    expect(text).toContain("setup failure to surface before");
    // The stack bases on the freshly fetched remote default branch, falling
    // back to the local one only when there is no remote.
    expect(text).toContain("Only when `origin` exists, run `git fetch origin`");
    expect(text).toContain("With no\n   `origin`, skip fetch");
    expect(text).toContain("origin/<default-branch>");
    expect(text).toContain("fast-forward-only update");
    expect(text).toContain("local trunk and fetched base\n   identical");
    // The initialization probe is NON-MUTATING: `gt log` silently initializes
    // an uninitialized repo, so the config file is checked instead, and
    // `gt init` runs only with the user's consent.
    expect(text).toContain("WITHOUT running a gt command");
    expect(text).toContain("git rev-parse --git-common-dir");
    expect(text).toContain(".graphite_repo_config");
    expect(text).toContain("silently\n   initializes");
    expect(text).toContain("ASK the user before running");
    expect(text).toContain("gt init --trunk <default-branch>");
    expect(text).not.toContain("gt repo init");
    expect(text).toContain("gt track --parent <default-branch>");
    // Later nodes stack on the previous increment via gt create.
    expect(text).toContain("gt create otacon/v2-<slug>-pr<N>-<short>");
  });

  test("keeps a live implementation.md record the later review skill consumes", () => {
    expect(text).toContain("implementation.md");
    expect(text).toContain("the later review skill consumes it");
    expect(text).toContain("verifier verdict, and PR URL");
    expect(text).toContain("every state change, not in one final pass");
  });

  test("the implementer authors the four-section review packet (D31 step 2)", () => {
    expect(text).toContain("packets/pr-<N>.md");
    expect(text).toContain("exactly four\n  sections");
    expect(text).toContain("**Decision→diff mapping**");
    expect(text).toContain("**Boundary report**");
    expect(text).toContain("**Behavior evidence**");
    expect(text).toContain("**Risk spots**");
    expect(text).toContain("ONE end-to-end artifact");
    expect(text).toContain("one-line justification per out-of-boundary file");
    // The implementer stays scoped to its node.
    expect(text).toContain("nothing from later nodes");
    // The implementer commits before verification: the verifier diffs
    // committed refs, so uncommitted work would be invisible to it.
    expect(text).toContain("COMMIT the node's work on its branch");
    expect(text).toContain("invisible to the verifier");
  });

  test("the independent verifier gets clean context and gates progress (D31 step 3)", () => {
    expect(text).toContain("fresh verifier subagent with clean\ncontext");
    expect(text).toContain("No implementation conversation");
    expect(text).toContain("independently diff the node");
    expect(text).toContain("never trust the packet's file list");
    expect(text).toContain("not understated");
    // The orchestrator owns the verify-file write; verifiers write nothing.
    expect(text).toContain("You write its verdict and findings");
    expect(text).toContain("packets/pr-<N>-verify.md");
    expect(text).toContain("verifier itself writes nothing");
    expect(text).toContain("READ-ONLY against the project");
    // Findings loop back through a fresh implementer whose fix also refreshes
    // the packet (a stale packet cannot converge), then re-verify.
    expect(text).toContain("fresh implementer\nsubagent to fix");
    expect(text).toContain("RE-AUTHOR the\npacket");
    expect(text).toContain("a stale packet cannot pass");
    expect(text).toContain("proceed to the next node until the verifier passes");
    // Harness fallback: no subagent mechanism still preserves the verifier's
    // clean context via a fresh agent session seeded with only the artifacts.
    expect(text).toContain("no subagent mechanism at all");
    expect(text).toContain("open a fresh agent session");
  });

  test("escalates plan-level deviations and blockers instead of patching or looping (D13/D31)", () => {
    expect(text).toContain("Behavior-equivalent implementation choices");
    expect(text).toContain("no\nescalation");
    expect(text).toContain("STOP and ask the user before proceeding");
    expect(text).toContain("never be silently patched in code");
    expect(text).toContain("No unbounded auto-retry");
    expect(text).toContain("retry / skip / abort / guidance");
    // Rulings and skips are bookkept so the review handoff reflects reality,
    // and a skip leaves the worktree clean for the next gt create.
    expect(text).toContain("Record the user's ruling");
    expect(text).toContain("stash or drop the node's partial work");
  });

  test("submits draft-only stacks with reviewer-first bodies and degrades without a remote", () => {
    // --no-edit keeps submit non-interactive; bodies land via gh pr edit.
    expect(text).toContain("gt submit --stack --draft --no-edit");
    expect(text).toContain("Never push a non-draft PR");
    expect(text).toContain("never merge anything");
    expect(text).toContain("Never touch branches outside the worktree");
    expect(text).toContain("**Plan decisions**");
    expect(text).toContain("never a re-description of the diff");
    expect(text).toContain("The packet IS the review material");
    expect(text).toContain("No remote → skip submission");
    // The future review skill is referenced with a graceful fallback only.
    expect(text).toContain("/otacon-review-v2` (if\ninstalled)");
    expect(text).toContain("otherwise the packets under");
  });

  test("loads the repo custom prompt, briefs subagents with it, and honors external rule texts", () => {
    const flat = text.replace(/\s+/g, " ");
    expect(text).toContain("## Repo custom prompt");
    expect(text).toContain("git remote get-url origin");
    expect(text).toContain("<owner>__<repo>");
    expect(flat).toContain("with no remote, use the repo root directory's name");
    expect(text).toContain("~/.otacon/prompts/<id>/");
    expect(text).toContain("common.md");
    expect(text).toContain("otacon-implement-v2.md");
    expect(flat).toContain("their instructions are PART OF THIS PROTOCOL");
    // Precedence: the prompt (and polished.md's resolved Conventions) beat
    // card defaults like base branch / PR target / naming; the hard gates
    // never yield, and a conflict is surfaced.
    expect(flat).toContain("the custom prompt wins");
    expect(flat).toContain(
      "override card defaults such as the worktree base branch, the PR target repo, or branch naming",
    );
    expect(flat).toContain(
      "`## Conventions` section of `polished.md` carries the session's already-resolved values",
    );
    expect(flat).toContain("The hard gates above are NOT overridable");
    expect(flat).toContain("surfaced to the user, never followed silently");
    // Silence → ask → offer to append; load recording; no-dir no-op.
    expect(flat).toContain("offer to append their ruling to the repo's prompt file");
    expect(flat).toContain("rulings accrete so the next session does not re-ask");
    expect(flat).toContain("Record which prompt files were loaded in `implementation.md`");
    expect(flat).toContain("No prompt directory → this card behaves exactly as written");
    // The orchestrator briefs subagents; they never re-resolve prompts.
    expect(flat).toContain(
      "custom-prompt excerpts (and polished.md's Conventions) into each implementer and verifier brief",
    );
    expect(flat).toContain("subagents never re-resolve prompts themselves");
    // External rule texts: fetched fresh, blocking gates honored, silence on
    // protocol-introduced structures falls back to rulings then the user.
    expect(flat).toContain("external rule texts it names");
    expect(flat).toContain("fetched FRESH at use time via the commands it records");
    expect(text).toContain("gh api");
    expect(text).toContain("npx skills");
    expect(text).toContain("BLOCKING gates");
    expect(flat).toContain("silent about a structure this protocol introduces (e.g. stacked PRs)");
    expect(flat).toContain("never invent project-facing conventions silently");
    expect(flat).toContain("Record the external rule texts applied per PR in `implementation.md`");
  });

  test("the implement card and every other card stay isolated", () => {
    expect(skillMd()).not.toContain("otacon-implement-v2");
    expect(reviewSkillMd()).not.toContain("otacon-implement-v2");
    // plan-v2 hands off to implement-v2 by name (its step-10 Implement
    // choice) but never absorbs this card's protocol.
    expect(planV2SkillMd()).not.toContain("gt submit");
    expect(text).not.toContain("start --title <kebab-title>");
    expect(text).not.toContain('{"event":"approved"');
    // Implement never reopens planning surfaces owned by plan-v2.
    expect(text).not.toContain("design review");
    expect(text).not.toContain("review-r<N>.md");
  });
});

describe("reviewV2SkillMd", () => {
  const text = reviewV2SkillMd();

  test("is concise and carries only name + description frontmatter plus the managed marker", () => {
    expect(text.split("\n").length).toBeLessThan(500);
    const metadata = frontmatter(text);
    expect(Object.keys(metadata)).toEqual(["name", "description"]);
    expect(metadata.name).toBe("otacon-review-v2");
    expect(metadata.description).toContain("SOP: interactively walk the user");
    expect(text.startsWith("---\nname: otacon-review-v2\n")).toBe(true);
    expect(text).toContain(MANAGED_MARKER);
  });

  test("is pure agent-side: gt/git/gh in the session worktree, never the otacon CLI, daemon, or UI", () => {
    expect(text).toContain("Never invoke the");
    expect(text).not.toContain("otacon start");
    expect(text).not.toContain("otacon wait");
    expect(text).not.toContain("otacon ask");
    expect(text).not.toContain("otacon submit");
    expect(text).not.toContain("otacon progress");
    expect(text).not.toContain("review start --pr");
    expect(text).not.toContain("./bin/otacon");
    expect(text).not.toContain("Stop hook");
  });

  test("locates the session, requires its artifacts, and resumes from review-state.md", () => {
    expect(text).toContain("~/.otacon/v2-sessions/*/implementation.md");
    // All three inputs are required; a missing one refuses with a pointer at
    // the producing skill, degrading gracefully when it is not installed.
    expect(text).toContain("polished.md");
    expect(text).toContain("implementation.md");
    expect(text).toContain("packets/pr-<N>.md");
    expect(text).toContain("refuse to run");
    expect(text).toContain("/otacon-implement-v2` (if installed)");
    expect(text).toContain("Never improvise a review from the\ndiffs alone");
    // implementation.md teaches the stack shape; review-state.md carries resume.
    expect(text).toContain("verifier verdict, PR URL");
    expect(text).toContain("deviation rulings");
    expect(text).toContain("review-state.md");
    expect(text).toContain("pending / walked-through / approved /\nchanges-applied / escalated");
    expect(text).toContain("first node\nthat is not yet approved");
    // Close-out progress is resumable too, and degenerate stacks are handled:
    // skipped nodes route to reconciliation, a lost worktree refuses early.
    expect(text).toContain("nodes-in-review → all-approved → e2e-done →\nreconciled → archived");
    expect(text).toContain("skipped (no branch, no packet)");
    expect(text).toContain("promised-but-undelivered");
    expect(text).toContain("missing or pruned, refuse with the fix");
  });

  test("the walkthrough is authored dialogue, never a pasted report (D32)", () => {
    // The author voice with the verified packet as speaker notes.
    expect(text).toContain("SPEAK AS THE PR'S AUTHOR");
    expect(text).toContain("packets/pr-<N>-verify.md");
    expect(text).toContain("prepared material and coverage checklist");
    expect(text).toContain("never the deliverable");
    // The anti-wall-of-text rule is explicit and prohibitive.
    expect(text).toContain("dialogue, never a report");
    expect(text).toContain("NEVER dump a written\nreview report");
    expect(text).toContain("Never paste the packet");
    // D5 mirror roadmap, D2 ordering, D3 context checks, D9/D10 artifacts.
    expect(text).toContain("3–6 items for THIS PR");
    expect(text).toContain("ONE topic at a time in dependency order");
    expect(text).toContain("simple behavior before edge cases");
    expect(text).toContain('"I know" skips the recap');
    expect(text).toContain("Never quiz");
    expect(text).toContain("just-in-time");
    expect(text).toContain("smallest one that unlocks the point");
    expect(text).toContain("never the\n  whole diff");
    // Risk hunks are mandatory eyes-on material.
    expect(text).toContain("risk hunks are NOT optional");
    expect(text).toContain("eyes-on treatment");
    // D13 ownership split inside the dialogue.
    expect(text).toContain("product semantics are theirs to rule on");
    expect(text).toContain("you answer and own as the author");
  });

  test("verdicts apply changes through the stack or escalate plan defects (D31 step 4)", () => {
    expect(text).toContain("**approve** / **request changes** / **escalate**");
    // Request changes: check out the right branch, direct edits, restack with
    // a conflict path, gates, packet refresh, draft resubmission (skipped
    // when remoteless), and a recorded ruling.
    expect(text).toContain("apply the changes YOURSELF");
    expect(text).toContain("gt checkout <node-branch>");
    expect(text).toContain("LAST node's");
    expect(text).toContain("gt restack");
    expect(text).toContain("gt continue");
    expect(text).toContain("never leave the\n   worktree mid-rebase or dirty");
    expect(text).toContain("rerun the gates on every affected\n   upstack node");
    expect(text).toContain("stale review record");
    expect(text).toContain("gt submit --stack --draft --no-edit");
    expect(text).toContain("run from any\n   branch in the stack");
    expect(text).toContain("No remote → skip");
    expect(text).toContain("local-only");
    expect(text).toContain("Record what changed and why");
    expect(text).toContain("resume the walkthrough at the point of change");
    // Escalation reopens the plan judgment in-conversation (plan-v2 has no
    // amend mode; a fresh planning session is only for full re-planning).
    expect(text).toContain("plan-level judgment");
    expect(text).toContain("do NOT patch it silently");
    expect(text).toContain("amend `polished.md` together");
    expect(text).toContain("changes-requested");
    expect(text).toContain("full re-planning");
    expect(text).toContain("/otacon-plan-v2` (if installed)");
    expect(text).toContain("consumes the existing");
  });

  test("closes out with a live E2E demo, interactive reconciliation, and a one-line archive (D33)", () => {
    expect(text).toContain("only after every node is approved");
    expect(text).toContain("Individually green PRs do not prove\nthe promised story");
    expect(text).toContain("E2E expectations end to end");
    expect(text).toContain("including the\nfailure paths");
    expect(text).toContain("Never silently\nskip a step");
    // Reconciliation dispositions are the user's judgments (D13); accepted
    // gaps write back into the plan so the archive matches shipped reality.
    expect(text).toContain("promised-vs-delivered one item at a time");
    expect(text).toContain("USER's ruling");
    expect(text).toContain("known gap");
    expect(text).toContain("follow-up");
    expect(text).toContain("back into `polished.md` as a Known gaps");
    expect(text).toContain("what actually shipped, not what was\nhoped");
    // Close-out progress is phase-tracked for resume.
    expect(text).toContain("all-approved → e2e-done → reconciled → archived");
    // The archive is mechanical: no forced dialogue, one confirmation line.
    expect(text).toContain("Interaction follows\njudgment");
    expect(text).toContain("participation theater");
    expect(text).toContain("closeout.md");
    expect(text).toContain("confirm to the user in ONE line");
  });

  test("hard rails: draft-only, stack-only, orchestrator-owned session writes, green gates", () => {
    expect(text).toContain("Never merge, never mark ready");
    expect(text).toContain("merging is the user's own act");
    expect(text).toContain("~/.otacon/worktrees/<slug>");
    expect(text).toContain("otacon/v2-<slug>-pr<N>-<short>");
    expect(text).toContain("never any other branch or checkout");
    expect(text).toContain("Session-dir writes are yours");
    expect(text).toContain("Gates stay green");
  });

  test("loads the repo custom prompt and re-applies its PR rules on every refresh", () => {
    const flat = text.replace(/\s+/g, " ");
    expect(text).toContain("## Repo custom prompt");
    expect(text).toContain("git remote get-url origin");
    expect(text).toContain("<owner>__<repo>");
    expect(flat).toContain("with no remote, use the repo root directory's name");
    expect(text).toContain("~/.otacon/prompts/<id>/");
    expect(text).toContain("common.md");
    expect(text).toContain("otacon-review-v2.md");
    expect(flat).toContain("their instructions are PART OF THIS PROTOCOL");
    // Precedence: prompt beats defaults, rails never yield, conflicts surface.
    expect(flat).toContain("the custom prompt wins");
    expect(flat).toContain(
      "never merge or mark ready, gates green after every change, stack-only branch touches",
    );
    expect(flat).toContain("surfaced to the user, never followed silently");
    // Silence → ask → offer to append; load recording; no-dir no-op.
    expect(flat).toContain("offer to append their ruling to the repo's prompt file");
    expect(flat).toContain("rulings accrete so the next session does not re-ask");
    expect(flat).toContain("Record which prompt files were loaded in `review-state.md`");
    expect(flat).toContain("No prompt directory → this card behaves exactly as written");
    // A refreshed PR body obeys the same law the original did.
    expect(text).toContain("RE-APPLY");
    expect(flat).toContain("re-fetch any external rule texts the prompt names");
    expect(flat).toContain("re-run their gates against the amended node's diff");
    expect(flat).toContain("recompute any body facts they require (e.g. diff totals)");
    expect(flat).toContain("a refreshed body must satisfy the same law the original did");
    // Close-out reconciliation walks prompt-defined anchor artifacts too.
    expect(flat).toContain(
      "anchor artifacts the repo custom prompt defines — e.g. a linked issue's success criteria",
    );
  });

  test("the review-v2 card and every other card stay isolated", () => {
    expect(skillMd()).not.toContain("otacon-review-v2");
    expect(reviewSkillMd()).not.toContain("otacon-review-v2");
    // implement-v2 points at this card by name (its wrap step) but neither
    // absorbs the other's protocol: review-v2 never implements nodes or
    // authors packets, and never reopens plan-v2's design-review surfaces.
    expect(text).not.toContain("gt create");
    expect(text).not.toContain("gt repo init");
    expect(text).not.toContain("git worktree add");
    expect(text).not.toContain("design.md");
    expect(text).not.toContain("review-r<N>.md");
    expect(text).not.toContain("start --title <kebab-title>");
    expect(text).not.toContain('{"event":"approved"');
  });
});
