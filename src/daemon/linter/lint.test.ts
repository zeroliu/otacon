import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, type OtaconConfig } from "../../shared/config.js";
import type { LintResult } from "../../shared/types.js";
import { lint, type LintOptions } from "./index.js";

const SESSION = "otc_test01";

const FM = `---
title: t
session: ${SESSION}
revision: 1
status: draft
created: 2026-06-13
---
`;
// The default Summary carries a lead diagram — the recommended shape (L7), so
// unrelated "passes clean" cases don't trip the lead-diagram nudge. Tests that
// exercise the nudge override `summary` with a diagram-less one.
const SUMMARY = "## Summary\n\nShip it.\n\n```mermaid\nflowchart LR\n  a --> b\n```\n";
const DECISIONS = "## Decisions\n\n- D1: choice ← q1\n";
const PHASES =
  "## Phases\n\n### Phase 1 — Build\n\nGoal: g\nFiles:\n- a.ts\nVerification: tests\n";
const RISKS = "## Risks\n\n- r1\n";
const OPEN = "## Open Questions\n";

type Part = "fm" | "summary" | "decisions" | "phases" | "risks" | "open";

function doc(parts: Partial<Record<Part, string>> = {}): string {
  return [
    parts.fm ?? FM,
    parts.summary ?? SUMMARY,
    parts.decisions ?? DECISIONS,
    parts.phases ?? PHASES,
    parts.risks ?? RISKS,
    parts.open ?? OPEN,
  ].join("\n");
}

function run(
  content: string,
  options: LintOptions = { session: SESSION },
  config: OtaconConfig = DEFAULT_CONFIG,
): LintResult {
  return lint(content, config, options);
}

function codes(result: LintResult): string[] {
  return [...result.errors, ...result.warnings].map((i) => i.code);
}

describe("lint happy paths", () => {
  test("minimal doc passes clean", () => {
    const result = run(doc());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBeTrue();
  });

  test("the valid fixture passes clean", () => {
    const fixture = readFileSync(
      new URL("../../../test/fixtures/valid-plan.md", import.meta.url),
      "utf8",
    );
    const result = run(fixture);
    expect(codes(result)).toEqual([]);
    expect(result.ok).toBeTrue();
  });
});

