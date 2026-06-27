import type { Budgets } from "../../shared/config.js";
import type { LintIssue, LintSeverity } from "../../shared/types.js";
import { CITATION_RE, SESSION_STATUSES } from "../../shared/types.js";
import type { GwtBlock, ParsedPlan, Phase } from "./parse.js";

// Rule semantics follow the plan grammar and lint rules; resolved edge cases follow
// DECISIONS.md ("Schema is closed", "Frontmatter authority", "Plan grammar").

const REQUIRED_FRONTMATTER_KEYS = [
  "title",
  "session",
  "revision",
  "status",
  "created",
] as const;

/**
 * The H2 sections in canonical order. Optional sections (Contract, Impact) are
 * linted when present but never required (plan structure, lint, and anchoring, q3): a trivial plan
 * stays minimal, a complex one scales up. The order check tolerates absent
 * optionals — it compares the sections found against this order filtered to the
 * ones actually present, so dropping an optional never trips E_SECTION_ORDER.
 */
const ORDERED_SECTIONS: readonly { id: string; title: string; optional?: boolean }[] = [
  { id: "summary", title: "Summary" },
  { id: "contract", title: "Contract", optional: true },
  { id: "decisions", title: "Decisions" },
  { id: "impact", title: "Impact", optional: true },
  { id: "phases", title: "Phases" },
  { id: "risks", title: "Risks" },
  { id: "open-questions", title: "Open Questions" },
];

/** All sections the schema accepts, for the unknown-section message. */
const KNOWN_SECTION_TITLES = ORDERED_SECTIONS.map((s) => s.title).join(", ");

const REQUIRED_PHASE_FIELDS = [
  { name: "goal", label: "Goal" },
  { name: "files", label: "Files" },
  { name: "verification", label: "Verification" },
] as const;

function issue(
  rule: LintIssue["rule"],
  code: string,
  severity: LintSeverity,
  message: string,
  extra: Partial<LintIssue> = {},
): LintIssue {
  return { rule, code, severity, message, ...extra };
}

function phaseSlug(phase: Phase): string {
  return phase.headingValid ? `phase-${phase.n}` : "phases";
}

/**
 * A GFM table delimiter row: ignoring spaces, only `|`, `:`, `-`, with at least
 * one `-` and at least one column segment (an `isTableDelimiter` sibling in
 * parse.ts gates the parser's table primitive; this one gates the Files-table
 * verdict). Detection is deliberately ≥1 column, not ≥2: a single-column table
 * is still a table — it just earns the "needs a What changed column" verdict, so
 * we must recognize it rather than treat it as not-a-table.
 */
function isDelimiterRow(text: string): boolean {
  const compact = text.replace(/\s/g, "");
  if (!compact.includes("-")) return false;
  if (!/^[|:-]+$/.test(compact)) return false;
  return splitCells(text).length >= 1;
}

/**
 * Split a GFM table row into trimmed cells. Splits on `|` that is NOT escaped
 * (`\|`, a literal pipe inside a cell), then drops the empty leading/trailing
 * cells the row's outer pipes produce. The remaining count is the column count.
 */
