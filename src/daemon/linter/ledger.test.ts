import { describe, expect, test } from "bun:test";
import type { Ledger } from "../../shared/types.js";
import { expectedScenarioKeys, validateLedger } from "./ledger.js";
import { parsePlan } from "./parse.js";

function planWith(body: string): string {
  return `---
title: t
session: otc_test01
revision: 1
status: draft
created: 2026-06-24
---

${body}`;
}

const SCEN = (g: string) => `Given ${g}\nWhen x\nThen y`;

// A plan whose Phase 1 has THREE Verification scenarios (two gwt fences: one
// with two scenarios, one with one) and Phase 2 has one — exercises both the
// flat-index-across-fences convention and multi-phase keying.
const threeScenarioPlan = planWith(
  [
    "## Phases",
    "",
    "### Phase 1 — issuance",
    "",
    "Goal: g",
    "Files:",
    "- a.ts",
    "Verification: covered by",
    "```gwt",
    SCEN("a token request"),
    "",
    SCEN("a rotated key"),
    "```",
    "```gwt",
    SCEN("an expired key"),
    "```",
    "",
    "### Phase 2 — middleware",
    "",
    "Goal: g2",
    "Files:",
    "- b.ts",
    "Verification: covered by",
    "```gwt",
    SCEN("a protected route"),
    "```",
    "",
  ].join("\n"),
);

describe("expectedScenarioKeys", () => {
  test("flattens Verification scenarios per phase in document order (0-based)", () => {
    const keys = expectedScenarioKeys(parsePlan(threeScenarioPlan));
    expect(keys.map((k) => ({ phase: k.phase, scenarioIndex: k.scenarioIndex }))).toEqual([
      { phase: 1, scenarioIndex: 0 },
      { phase: 1, scenarioIndex: 1 },
      { phase: 1, scenarioIndex: 2 },
      { phase: 2, scenarioIndex: 0 },
    ]);
    // The label is the scenario's Given line, so an error can name which one.
    expect(keys[0]!.label).toBe("Given a token request");
    expect(keys[2]!.label).toBe("Given an expired key");
  });

  test("only Verification gwt blocks count — gwt under another field is ignored", () => {
    const plan = parsePlan(
      planWith(
        `## Phases\n\n### Phase 1 — x\n\nGoal: g\n\`\`\`gwt\n${SCEN("a")}\n\`\`\`\nVerification: t\n`,
      ),
    );
    expect(expectedScenarioKeys(plan)).toEqual([]);
  });

  test("a plan with no Verification scenarios yields an empty (vacuous) key set", () => {
    const plan = parsePlan(
      planWith("## Phases\n\n### Phase 1 — x\n\nGoal: g\nFiles:\n- a.ts\nVerification: prose only\n"),
    );
    expect(expectedScenarioKeys(plan)).toEqual([]);
  });

  test("two Verification fields in one phase keep a single running flat index", () => {
    // The linter does not forbid a repeated Verification label, so an approved
    // plan can carry two. Their gwt scenarios flatten into ONE 0-based list for
    // the phase — the UI must seed each field's base off the prior field's count
    // (plan-view.tsx) or its badges would land on the wrong scenarios.
    const plan = parsePlan(
      planWith(
        [
          "## Phases",
          "",
          "### Phase 1 — x",
          "",
          "Goal: g",
          "Files:",
          "- a.ts",
          "Verification: first",
          "```gwt",
          SCEN("the first assertion"),
          "```",
          "Verification: second",
          "```gwt",
          SCEN("the second assertion"),
          "```",
          "",
        ].join("\n"),
      ),
    );
    expect(expectedScenarioKeys(plan)).toEqual([
      { phase: 1, scenarioIndex: 0, label: "Given the first assertion" },
      { phase: 1, scenarioIndex: 1, label: "Given the second assertion" },
    ]);
  });
});

describe("validateLedger", () => {
  const expected = expectedScenarioKeys(parsePlan(threeScenarioPlan));

  test("a full pass|skip ledger with evidence has no violations", () => {
    const ledger: Ledger = {
      1: {
        0: { status: "pass", evidence: "ran issuance test" },
        1: { status: "skip", evidence: "rotation deferred, tracked in #12" },
        2: { status: "pass", evidence: "expired-key path covered" },
      },
      2: { 0: { status: "pass", evidence: "integration test green" } },
    };
    expect(validateLedger(expected, ledger)).toEqual([]);
  });

  test("a ledger covering only 2 of 3 phase-1 scenarios flags the missing one by key + label", () => {
    const ledger: Ledger = {
      1: {
        0: { status: "pass", evidence: "ran issuance test" },
        2: { status: "pass", evidence: "expired-key path covered" },
      },
      2: { 0: { status: "pass", evidence: "integration test green" } },
    };
    const violations = validateLedger(expected, ledger);
    expect(violations).toEqual([
      { kind: "missing", phase: 1, scenarioIndex: 1, label: "Given a rotated key" },
    ]);
  });

  test("empty / whitespace evidence is treated as unattested", () => {
    const ledger: Ledger = {
      1: {
        0: { status: "pass", evidence: "ok" },
        1: { status: "pass", evidence: "   " },
        2: { status: "pass", evidence: "" },
      },
      2: { 0: { status: "pass", evidence: "ok" } },
    };
    expect(validateLedger(expected, ledger)).toEqual([
      { kind: "empty-evidence", phase: 1, scenarioIndex: 1, label: "Given a rotated key" },
      { kind: "empty-evidence", phase: 1, scenarioIndex: 2, label: "Given an expired key" },
    ]);
  });

  test("an undefined ledger flags every expected scenario missing", () => {
    expect(validateLedger(expected, undefined)).toHaveLength(expected.length);
    expect(validateLedger(expected, undefined).every((v) => v.kind === "missing")).toBe(true);
  });

  test("an entry the plan does not have is flagged unknown", () => {
    const ledger: Ledger = {
      1: {
        0: { status: "pass", evidence: "ok" },
        1: { status: "pass", evidence: "ok" },
        2: { status: "pass", evidence: "ok" },
        3: { status: "pass", evidence: "stale extra scenario" },
      },
      2: { 0: { status: "pass", evidence: "ok" } },
    };
    expect(validateLedger(expected, ledger)).toEqual([
      { kind: "unknown", phase: 1, scenarioIndex: 3 },
    ]);
  });

  test("a vacuous plan (no scenarios) is satisfied by any ledger, including none", () => {
    expect(validateLedger([], undefined)).toEqual([]);
    expect(validateLedger([], {})).toEqual([]);
  });
});