describe("L1 schema completeness", () => {
  test("missing frontmatter", () => {
    expect(codes(run(doc({ fm: "" })))).toContain("E_FRONTMATTER_MISSING");
  });

  test("missing frontmatter key", () => {
    const fm = FM.replace(`session: ${SESSION}\n`, "");
    const result = run(doc({ fm }), {});
    expect(codes(result)).toContain("E_FRONTMATTER_KEY");
  });

  test("session mismatch is a hard error", () => {
    const result = run(doc(), { session: "otc_other1" });
    const mismatch = result.errors.find((e) => e.code === "E_SESSION_MISMATCH");
    expect(mismatch).toBeDefined();
  });

  test("unclosed frontmatter surfaces through lint", () => {
    expect(codes(run("---\ntitle: t\n\n## Summary\n"))).toContain(
      "E_FRONTMATTER_UNCLOSED",
    );
  });

  test("unclosed fence surfaces through lint", () => {
    expect(codes(run(doc({ open: "## Open Questions\n\n```\n" })))).toContain(
      "E_UNCLOSED_FENCE",
    );
  });

  test("missing required section", () => {
    const result = run(doc({ risks: "" }));
    const missing = result.errors.find((e) => e.code === "E_SECTION_MISSING");
    expect(missing?.message).toContain("Risks");
  });

  test("sections out of order", () => {
    const content = [FM, DECISIONS, SUMMARY, PHASES, RISKS, OPEN].join("\n");
    expect(codes(run(content))).toContain("E_SECTION_ORDER");
  });

  test("unknown section", () => {
    const result = run(doc({ open: `${OPEN}\n## Notes\n\nstuff\n` }));
    const unknown = result.errors.find((e) => e.code === "E_UNKNOWN_SECTION");
    expect(unknown?.line).toBeGreaterThan(0);
  });

  test("duplicate section", () => {
    expect(codes(run(doc({ open: `${OPEN}\n## Risks\n\n- again\n` })))).toContain(
      "E_DUPLICATE_SECTION",
    );
  });

  test("empty phases section", () => {
    expect(codes(run(doc({ phases: "## Phases\n" })))).toContain("E_PHASES_EMPTY");
  });

  test("invalid phase heading", () => {
    const phases = "## Phases\n\n### Phase one — Build\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n";
    expect(codes(run(doc({ phases })))).toContain("E_PHASE_HEADING");
  });

  test("phase numbering must run 1..N", () => {
    const phases = [
      "## Phases",
      "",
      "### Phase 1 — A",
      "",
      "Goal: g",
      "Files:",
      "- a.ts",
      "Verification: t",
      "",
      "### Phase 3 — B",
      "",
      "Goal: g",
      "Files:",
      "- b.ts",
      "Verification: t",
      "",
    ].join("\n");
    const result = run(doc({ phases }));
    const numbering = result.errors.find((e) => e.code === "E_PHASE_NUMBERING");
    expect(numbering?.message).toContain("3");
  });

  test("missing phase fields are reported individually", () => {
    const phases = "## Phases\n\n### Phase 1 — Build\n\nGoal: g\n";
    const result = run(doc({ phases }));
    const fields = result.errors.filter((e) => e.code === "E_PHASE_FIELD_MISSING");
    expect(fields.map((f) => f.message.includes("Files") || f.message.includes("Verification"))).toEqual([
      true,
      true,
    ]);
  });

  test("files without list items", () => {
    const phases = "## Phases\n\n### Phase 1 — Build\n\nGoal: g\nFiles: none listed\nVerification: t\n";
    expect(codes(run(doc({ phases })))).toContain("E_FILES_EMPTY");
  });

  test("more than one Details block", () => {
    const phases =
      "## Phases\n\n### Phase 1 — Build\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n\n#### Details\n\na\n\n#### Details\n\nb\n";
    expect(codes(run(doc({ phases })))).toContain("E_DETAILS_MULTIPLE");
  });

  test("stray H4 inside a phase", () => {
    const phases =
      "## Phases\n\n### Phase 1 — Build\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n\n#### Notes\n\nx\n";
    expect(codes(run(doc({ phases })))).toContain("E_UNEXPECTED_H4");
  });
});

describe("optional Contract section", () => {
  const CONTRACT = "## Contract\n\n- input: `Plan` markdown\n- output: `LintResult`\n";

  test("present, in order, within budget passes clean", () => {
    const content = [FM, SUMMARY, CONTRACT, DECISIONS, PHASES, RISKS, OPEN].join("\n");
    const result = run(content);
    expect(codes(result)).toEqual([]);
    expect(result.ok).toBeTrue();
  });

  test("absent is fine — the default doc carries no Contract", () => {
    expect(run(doc()).ok).toBeTrue();
  });

  test("out of order (after Decisions) is E_SECTION_ORDER", () => {
    const content = [FM, SUMMARY, DECISIONS, CONTRACT, PHASES, RISKS, OPEN].join("\n");
    expect(codes(run(content))).toContain("E_SECTION_ORDER");
  });

  test("over budget reports E_BUDGET_CONTRACT", () => {
    const contract = `## Contract\n\n${"- field\n".repeat(13)}`;
    const content = [FM, SUMMARY, contract, DECISIONS, PHASES, RISKS, OPEN].join("\n");
    const over = run(content).errors.find((e) => e.code === "E_BUDGET_CONTRACT");
    expect(over).toMatchObject({ budget: 12, actual: 13, section: "contract" });
  });

  test("the one-fence rule applies to Contract too", () => {
    const contract = "## Contract\n\nShape:\n\n```\na\n```\n\n```\nb\n```\n";
    const content = [FM, SUMMARY, contract, DECISIONS, PHASES, RISKS, OPEN].join("\n");
    expect(run(content).errors.find((e) => e.code === "E_FENCE_CAP")).toMatchObject({
      section: "contract",
    });
  });

  test("a still-unknown section stays E_UNKNOWN_SECTION and lists Contract as allowed", () => {
    const result = run(doc({ open: `${OPEN}\n## Notes\n\nstuff\n` }));
    const unknown = result.errors.find((e) => e.code === "E_UNKNOWN_SECTION");
    expect(unknown?.message).toContain("Contract");
  });
});