function splitCells(text: string): string[] {
  const cells = text
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
  while (cells.length > 0 && cells[0] === "") cells.shift();
  while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/**
 * Locate a GFM table in a Files field's captured content lines: a delimiter row
 * whose immediately-preceding content line is the header. Returns the header,
 * delimiter, and body rows (everything after the delimiter), or null if the
 * field is authored as a list (or anything that isn't a table). Structural data
 * only — the verdict (≥2 columns, non-empty "What changed") lives in the caller.
 */
function findFilesTable(
  contentLines: { text: string; line: number }[],
): { header: { text: string; line: number }; body: { text: string; line: number }[] } | null {
  for (let i = 1; i < contentLines.length; i++) {
    if (isDelimiterRow(contentLines[i]!.text)) {
      return { header: contentLines[i - 1]!, body: contentLines.slice(i + 1) };
    }
  }
  return null;
}

/**
 * The shape verdicts shared by every gwt block, wherever it sits: empty (no
 * scenario) and malformed (a scenario that doesn't read Given… When… Then…).
 * `where` prefixes the message ("Phase 2", "Section ## Summary"); `slug` anchors
 * the issue. Scenarios are pre-tokenized at parse time, so this never re-parses.
 */
function checkGwtShape(issues: LintIssue[], gwt: GwtBlock, where: string, slug: string): void {
  if (gwt.scenarios.length === 0) {
    issues.push(
      issue(
        "L1",
        "E_GWT_EMPTY",
        "error",
        `${where} has an empty \`gwt\` block — add at least one Given/When/Then scenario`,
        { line: gwt.startLine, section: slug },
      ),
    );
  }
  gwt.scenarios.forEach((scenario, i) => {
    if (!scenario.valid) {
      issues.push(
        issue(
          "L1",
          "E_GWT_MALFORMED",
          "error",
          `${where} \`gwt\` scenario ${i + 1} must read Given… When… Then… (in order)`,
          { line: gwt.startLine, section: slug },
        ),
      );
    }
  });
}

export function checkL1(plan: ParsedPlan, session?: string): LintIssue[] {
  const issues: LintIssue[] = [];

  if (plan.frontmatter === null) {
    issues.push(
      issue("L1", "E_FRONTMATTER_MISSING", "error", "Plan has no frontmatter block", {
        line: 1,
      }),
    );
  } else {
    for (const key of REQUIRED_FRONTMATTER_KEYS) {
      if (!plan.frontmatter[key]) {
        issues.push(
          issue("L1", "E_FRONTMATTER_KEY", "error", `Frontmatter is missing "${key}"`, {
            line: 1,
          }),
        );
      }
    }
    if (session && plan.frontmatter.session && plan.frontmatter.session !== session) {
      issues.push(
        issue(
          "L1",
          "E_SESSION_MISMATCH",
          "error",
          `Frontmatter session "${plan.frontmatter.session}" does not match target session "${session}"`,
          { line: 1 },
        ),
      );
    }
  }

  const knownIds = ORDERED_SECTIONS.map((s) => s.id);
  const seen = new Set<string>();
  const firstOccurrences: string[] = [];
  for (const section of plan.sections) {
    if (!knownIds.includes(section.id)) {
      issues.push(
        issue(
          "L1",
          "E_UNKNOWN_SECTION",
          "error",
          `Unknown section "## ${section.title}" — the schema allows only ${KNOWN_SECTION_TITLES}`,
          { line: section.startLine, section: section.id },
        ),
      );
    } else if (seen.has(section.id)) {
      issues.push(
        issue(
          "L1",
          "E_DUPLICATE_SECTION",
          "error",
          `Section "## ${section.title}" appears more than once`,
          { line: section.startLine, section: section.id },
        ),
      );
    } else {
      seen.add(section.id);
      firstOccurrences.push(section.id);
    }
    // A gwt fence in a section's read path (outside any phase) is misplaced —
    // behavioral assertions live under a phase's Verification. Reject it here so
    // it can't slip through as an ordinary budgeted fence while the UI still
    // renders it as a scenario checklist (plan structure, lint, and anchoring).
    for (const gwt of section.gwtBlocks) {
      issues.push(
        issue(
          "L1",
          "E_GWT_PLACEMENT",
          "error",
          `Section "## ${section.title}" has a \`gwt\` block — behavioral assertions belong under a phase's "Verification"`,
          { line: gwt.startLine, section: section.id },
        ),
      );
      checkGwtShape(issues, gwt, `Section "## ${section.title}"`, section.id);
    }
  }
  for (const { id, title, optional } of ORDERED_SECTIONS) {
    if (!optional && !seen.has(id)) {
      issues.push(
        issue("L1", "E_SECTION_MISSING", "error", `Required section "## ${title}" is missing`),
      );
    }
  }
  // Filtering the canonical order to present sections is what makes the order
  // check tolerant of absent optionals (plan structure, lint, and anchoring): a plan without Contract
  // simply never contributes a "contract" slot to compare against.
  const expectedOrder = knownIds.filter((id) => seen.has(id));
  if (firstOccurrences.join(",") !== expectedOrder.join(",")) {
    issues.push(
      issue(
        "L1",
        "E_SECTION_ORDER",
        "error",
        `Sections are out of order: found ${firstOccurrences.join(", ")}; expected ${expectedOrder.join(", ")}`,
      ),
    );
  }

  const phasesSection = plan.sections.find((s) => s.id === "phases");
  if (phasesSection) {
    const phases = phasesSection.phases ?? [];
    if (phases.length === 0) {
      issues.push(
        issue("L1", "E_PHASES_EMPTY", "error", "The Phases section has no phases", {
          line: phasesSection.startLine,
          section: "phases",
        }),
      );
    }
    const validNumbers: { n: number; line: number }[] = [];
    for (const phase of phases) {
      if (!phase.headingValid) {
        issues.push(
          issue(
            "L1",
            "E_PHASE_HEADING",
            "error",
            `Phase heading "${phase.rawHeading}" must match "### Phase <n> — <name>"`,
            { line: phase.startLine, section: "phases" },
          ),
        );
      } else {
        validNumbers.push({ n: phase.n, line: phase.startLine });
      }
      for (const { name, label } of REQUIRED_PHASE_FIELDS) {
        if (!phase.fields[name]) {
          issues.push(
            issue(
              "L1",
              "E_PHASE_FIELD_MISSING",
              "error",
              `Phase ${phase.headingValid ? phase.n : `at line ${phase.startLine}`} is missing "${label}"`,
              { line: phase.startLine, section: phaseSlug(phase) },
            ),
          );
        }
      }
      if (phase.fields.files) {
        const files = phase.fields.files;
        const table = findFilesTable(files.contentLines);
        if (table) {
          // A Files table must carry a "What changed" column: ≥2 columns overall,
          // and every body row's 2nd cell non-empty. A list is exempt — only a
          // table makes the per-row summary a structural promise to keep.
          if (splitCells(table.header.text).length < 2) {
            issues.push(
              issue(
                "L1",
                "E_FILES_NO_SUMMARY",
                "error",
                `Phase ${phase.n} "Files" table needs a "What changed" column`,
                { line: table.header.line, section: phaseSlug(phase) },
              ),
            );
          } else {
            for (const row of table.body) {
              const cells = splitCells(row.text);
              if ((cells[1] ?? "") === "") {
                issues.push(
                  issue(
                    "L1",
                    "E_FILES_NO_SUMMARY",
                    "error",
                    `Phase ${phase.n} "Files" row has an empty "What changed" cell`,
                    { line: row.line, section: phaseSlug(phase) },
                  ),
                );
              }
            }
          }
        } else if (files.listItemCount === 0) {
          // No table and no list item — the field is genuinely empty.
          issues.push(
            issue("L1", "E_FILES_EMPTY", "error", `Phase ${phase.n} "Files" has no list items`, {
              line: files.startLine,
              section: phaseSlug(phase),
            }),
          );
        }
      }
      if (phase.detailsCount > 1) {
        issues.push(
          issue(
            "L1",
            "E_DETAILS_MULTIPLE",
            "error",
            `Phase ${phase.n} has ${phase.detailsCount} "#### Details" blocks; at most one is allowed`,
            { line: phase.startLine, section: phaseSlug(phase) },
          ),
        );
      }
      for (const line of phase.strayH4s) {
        issues.push(
          issue(
            "L1",
            "E_UNEXPECTED_H4",
            "error",
            `Unexpected H4 inside phase ${phase.headingValid ? phase.n : ""} — only "#### Details" is allowed`,
            { line, section: phaseSlug(phase) },
          ),
        );
      }
      for (const gwt of phase.gwtBlocks) {
        // gwt belongs under Verification; any other phase field is misplaced.
        if (gwt.field !== "verification") {
          issues.push(
            issue(
              "L1",
              "E_GWT_PLACEMENT",
              "error",
              `Phase ${phase.n} has a \`gwt\` block outside Verification — behavioral assertions belong under "Verification"`,
              { line: gwt.startLine, section: phaseSlug(phase) },
            ),
          );
        }
        checkGwtShape(issues, gwt, `Phase ${phase.n}`, phaseSlug(phase));
      }
    }
    const misnumbered = validNumbers.find(({ n }, i) => n !== i + 1);
    if (misnumbered) {
      issues.push(
        issue(
          "L1",
          "E_PHASE_NUMBERING",
          "error",
          `Phase numbers must run 1..N in order; found phase ${misnumbered.n} out of sequence`,
          { line: misnumbered.line, section: "phases" },
        ),
      );
    }
  }

  return issues;
}

export function checkL2(plan: ParsedPlan, budgets: Budgets): LintIssue[] {
  const issues: LintIssue[] = [];
  const over = (
    code: string,
    message: string,
    actual: number,
    budget: number,
    extra: Partial<LintIssue>,
  ): void => {
    if (actual > budget) {
      issues.push(
        issue("L2", code, "error", `${message} (${actual} > budget ${budget})`, {
          ...extra,
          actual,
          budget,
        }),
      );
    }
  };

  const byId = new Map(plan.sections.map((s) => [s.id, s]));

  const summary = byId.get("summary");
  if (summary) {
    over("E_BUDGET_SUMMARY", "Summary is over budget", summary.budgetedLineCount, budgets.summaryLines, {
      line: summary.startLine,
      section: "summary",
    });
  }

  const contract = byId.get("contract");
  if (contract) {
    over("E_BUDGET_CONTRACT", "Contract is over budget", contract.budgetedLineCount, budgets.contractLines, {
      line: contract.startLine,
      section: "contract",
    });
  }

  const impact = byId.get("impact");
  if (impact) {
    over("E_BUDGET_IMPACT", "Impact is over budget", impact.budgetedLineCount, budgets.impactLines, {
      line: impact.startLine,
      section: "impact",
    });
  }

  for (const item of byId.get("decisions")?.listItems ?? []) {
    over("E_BUDGET_DECISION", "Decision entry is over budget", item.lineCount, budgets.decisionEntryLines, {
      line: item.startLine,
      section: "decisions",
    });
  }

  const risks = byId.get("risks");
  if (risks) {
    over("E_BUDGET_RISKS_COUNT", "Too many risks", risks.listItems.length, budgets.risksMaxItems, {
      line: risks.startLine,
      section: "risks",
    });
    for (const item of risks.listItems) {
      over("E_BUDGET_RISK_ENTRY", "Risk entry is over budget", item.lineCount, budgets.riskEntryLines, {
        line: item.startLine,
        section: "risks",
      });
    }
  }

  for (const id of ["summary", "contract", "decisions", "impact", "risks", "open-questions"]) {
    const section = byId.get(id);
    if (section) {
      over(
        "E_FENCE_CAP",
        `Section "## ${section.title}" has too many fenced blocks`,
        section.fenceCount,
        budgets.maxFencesPerReadSection,
        { line: section.startLine, section: id },
      );
      over(
        "E_VISUAL_CAP",
        `Section "## ${section.title}" has too many visuals`,
        section.visualCount,
        budgets.maxVisualsPerReadSection,
        { line: section.startLine, section: id },
      );
    }
  }

  for (const phase of byId.get("phases")?.phases ?? []) {
    if (phase.fields.goal) {
      over("E_BUDGET_GOAL", `Phase ${phase.n} "Goal" is over budget`, phase.fields.goal.budgetedLineCount, budgets.phaseGoalLines, {
        line: phase.fields.goal.startLine,
        section: phaseSlug(phase),
      });
    }
    if (phase.fields.verification) {
      over(
        "E_BUDGET_VERIFICATION",
        `Phase ${phase.n} "Verification" is over budget`,
        phase.fields.verification.budgetedLineCount,
        budgets.phaseVerificationLines,
        { line: phase.fields.verification.startLine, section: phaseSlug(phase) },
      );
    }
    over(
      "E_FENCE_CAP",
      `Phase ${phase.n} has too many fenced blocks outside Details`,
      phase.fenceCount,
      budgets.maxFencesPerReadSection,
      { line: phase.startLine, section: phaseSlug(phase) },
    );
    over(
      "E_VISUAL_CAP",
      `Phase ${phase.n} has too many visuals outside Details`,
      phase.visualCount,
      budgets.maxVisualsPerReadSection,
      { line: phase.startLine, section: phaseSlug(phase) },
    );
    for (const gwt of phase.gwtBlocks) {
      over(
        "E_BUDGET_GWT",
        `Phase ${phase.n} \`gwt\` block has too many scenarios`,
        gwt.scenarios.length,
        budgets.gwtMaxScenarios,
        { line: gwt.startLine, section: phaseSlug(phase) },
      );
    }
  }

  return issues;
}

export function checkL6(plan: ParsedPlan, budgets: Budgets): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const phase of plan.sections.find((s) => s.id === "phases")?.phases ?? []) {
    if (phase.details && phase.details.lineCount > budgets.detailsSoftCapLines) {
      issues.push(
        issue(
          "L6",
          "W_DETAILS_SOFT_CAP",
          "warning",
          `Phase ${phase.n} Details is ${phase.details.lineCount} lines (soft cap ${budgets.detailsSoftCapLines})`,
          {
            line: phase.details.startLine,
            section: phaseSlug(phase),
            actual: phase.details.lineCount,
            budget: budgets.detailsSoftCapLines,
          },
        ),
      );
    }
  }
  return issues;
}

