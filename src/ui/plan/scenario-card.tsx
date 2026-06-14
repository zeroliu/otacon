// Behavioral-assertion cards (DESIGN.md §4, §9, §10): a ```gwt fence in a
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

function ScenarioCard({ scenario, n }: { scenario: GwtScenario; n: number }) {
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
    </article>
  );
}

export function ScenarioCards({ fence }: { fence: FenceBlock }) {
  const scenarios = useMemo(() => parseGwt(fence.code).scenarios, [fence]);
  if (scenarios.length === 0) return <CodeFence fence={fence} label="gwt" />;
  return (
    <div className="gwt" role="list" aria-label="behavioral assertions">
      {scenarios.map((scenario, i) => (
        <ScenarioCard key={i} scenario={scenario} n={i + 1} />
      ))}
    </div>
  );
}