describe("optional Impact section", () => {
  const IMPACT = "## Impact\n\n- upstream: `src/auth/keys.ts`\n- downstream: every API route\n";

  test("present, in order (after Decisions), within budget passes clean", () => {
    const content = [FM, SUMMARY, DECISIONS, IMPACT, PHASES, RISKS, OPEN].join("\n");
    expect(codes(run(content))).toEqual([]);
  });

  test("Contract + Impact together stay in order", () => {
    const contract = "## Contract\n\n- in: x\n";
    const content = [FM, SUMMARY, contract, DECISIONS, IMPACT, PHASES, RISKS, OPEN].join("\n");
    expect(codes(run(content))).toEqual([]);
  });

  test("out of order (before Decisions) is E_SECTION_ORDER", () => {
    const content = [FM, SUMMARY, IMPACT, DECISIONS, PHASES, RISKS, OPEN].join("\n");
    expect(codes(run(content))).toContain("E_SECTION_ORDER");
  });

  test("over budget reports E_BUDGET_IMPACT", () => {
    const impact = `## Impact\n\n${"- dep\n".repeat(11)}`;
    const content = [FM, SUMMARY, DECISIONS, impact, PHASES, RISKS, OPEN].join("\n");
    const over = run(content).errors.find((e) => e.code === "E_BUDGET_IMPACT");
    expect(over).toMatchObject({ budget: 10, actual: 11, section: "impact" });
  });

  test("a dependency mermaid is exempt from the fence cap", () => {
    const impact = "## Impact\n\n- chain:\n\n```mermaid\nflowchart LR\n  a --> b\n```\n";
    const content = [FM, SUMMARY, DECISIONS, impact, PHASES, RISKS, OPEN].join("\n");
    expect(run(content).ok).toBeTrue();
  });
});