/**
 * L7: a lead diagram near the top is *strongly
 * recommended, not required* — ~90% of plans — so the reviewer sees the
 * change's shape before its prose. A Summary with no ` ```mermaid ` diagram and
 * no `<!-- no-lead-diagram -->` escape-hatch marker earns one **warning**, never
 * an error: the linter checks presence, never usefulness (a diagram that merely
 * restates the summary would add reading load), so it must not block a submit.
 * A missing Summary is L1's business, not L7's — no double-report.
 */
export function checkL7(plan: ParsedPlan): LintIssue[] {
  const summary = plan.sections.find((s) => s.id === "summary");
  if (!summary || summary.diagramCount > 0 || summary.leadDiagramOptOut) return [];
  return [
    issue(
      "L7",
      "W_LEAD_DIAGRAM_MISSING",
      "warning",
      "Summary has no lead diagram — a state/sequence/flow ```mermaid block up top is strongly recommended (≈90% of plans). Add one, or mark `<!-- no-lead-diagram: <why> -->` in Summary if a chart wouldn't help.",
      { line: summary.startLine, section: "summary" },
    ),
  ];
}

/**
 * Everything L3 needs, composed by the daemon (same seam as L5 — the linter
 * stays pure; transcript.json is read in app.ts and handed in here).
 */
