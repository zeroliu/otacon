// The behavioral-assertion grammar (DESIGN.md §4, §9): a ```gwt fence inside a
// phase's Verification holds one or more Given/When/Then scenarios that double
// as the human's Test-Driven Review approve checklist. This tokenizer is the
// single source of truth for what a scenario *is*, shared by the daemon linter
// (shape + budget validation, rules.ts) and the UI scenario cards
// (scenario-card.tsx) so the two can never disagree about the grammar — unlike
// the line grammar, which is deliberately ported (DECISIONS.md), this construct
// is new, so one shared parser is the simpler, drift-proof choice. Purely
// structural: it tokenizes and flags well-formedness; the *verdicts* (empty,
// malformed, over budget) are the linter's (rules.ts).

/**
 * One Given/When/Then scenario. Each clause keeps its full text *after* the
 * keyword; `And`/`But` continuation lines append to the most recent clause
 * (Gherkin-standard). `valid` is the structural test both consumers need: at
 * least one Given, When, and Then, encountered in that order, with no stray
 * lines — the linter rejects an invalid scenario, the UI degrades it.
 */
export interface GwtScenario {
  given: string[];
  when: string[];
  then: string[];
  valid: boolean;
}

export interface GwtParse {
  scenarios: GwtScenario[];
}

// A step line: a leading keyword (case-insensitive) plus the rest as text.
// `And`/`But` continue whichever clause is open.
const STEP_RE = /^(given|when|then|and|but)\b\s*(.*)$/i;

type Clause = "given" | "when" | "then";
const RANK: Record<Clause, number> = { given: 0, when: 1, then: 2 };

/** Tokenize one scenario's non-blank lines into a `GwtScenario`. */
function parseScenario(lines: string[]): GwtScenario {
  const scenario: GwtScenario = { given: [], when: [], then: [], valid: true };
  let clause: Clause | null = null;
  let maxRank = -1;
  for (const line of lines) {
    const match = STEP_RE.exec(line.trim());
    if (!match) {
      scenario.valid = false; // a line that isn't a Given/When/Then/And/But step
      continue;
    }
    const keyword = match[1]!.toLowerCase();
    const text = match[2]!.trim();
    if (keyword === "given" || keyword === "when" || keyword === "then") {
      // Scenarios read top-down: a keyword may not regress (When then Given).
      if (RANK[keyword] < maxRank) scenario.valid = false;
      maxRank = Math.max(maxRank, RANK[keyword]);
      clause = keyword;
    } else if (clause === null) {
      scenario.valid = false; // a dangling And/But with no clause to continue
      continue;
    }
    if (clause) scenario[clause].push(text);
  }
  if (scenario.given.length === 0 || scenario.when.length === 0 || scenario.then.length === 0) {
    scenario.valid = false;
  }
  return scenario;
}

/**
 * Parse a ```gwt fence body into scenarios. Scenarios are separated by one or
 * more blank lines; empty groups (leading/trailing blanks) are dropped.
 */
export function parseGwt(body: string): GwtParse {
  const groups: string[][] = [];
  let current: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) groups.push(current);
  return { scenarios: groups.map(parseScenario) };
}