describe("L2 budgets", () => {
  test("summary over budget reports budget and actual", () => {
    const summary = `## Summary\n\n${"line\n".repeat(6)}`;
    const result = run(doc({ summary }));
    const over = result.errors.find((e) => e.code === "E_BUDGET_SUMMARY");
    expect(over).toMatchObject({ budget: 5, actual: 6, section: "summary" });
  });

  test("fence content is exempt from the summary budget", () => {
    const summary = `## Summary\n\nShip it.\n\n\`\`\`mermaid\n${"node\n".repeat(30)}\`\`\`\n`;
    expect(run(doc({ summary })).ok).toBeTrue();
  });

  test("decision entry over budget", () => {
    const decisions = "## Decisions\n\n- D1: choice ← q1\n  a\n  b\n  c\n";
    const result = run(doc({ decisions }));
    const over = result.errors.find((e) => e.code === "E_BUDGET_DECISION");
    expect(over).toMatchObject({ budget: 3, actual: 4 });
  });

  test("goal and verification over budget", () => {
    const phases =
      "## Phases\n\n### Phase 1 — Build\n\nGoal: a\nb\nc\nd\nFiles:\n- a.ts\nVerification: a\nb\nc\nd\n";
    const result = run(doc({ phases }));
    expect(codes(result)).toContain("E_BUDGET_GOAL");
    expect(codes(result)).toContain("E_BUDGET_VERIFICATION");
  });

  test("too many risks", () => {
    const risks = `## Risks\n\n${"- r\n".repeat(6)}`;
    const result = run(doc({ risks }));
    const over = result.errors.find((e) => e.code === "E_BUDGET_RISKS_COUNT");
    expect(over).toMatchObject({ budget: 5, actual: 6 });
  });

  test("risk entry over budget", () => {
    const risks = "## Risks\n\n- r1\n  more\n  even more\n";
    expect(codes(run(doc({ risks })))).toContain("E_BUDGET_RISK_ENTRY");
  });

  test("fence cap in a read-path section", () => {
    const summary = "## Summary\n\nShip it.\n\n```\na\n```\n\n```\nb\n```\n";
    const result = run(doc({ summary }));
    const cap = result.errors.find((e) => e.code === "E_FENCE_CAP");
    expect(cap).toMatchObject({ section: "summary", budget: 1, actual: 2 });
  });

  test("two mermaid diagrams in a read-path section do not trip the fence cap", () => {
    const summary =
      "## Summary\n\nShip it.\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\n```mermaid\nflowchart LR\n  c --> d\n```\n";
    const result = run(doc({ summary }));
    expect(result.errors.find((e) => e.code === "E_FENCE_CAP")).toBeUndefined();
    expect(result.ok).toBeTrue();
  });

  test("a mermaid diagram alongside a code fence stays under the one-fence cap", () => {
    const summary =
      "## Summary\n\nShip it.\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\n```ts\nconst x = 1;\n```\n";
    const result = run(doc({ summary }));
    expect(result.errors.find((e) => e.code === "E_FENCE_CAP")).toBeUndefined();
    expect(result.ok).toBeTrue();
  });

  test("fence cap applies to a phase's read path but not Details", () => {
    const overCap =
      "## Phases\n\n### Phase 1 — Build\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n```\na\n```\n```\nb\n```\n";
    const result = run(doc({ phases: overCap }));
    expect(result.errors.find((e) => e.code === "E_FENCE_CAP")).toMatchObject({
      section: "phase-1",
    });

    const inDetails =
      "## Phases\n\n### Phase 1 — Build\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n\n#### Details\n\n```\na\n```\n\n```\nb\n```\n";
    expect(run(doc({ phases: inDetails })).ok).toBeTrue();
  });

  test("budgets are config-driven", () => {
    const summary = `## Summary\n\n${"line\n".repeat(6)}`;
    const config: OtaconConfig = {
      ...DEFAULT_CONFIG,
      budgets: { ...DEFAULT_CONFIG.budgets, summaryLines: 10 },
      activity: { ...DEFAULT_CONFIG.activity },
    };
    expect(run(doc({ summary }), { session: SESSION }, config).ok).toBeTrue();
  });

  test("visual cap: two callouts pass, a third fails", () => {
    const callout = (type: string, body: string) => `> [!${type}]\n> ${body}\n`;
    const atCap = `## Summary\n\nShip it.\n\n${callout("risk", "a")}\n${callout("note", "b")}`;
    expect(run(doc({ summary: atCap })).ok).toBeTrue();

    const overCap = `${atCap}\n${callout("decision", "c")}`;
    const result = run(doc({ summary: overCap }));
    expect(result.errors.find((e) => e.code === "E_VISUAL_CAP")).toMatchObject({
      section: "summary",
      budget: 2,
      actual: 3,
    });
  });

  test("visual cap applies to a phase's read path but not Details", () => {
    const overCap =
      "## Phases\n\n### Phase 1 — Build\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n\n> [!risk]\n> a\n\n> [!note]\n> b\n\n> [!decision]\n> c\n";
    expect(run(doc({ phases: overCap })).errors.find((e) => e.code === "E_VISUAL_CAP")).toMatchObject({
      section: "phase-1",
    });

    const inDetails =
      "## Phases\n\n### Phase 1 — Build\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n\n#### Details\n\n> [!risk]\n> a\n\n> [!note]\n> b\n\n> [!decision]\n> c\n";
    expect(run(doc({ phases: inDetails })).ok).toBeTrue();
  });

  test("visual cap is config-driven", () => {
    const summary = `## Summary\n\nShip it.\n\n> [!risk]\n> a\n\n> [!note]\n> b\n\n> [!decision]\n> c\n`;
    const config: OtaconConfig = {
      ...DEFAULT_CONFIG,
      budgets: { ...DEFAULT_CONFIG.budgets, maxVisualsPerReadSection: 3 },
    };
    expect(run(doc({ summary }), { session: SESSION }, config).ok).toBeTrue();
  });
});