export interface GrillContext {
  /** Session started --quick: the grill was skipped, L3 downgrades to warnings. */
  quick: boolean;
  /**
   * Session is in socratic mode: L3 bans `[assumed]` decisions and forces every
   * cited q to carry a free-text answer (two extra always-error checks below).
   */
  socratic: boolean;
  /** q ids present in the session's grill transcript. */
  knownQuestions: string[];
  /**
   * Subset of `knownQuestions` whose answer carries non-empty user free text —
   * the user reasoned it in their own words, not just picked a chip. Only L3's
   * socratic branch reads it; non-socratic callers may omit it.
   */
  reasonedQuestions?: string[];
}

const DECISION_RE = /^[-*+]\s+(D\d+):/;
// CITATION_RE (src/shared/types.ts) is shared with the UI's deep-link
// transform. Global matters here: an entry can carry several citation clauses
// ("… ← q1; revisit ← q9"), and every cited id must be checked — validating
// only the first would let a fabricated later clause game traceability
// invisibly.

/**
 * L3: every `- D<n>:` decision entry must cite the
 * grill question(s) that produced it (`← q7`) or wear `[assumed]`, and every
 * cited q id must exist in the transcript. Errors normally; warnings in
 * --quick sessions (codes stay stable — severity is the contextual dimension).
 *
 * Socratic mode tightens this with two always-error checks (no chip may stand
 * in for the user's reasoning): `[assumed]` is banned outright, and a cited q
 * that exists but carries no free-text answer (a bare chip pick) is rejected.
 * Non-socratic behavior is unchanged — `[assumed]` stays a valid escape there.
 */
