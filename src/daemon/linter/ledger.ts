// The verify-before-merge gate's pure core (Phase 2): from a parsed plan it
// derives which behavioral scenarios an `implement-done` must attest, and from a
// supplied ledger it reports what is still unverified. This is to behavior what
// the L5 rule is to comment threads — a hard gate on a terminal transition —
// kept pure and free of any I/O so it is exhaustively unit-testable; the route
// (app.ts) loads the plan and persists the ledger, this module only judges.
//
// CANONICAL KEY CONVENTION (the one place it is defined; the UI mirrors it):
// for each phase, flatten ALL scenarios from that phase's `Verification` gwt
// blocks in document order into a 0-based list — the inner key is that flat
// index. The outer key is the integer from the `### Phase <n> — name` heading.

import type { Ledger } from "../../shared/types.js";
import type { GwtScenario } from "../../shared/gwt.js";
import type { ParsedPlan } from "./parse.js";

/** One scenario the gate expects attested: its (phase, flat index) key plus a
 * short human label (the Given line) for naming it in an E_UNVERIFIED error. */
export interface ExpectedScenario {
  phase: number;
  scenarioIndex: number;
  label: string;
}

/** A short, human-facing label for a scenario — its first Given clause (or a
 * fallback), so an E_UNVERIFIED error names *which* assertion is unattested. */
function scenarioLabel(scenario: GwtScenario): string {
  const given = scenario.given[0]?.trim();
  return given ? `Given ${given}` : "(scenario)";
}

/**
 * The scenarios a successful implement-done must attest, in (phase, flat index)
 * order. Only `Verification` gwt blocks count; a phase with no such scenarios
 * contributes nothing (the gate is vacuous when the whole plan has none). A
 * phase with an unparsable heading (`n === -1`) is skipped — it cannot be keyed.
 */
export function expectedScenarioKeys(plan: ParsedPlan): ExpectedScenario[] {
  const expected: ExpectedScenario[] = [];
  const phases = plan.sections.find((s) => s.id === "phases")?.phases ?? [];
  for (const phase of phases) {
    if (phase.n < 0) continue;
    let scenarioIndex = 0;
    for (const block of phase.gwtBlocks) {
      if (block.field !== "verification") continue;
      for (const scenario of block.scenarios) {
        expected.push({ phase: phase.n, scenarioIndex, label: scenarioLabel(scenario) });
        scenarioIndex += 1;
      }
    }
  }
  return expected;
}

/** Why one expected scenario is not satisfied by the supplied ledger. */
export type LedgerViolation =
  | { kind: "missing"; phase: number; scenarioIndex: number; label: string }
  | { kind: "empty-evidence"; phase: number; scenarioIndex: number; label: string }
  | { kind: "unknown"; phase: number; scenarioIndex: number };

/**
 * Validate a ledger against the expected scenarios. A scenario is satisfied
 * only by an entry with a valid status (`pass`|`skip`) AND non-empty (after
 * trim) evidence; anything else is `missing`/`empty-evidence`. Ledger entries
 * that key a (phase, index) the plan does not have are reported `unknown` so a
 * stale ledger can't pass by over-covering. Returns [] when fully attested.
 */
export function validateLedger(
  expected: ExpectedScenario[],
  ledger: Ledger | undefined,
): LedgerViolation[] {
  const violations: LedgerViolation[] = [];
  const safeLedger = ledger ?? {};
  const seen = new Set<string>();
  for (const { phase, scenarioIndex, label } of expected) {
    seen.add(`${phase}:${scenarioIndex}`);
    const entry = safeLedger[phase]?.[scenarioIndex];
    if (!entry || (entry.status !== "pass" && entry.status !== "skip")) {
      violations.push({ kind: "missing", phase, scenarioIndex, label });
    } else if (typeof entry.evidence !== "string" || entry.evidence.trim() === "") {
      violations.push({ kind: "empty-evidence", phase, scenarioIndex, label });
    }
  }
  for (const phaseKey of Object.keys(safeLedger)) {
    const phase = Number(phaseKey);
    for (const indexKey of Object.keys(safeLedger[phase] ?? {})) {
      const scenarioIndex = Number(indexKey);
      if (!seen.has(`${phase}:${scenarioIndex}`)) {
        violations.push({ kind: "unknown", phase, scenarioIndex });
      }
    }
  }
  return violations;
}