describe("gwt behavioral assertions", () => {
  const phaseWithGwt = (gwt: string): string =>
    `## Phases\n\n### Phase 1 — Build\n\nGoal: g\nFiles:\n- a.ts\nVerification: tests\n${gwt}\n`;
  const block = (body: string): string => `\`\`\`gwt\n${body}\n\`\`\``;

  test("a well-formed gwt block under Verification passes clean", () => {
    const phases = phaseWithGwt(block("Given a fresh session\nWhen the agent submits\nThen review opens"));
    expect(codes(run(doc({ phases })))).toEqual([]);
  });

  test("a gwt block outside Verification is E_GWT_PLACEMENT", () => {
    const phases =
      `## Phases\n\n### Phase 1 — Build\n\nGoal: g\n${block("Given a\nWhen b\nThen c")}\nFiles:\n- a.ts\nVerification: t\n`;
    expect(codes(run(doc({ phases })))).toContain("E_GWT_PLACEMENT");
  });

  test("an empty gwt block is E_GWT_EMPTY", () => {
    expect(codes(run(doc({ phases: phaseWithGwt(block("")) })))).toContain("E_GWT_EMPTY");
  });

  test("a scenario missing Then is E_GWT_MALFORMED, not empty", () => {
    const result = run(doc({ phases: phaseWithGwt(block("Given a\nWhen b")) }));
    expect(codes(result)).toContain("E_GWT_MALFORMED");
    expect(codes(result)).not.toContain("E_GWT_EMPTY");
  });

  test("too many scenarios is E_BUDGET_GWT", () => {
    const many = Array.from({ length: 7 }, (_, i) => `Given g${i}\nWhen w${i}\nThen t${i}`).join("\n\n");
    const over = run(doc({ phases: phaseWithGwt(block(many)) })).errors.find(
      (e) => e.code === "E_BUDGET_GWT",
    );
    expect(over).toMatchObject({ budget: 6, actual: 7, section: "phase-1" });
  });

  test("the gwt scenario budget is config-driven", () => {
    const many = Array.from({ length: 7 }, (_, i) => `Given g${i}\nWhen w${i}\nThen t${i}`).join("\n\n");
    const config: OtaconConfig = {
      ...DEFAULT_CONFIG,
      budgets: { ...DEFAULT_CONFIG.budgets, gwtMaxScenarios: 7 },
    };
    expect(run(doc({ phases: phaseWithGwt(block(many)) }), { session: SESSION }, config).ok).toBeTrue();
  });

  test("a gwt block in a non-phase section is E_GWT_PLACEMENT, not a silent fence", () => {
    // The UI renders any ```gwt fence as scenario cards regardless of section, so
    // a block in Summary must be rejected here rather than slip through budgeted.
    const summary = `## Summary\n\nShip it.\n${block("Given a\nWhen b\nThen c")}\n`;
    const result = run(doc({ summary }));
    const placement = result.errors.find((e) => e.code === "E_GWT_PLACEMENT");
    expect(placement).toMatchObject({ rule: "L1", section: "summary" });
  });

  test("a malformed gwt block in a non-phase section still reports its shape", () => {
    const summary = `## Summary\n\nShip it.\n${block("Given a\nWhen b")}\n`;
    expect(codes(run(doc({ summary })))).toContain("E_GWT_MALFORMED");
  });
});