export function checkL3(plan: ParsedPlan, ctx: GrillContext): LintIssue[] {
  const severity: LintSeverity = ctx.quick ? "warning" : "error";
  const known = new Set(ctx.knownQuestions);
  const reasoned = new Set(ctx.reasonedQuestions ?? []);
  const issues: LintIssue[] = [];
  const decisions = plan.sections.find((s) => s.id === "decisions");
  for (const item of decisions?.listItems ?? []) {
    const label = DECISION_RE.exec(item.text)?.[1];
    if (label === undefined) continue; // non-D entries are not L3's business
    const at = { line: item.startLine, section: "decisions" };
    const cited = [...item.text.matchAll(CITATION_RE)].flatMap((m) =>
      (m[1] as string).split(",").map((q) => q.trim()),
    );
    const assumed = item.text.includes("[assumed]");
    // Socratic only: `[assumed]` is no escape — every decision must trace to the
    // user's own reasoning (severity "error" regardless of --quick).
    if (ctx.socratic && assumed) {
      issues.push(
        issue(
          "L3",
          "E_ASSUMED_NOT_ALLOWED",
          "error",
          `Decision ${label} uses [assumed] — socratic mode requires every decision to trace to your own reasoning (cite a free-text grill answer)`,
          at,
        ),
      );
    }
    if (cited.length === 0 && !assumed) {
      issues.push(
        issue(
          "L3",
          "E_DECISION_UNTRACED",
          severity,
          `Decision ${label} cites no grill question — add "← q<n>" or tag it [assumed]`,
          at,
        ),
      );
      continue;
    }
    for (const qid of cited) {
      if (!known.has(qid)) {
        issues.push(
          issue(
            "L3",
            "E_UNKNOWN_QUESTION_CITED",
            severity,
            `Decision ${label} cites ${qid}, which is not in this session's grill transcript`,
            at,
          ),
        );
        continue; // an unknown id can't also be "not reasoned" — one verdict per qid
      }
      // Socratic only: a known-but-unreasoned citation is a bare chip pick — the
      // user must reason it in their own words (severity "error" regardless of --quick).
      if (ctx.socratic && !reasoned.has(qid)) {
        issues.push(
          issue(
            "L3",
            "E_DECISION_NOT_REASONED",
            "error",
            `Decision ${label} cites ${qid}, which has no free-text answer — socratic mode requires you to reason it in your own words, not pick a chip`,
            at,
          ),
        );
      }
    }
  }
  return issues;
}

