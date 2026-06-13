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
const SUMMARY = "## Summary\n\nShip it.\n";
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

  test("every open comment thread needs a reply; resolved ones do not", () => {
    const result = l5({
      changelog: "c",
      commentThreads: [
        { id: "t1", resolved: false },
        { id: "t2", resolved: true },
        { id: "t3", resolved: false },
      ],
      replies: { t1: "moved to phase 2" },
    });
    expect(result.ok).toBeFalse();
    const unresolved = result.errors.filter((e) => e.code === "E_THREAD_UNRESOLVED");
    expect(unresolved.map((e) => e.thread)).toEqual(["t3"]);
    expect(unresolved[0]?.rule).toBe("L5");
  });

  test("unknown thread ids and blank replies are errors", () => {
    const result = l5({
      changelog: "c",
      commentThreads: [{ id: "t1", resolved: false }],
      replies: { t1: "  ", t9: "ghost", q1: "questions are answered, not resolved" },
    });
    expect(result.errors.map((e) => e.code).sort()).toEqual([
      "E_EMPTY_RESOLUTION",
      "E_UNKNOWN_THREAD",
      "E_UNKNOWN_THREAD",
    ]);
  });

  test("re-resolving an already-resolved thread is allowed (at-least-once)", () => {
    const result = l5({
      changelog: "c",
      commentThreads: [{ id: "t1", resolved: true }],
      replies: { t1: "same reply, retried submit" },
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
    expect(result.errors[0]).toMatchObject({ rule: "L3", section: "decisions", line: 15 });
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