describe("L6 details soft cap", () => {
  function phasesWithDetails(lines: number): string {
    return `## Phases\n\n### Phase 1 — Build\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n\n#### Details\n${"x\n".repeat(lines)}`;
  }

  test("81 raw lines warns but stays ok", () => {
    const result = run(doc({ phases: phasesWithDetails(81) }));
    expect(result.ok).toBeTrue();
    const warning = result.warnings.find((w) => w.code === "W_DETAILS_SOFT_CAP");
    expect(warning).toMatchObject({ budget: 80, actual: 81, section: "phase-1" });
  });

  test("80 raw lines is clean", () => {
    const result = run(doc({ phases: phasesWithDetails(80) }));
    expect(codes(result)).toEqual([]);
  });
});

describe("lead diagram nudge (L7)", () => {
  const noDiagram = "## Summary\n\nShip it.\n";
  const withDiagram = "## Summary\n\nShip it.\n\n```mermaid\nflowchart LR\n  a --> b\n```\n";
  const optedOut = "## Summary\n\nShip it.\n\n<!-- no-lead-diagram: pure docs change -->\n";

  test("a Summary with a lead diagram is clean", () => {
    expect(codes(run(doc({ summary: withDiagram })))).toEqual([]);
  });

  test("no diagram nudges — a warning, never a blocking error", () => {
    const result = run(doc({ summary: noDiagram }));
    expect(result.ok).toBeTrue();
    expect(result.errors).toEqual([]);
    const nudge = result.warnings.find((w) => w.code === "W_LEAD_DIAGRAM_MISSING");
    expect(nudge).toMatchObject({ rule: "L7", severity: "warning", section: "summary" });
  });

  test("the no-lead-diagram escape hatch suppresses the nudge", () => {
    expect(codes(run(doc({ summary: optedOut })))).toEqual([]);
  });

  test("the opt-out marker is chrome — it does not spend a Summary line", () => {
    // Five content lines plus the marker: 6 budgeted lines if the marker counted
    // (it must not), so this stays within the ≤5 Summary budget.
    const summary = `## Summary\n\n${"line\n".repeat(5)}<!-- no-lead-diagram: n/a -->\n`;
    const result = run(doc({ summary }));
    expect(result.errors.find((e) => e.code === "E_BUDGET_SUMMARY")).toBeUndefined();
  });
});

describe("frontmatter authority warnings", () => {
  test("non-integer revision warns", () => {
    const fm = FM.replace("revision: 1", "revision: soon");
    const result = run(doc({ fm }));
    expect(result.ok).toBeTrue();
    expect(codes(result)).toContain("W_REVISION_INVALID");
  });

  test("revision mismatch against daemon expectation warns", () => {
    const result = run(doc(), { session: SESSION, expectedRevision: 3 });
    expect(result.ok).toBeTrue();
    expect(codes(result)).toContain("W_REVISION_MISMATCH");
  });

  test("unknown status warns", () => {
    const fm = FM.replace("status: draft", "status: cooking");
    expect(codes(run(doc({ fm })))).toContain("W_STATUS_INVALID");
  });

  test("status differing from daemon expectation warns", () => {
    const result = run(doc(), { session: SESSION, expectedStatus: "in_review" });
    expect(codes(result)).toContain("W_STATUS_UNEXPECTED");
  });

  test("matching expectations stay silent", () => {
    const result = run(doc(), {
      session: SESSION,
      expectedRevision: 1,
      expectedStatus: "draft",
    });
    expect(codes(result)).toEqual([]);
  });
});

