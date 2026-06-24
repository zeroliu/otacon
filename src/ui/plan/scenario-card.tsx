// Behavioral-assertion cards (plan structure, lint, and anchoring, threaded review and revision, review UI): a ```gwt fence in a
// phase's Verification renders as Given/When/Then scenario cards — the human's
// Test-Driven Review approve checklist. The grammar is the shared tokenizer
// (src/shared/gwt.ts), the same one the daemon linter validates with, so what
// the agent must write and what the reviewer sees can never drift. The clause
// text stays the plan markdown's own words (keyword included) so a comment can
// still anchor to a scenario line; the keyword is inked as a label. A block
// that yields no scenarios degrades to a plain fence (defensive — a stored
// revision already passed the linter).

import { useMemo } from "react";
import { parseGwt, type GwtScenario } from "../../shared/gwt";
import type { Ledger } from "../../shared/types";
import { CodeFence } from "./code";
import type { FenceBlock } from "./parse";

function ClauseRows({ kind, lines }: { kind: "given" | "when" | "then"; lines: string[] }) {
  const label = kind[0]!.toUpperCase() + kind.slice(1);
  return (
    <>
      {lines.map((text, i) => (
        <p key={i} className={`gwt-step gwt-${kind}`}>
          <span className="gwt-kw">{i === 0 ? label : "and"}</span>
          <span className="gwt-text"> {text}</span>
        </p>
      ))}
    </>
  );
}

/**
 * The verify-before-merge attestation chip (Phase 2): on a built session whose
 * implement-done attested this scenario, show "verified" (status pass) or
 * "skipped" (status skip) with the agent's evidence as a tooltip. Degrades to
 * nothing when there is no ledger entry — so a pre-implementation plan is
 * unchanged.
 */
function VerifyBadge({ entry }: { entry?: { status: "pass" | "skip"; evidence: string } }) {
  if (!entry) return null;
  const verified = entry.status === "pass";
  return (
    <span
      className={`gwt-badge gwt-badge-${verified ? "verified" : "skipped"}`}
      title={entry.evidence}
    >
      {verified ? "verified" : "skipped"}
    </span>
  );
}

function ScenarioCard({
  scenario,
  n,
  entry,
}: {
  scenario: GwtScenario;
  n: number;
  entry?: { status: "pass" | "skip"; evidence: string };
}) {
  return (
    <article className="gwt-card" role="listitem">
      <span className="gwt-n" aria-hidden="true">
        {String(n).padStart(2, "0")}
      </span>
      <div className="gwt-clauses">
        <ClauseRows kind="given" lines={scenario.given} />
        <ClauseRows kind="when" lines={scenario.when} />
        <ClauseRows kind="then" lines={scenario.then} />
      </div>
      <VerifyBadge entry={entry} />
    </article>
  );
}

/**
 * `phase`, `base`, and `ledger` thread the verify-before-merge attestation in:
 * `base` is the count of Verification scenarios in earlier gwt fences of this
 * same phase, so `base + i` is the scenario's flat index — computed identically
 * to the daemon's canonical (phase, flat index) key convention (ledger.ts).
 */
export function ScenarioCards({
  fence,
  phase,
  base = 0,
  ledger,
}: {
  fence: FenceBlock;
  phase?: number;
  base?: number;
  ledger?: Ledger;
}) {
  const scenarios = useMemo(() => parseGwt(fence.code).scenarios, [fence]);
  if (scenarios.length === 0) return <CodeFence fence={fence} label="gwt" />;
  return (
    <div className="gwt" role="list" aria-label="behavioral assertions">
      {scenarios.map((scenario, i) => (
        <ScenarioCard
          key={i}
          scenario={scenario}
          n={i + 1}
          entry={phase !== undefined ? ledger?.[phase]?.[base + i] : undefined}
        />
      ))}
    </div>
  );
}