/**
 * Everything L5 needs, composed by the daemon (the linter stays pure — rules
 * never touch disk; threads.json is read in app.ts and handed in here).
 */
export interface ResolutionContext {
  /** This submit creates revision N (the daemon's count, not frontmatter's). */
  revision: number;
  /**
   * Comment threads existing at submit time, with the two states that excuse a
   * reply: `replied` (the agent already responded) and `resolved` (the reviewer
   * closed/withdrew it — the withdraw path L5 must skip, or it deadlocks submits).
   */
  commentThreads: { id: string; replied: boolean; resolved: boolean }[];
  /** thread id → reply (the agent's response) provided with this submit. */
  replies: Record<string, string>;
  /** The agent's changelog provided with this submit. */
  changelog?: string;
}

/**
 * L5: a resubmit must include a response (reply) for every
 * comment thread that has neither a reply yet NOR a reviewer close, and every
 * revision ≥ 2 must carry a changelog. A reviewer-`resolved` comment is SKIPPED —
 * that is the withdraw path; demanding a reply on a thread the agent cannot answer
 * would deadlock submits. Unknown thread ids (typos, question ids — questions are
 * answered via `otacon answer`, never replied) are errors; re-replying to an
 * already-replied thread is allowed because at-least-once delivery makes duplicate
 * submits legitimate.
 */