describe("L5 thread resolutions and changelog", () => {
  const l5 = (
    ctx: Partial<NonNullable<LintOptions["resolutions"]>> = {},
  ): LintResult =>
    run(doc(), {
      session: SESSION,
      resolutions: { revision: 2, commentThreads: [], replies: {}, ...ctx },
    });

  test("no threads, with a changelog: clean", () => {
    expect(l5({ changelog: "tightened phase 1" }).ok).toBeTrue();
  });

  test("L5 never runs without a daemon-composed context", () => {
    // Raw lint() of a resubmittable doc stays L5-silent (e.g. unit callers).
    expect(run(doc()).ok).toBeTrue();
  });

  test("every open comment thread needs a reply this submit doesn't carry", () => {
    const result = l5({
      changelog: "c",
      commentThreads: [
        { id: "t1", replied: false, resolved: false }, // gets a reply below → ok
        { id: "t2", replied: false, resolved: false }, // no reply → error
        { id: "t3", replied: false, resolved: false }, // no reply → error
      ],
      replies: { t1: "moved to phase 2" },
    });
    expect(result.ok).toBeFalse();
    const unresolved = result.errors.filter((e) => e.code === "E_THREAD_UNRESOLVED");
    expect(unresolved.map((e) => e.thread)).toEqual(["t2", "t3"]);
    expect(unresolved[0]?.rule).toBe("L5");
  });

  test("a reviewer-resolved comment is skipped (no deadlock) but an un-replied one still demands a reply", () => {
    const result = l5({
      changelog: "c",
      commentThreads: [
        { id: "t1", replied: false, resolved: true }, // reviewer withdrew → skipped
        { id: "t2", replied: false, resolved: false }, // open → still demands a reply
      ],
      replies: {},
    });
    expect(result.ok).toBeFalse();
    const unresolved = result.errors.filter((e) => e.code === "E_THREAD_UNRESOLVED");
    expect(unresolved.map((e) => e.thread)).toEqual(["t2"]);
  });

  test("an already-replied comment needs no fresh reply", () => {
    const result = l5({
      changelog: "c",
      commentThreads: [{ id: "t1", replied: true, resolved: false }],
      replies: {},
    });
    expect(result.ok).toBeTrue();
  });

  test("unknown thread ids and blank replies are errors", () => {
    const result = l5({
      changelog: "c",
      commentThreads: [{ id: "t1", replied: false, resolved: false }],
      replies: { t1: "  ", t9: "ghost", q1: "questions are answered, not replied" },
    });
    expect(result.errors.map((e) => e.code).sort()).toEqual([
      "E_EMPTY_RESOLUTION",
      "E_UNKNOWN_THREAD",
      "E_UNKNOWN_THREAD",
    ]);
  });

  test("re-replying to an already-replied thread is allowed (at-least-once)", () => {
    const result = l5({
      changelog: "c",
      commentThreads: [{ id: "t1", replied: true, resolved: false }],
      replies: { t1: "same reply, retried submit" },
    });
    expect(result.ok).toBeTrue();
  });

  test("in a comment conversation, only un-replied turns are demanded (not re-demanded)", () => {
    // A 3-turn conversation: t1 already replied, t2 un-replied, t3 un-replied —
    // commentThreadStates flattens to one state per turn. L5 demands a reply only
    // for the un-replied turns and never re-demands t1.
    const result = l5({
      changelog: "c",
      commentThreads: [
        { id: "t1", replied: true, resolved: false },
        { id: "t2", replied: false, resolved: false },
        { id: "t3", replied: false, resolved: false },
      ],
      replies: { t2: "fixed" }, // t2 answered this submit; t3 left open
    });
    expect(result.ok).toBeFalse();
    const unresolved = result.errors.filter((e) => e.code === "E_THREAD_UNRESOLVED");
    expect(unresolved.map((e) => e.thread)).toEqual(["t3"]);
  });

  test("resolving the root clears the whole comment conversation from L5 (no deadlock)", () => {
    // Resolving the root sets resolved:true on every turn (commentThreadStates),
    // so L5 demands a reply on none of them — the conversation submits clean.
    const result = l5({
      changelog: "c",
      commentThreads: [
        { id: "t1", replied: false, resolved: true },
        { id: "t2", replied: false, resolved: true },
        { id: "t3", replied: true, resolved: true },
      ],
      replies: {},
    });
    expect(result.ok).toBeTrue();
  });

  test("revisions ≥ 2 need a changelog; r1 and whitespace-only do not pass it off", () => {
    expect(l5().errors.map((e) => e.code)).toEqual(["E_CHANGELOG_MISSING"]);
    expect(l5({ changelog: "  \n" }).errors.map((e) => e.code)).toEqual(["E_CHANGELOG_MISSING"]);
    expect(
      run(doc(), {
        session: SESSION,
        resolutions: { revision: 1, commentThreads: [], replies: {} },
      }).ok,
    ).toBeTrue();
  });
});

describe("L3 decision traceability", () => {
  const l3 = (
    decisions: string,
    ctx: Partial<NonNullable<LintOptions["grill"]>> = {},
  ): LintResult =>
    run(doc({ decisions }), {
      session: SESSION,
      grill: { quick: false, knownQuestions: ["q1", "q2"], ...ctx },
    });

  test("L3 never runs without a daemon-composed context", () => {
    expect(run(doc({ decisions: "## Decisions\n\n- D1: untraced\n" })).ok).toBeTrue();
  });

  test("citations of transcript questions and [assumed] both pass", () => {
    const result = l3(
      "## Decisions\n\n- D1: choice ← q1\n- D2: other ← q1, q2\n- D3: guessed [assumed]\n",
    );
    expect(result.ok).toBeTrue();
    expect(result.warnings).toEqual([]);
  });

  test("an entry with neither citation nor [assumed] is an error", () => {
    const result = l3("## Decisions\n\n- D1: silently decided\n");
    expect(result.errors.map((e) => e.code)).toEqual(["E_DECISION_UNTRACED"]);
    expect(result.errors[0]).toMatchObject({ rule: "L3", section: "decisions", line: 20 });
  });

  test("a citation on a continuation line still counts", () => {
    expect(l3("## Decisions\n\n- D1: long decision\n  ← q2\n").ok).toBeTrue();
  });

  test("ASCII arrow citations are accepted alongside ←", () => {
    expect(l3("## Decisions\n\n- D1: choice <- q1\n").ok).toBeTrue();
  });

  test("cited q ids must exist in the transcript", () => {
    const result = l3("## Decisions\n\n- D1: choice ← q9\n- D2: pair ← q1, q7\n");
    const cited = result.errors.filter((e) => e.code === "E_UNKNOWN_QUESTION_CITED");
    expect(cited).toHaveLength(2);
    expect(cited.map((e) => e.message)).toEqual([
      expect.stringContaining("q9"),
      expect.stringContaining("q7"),
    ]);
  });

  test("every citation clause in an entry is validated, not just the first", () => {
    const result = l3("## Decisions\n\n- D1: choice ← q1; revisit later ← q9\n");
    expect(result.errors.map((e) => e.code)).toEqual(["E_UNKNOWN_QUESTION_CITED"]);
    expect(result.errors[0]?.message).toContain("q9");
  });

  test("--quick downgrades every L3 issue to a warning", () => {
    const result = l3("## Decisions\n\n- D1: untraced\n- D2: ghost ← q9\n", { quick: true });
    expect(result.ok).toBeTrue();
    expect(result.warnings.map((w) => w.code).sort()).toEqual([
      "E_DECISION_UNTRACED",
      "E_UNKNOWN_QUESTION_CITED",
    ]);
  });

  test("non-D list items in Decisions are not L3's business", () => {
    expect(l3("## Decisions\n\n- a plain note without a D label\n").ok).toBeTrue();
  });
});