export function checkL5(ctx: ResolutionContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const known = new Set(ctx.commentThreads.map((t) => t.id));
  for (const [thread, reply] of Object.entries(ctx.replies)) {
    if (!known.has(thread)) {
      issues.push(
        issue("L5", "E_UNKNOWN_THREAD", "error", `Reply targets unknown comment thread "${thread}"`, { thread }),
      );
    } else if (reply.trim() === "") {
      issues.push(
        issue("L5", "E_EMPTY_RESOLUTION", "error", `Reply for thread "${thread}" is empty`, { thread }),
      );
    }
  }
  for (const { id, replied, resolved } of ctx.commentThreads) {
    if (replied || resolved) continue; // already responded, or reviewer-withdrawn
    const reply = ctx.replies[id];
    if (reply === undefined) {
      issues.push(
        issue(
          "L5",
          "E_THREAD_UNRESOLVED",
          "error",
          `Comment thread "${id}" has no response — every open comment needs a reply (submit --resolutions)`,
          { thread: id },
        ),
      );
    }
  }
  if (ctx.revision >= 2 && (ctx.changelog ?? "").trim() === "") {
    issues.push(
      issue(
        "L5",
        "E_CHANGELOG_MISSING",
        "error",
        `Revision ${ctx.revision} needs a changelog summarizing what changed (resolutions.json "changelog")`,
      ),
    );
  }
  return issues;
}

export interface FrontmatterExpectations {
  expectedRevision?: number;
  expectedStatus?: string;
}

/** A3 warnings: the daemon owns revision/status, so value drift only warns. */
export function checkFrontmatterAuthority(
  plan: ParsedPlan,
  expectations: FrontmatterExpectations = {},
): LintIssue[] {
  const issues: LintIssue[] = [];
  const fm = plan.frontmatter;
  if (!fm) return issues;

  if (fm.revision !== undefined) {
    const revision = Number(fm.revision);
    if (!Number.isInteger(revision) || revision < 1) {
      issues.push(
        issue("L1", "W_REVISION_INVALID", "warning", `Frontmatter revision "${fm.revision}" is not a positive integer`, { line: 1 }),
      );
    } else if (
      expectations.expectedRevision !== undefined &&
      revision !== expectations.expectedRevision
    ) {
      issues.push(
        issue(
          "L1",
          "W_REVISION_MISMATCH",
          "warning",
          `Frontmatter revision ${revision} differs from the daemon's ${expectations.expectedRevision} (daemon wins)`,
          { line: 1 },
        ),
      );
    }
  }

  if (fm.status !== undefined) {
    if (!(SESSION_STATUSES as readonly string[]).includes(fm.status)) {
      issues.push(
        issue(
          "L1",
          "W_STATUS_INVALID",
          "warning",
          `Frontmatter status "${fm.status}" is not one of ${SESSION_STATUSES.join("/")}`,
          { line: 1 },
        ),
      );
    } else if (
      expectations.expectedStatus !== undefined &&
      fm.status !== expectations.expectedStatus
    ) {
      issues.push(
        issue(
          "L1",
          "W_STATUS_UNEXPECTED",
          "warning",
          `Frontmatter status "${fm.status}" differs from the daemon's "${expectations.expectedStatus}" (daemon wins)`,
          { line: 1 },
        ),
      );
    }
  }

  return issues;
}
