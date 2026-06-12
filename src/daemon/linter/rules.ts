import type { Budgets } from "../../shared/config.js";
import type { LintIssue, LintSeverity } from "../../shared/types.js";
import { SESSION_STATUSES } from "../../shared/types.js";
import type { ParsedPlan, Phase } from "./parse.js";

// Rule semantics follow DESIGN.md §4-5; resolved edge cases follow
// DECISIONS.md ("Schema is closed", "Frontmatter authority", "Plan grammar").

const REQUIRED_FRONTMATTER_KEYS = [
  "title",
  "session",
  "revision",
  "status",
  "created",
] as const;

const REQUIRED_SECTIONS: readonly { id: string; title: string }[] = [
  { id: "summary", title: "Summary" },
  { id: "decisions", title: "Decisions" },
  { id: "phases", title: "Phases" },
  { id: "risks", title: "Risks" },
  { id: "open-questions", title: "Open Questions" },
];

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

  const requiredIds = REQUIRED_SECTIONS.map((s) => s.id);
  const seen = new Set<string>();
  const firstOccurrences: string[] = [];
  for (const section of plan.sections) {
    if (!requiredIds.includes(section.id)) {
      issues.push(
        issue(
          "L1",
          "E_UNKNOWN_SECTION",
          "error",
          `Unknown section "## ${section.title}" — the schema allows only Summary, Decisions, Phases, Risks, Open Questions`,
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
  }
  for (const { id, title } of REQUIRED_SECTIONS) {
    if (!seen.has(id)) {
      issues.push(
        issue("L1", "E_SECTION_MISSING", "error", `Required section "## ${title}" is missing`),
      );
    }
  }
  const expectedOrder = requiredIds.filter((id) => seen.has(id));
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
      if (phase.fields.files && phase.fields.files.listItemCount === 0) {
        issues.push(
          issue("L1", "E_FILES_EMPTY", "error", `Phase ${phase.n} "Files" has no list items`, {
            line: phase.fields.files.startLine,
            section: phaseSlug(phase),
          }),
        );
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

  for (const id of ["summary", "decisions", "risks", "open-questions"]) {
    const section = byId.get(id);
    if (section) {
      over(
        "E_FENCE_CAP",
        `Section "## ${section.title}" has too many fenced blocks`,
        section.fenceCount,
        budgets.maxFencesPerReadSection,
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
 * Everything L3 needs, composed by the daemon (same seam as L5 — the linter
 * stays pure; transcript.json is read in app.ts and handed in here).
 */
export interface GrillContext {
  /** Session started --quick: the grill was skipped, L3 downgrades to warnings. */
  quick: boolean;
  /** q ids present in the session's grill transcript. */
  knownQuestions: string[];
}

const DECISION_RE = /^[-*+]\s+(D\d+):/;
// "← q7" or "← q7, q9"; "<-" accepted alongside "←" (models emit both arrows,
// same accommodation as the —/- phase-heading dashes).
const CITATION_RE = /(?:←|<-)\s*(q\d+(?:\s*,\s*q\d+)*)/;

/**
 * L3 (DESIGN.md §4, §5, §8): every `- D<n>:` decision entry must cite the
 * grill question(s) that produced it (`← q7`) or wear `[assumed]`, and every
 * cited q id must exist in the transcript. Errors normally; warnings in
 * --quick sessions (codes stay stable — severity is the contextual dimension).
 */
export function checkL3(plan: ParsedPlan, ctx: GrillContext): LintIssue[] {
  const severity: LintSeverity = ctx.quick ? "warning" : "error";
  const known = new Set(ctx.knownQuestions);
  const issues: LintIssue[] = [];
  const decisions = plan.sections.find((s) => s.id === "decisions");
  for (const item of decisions?.listItems ?? []) {
    const label = DECISION_RE.exec(item.text)?.[1];
    if (label === undefined) continue; // non-D entries are not L3's business
    const cited = CITATION_RE.exec(item.text)?.[1];
    if (cited === undefined && !item.text.includes("[assumed]")) {
      issues.push(
        issue(
          "L3",
          "E_DECISION_UNTRACED",
          severity,
          `Decision ${label} cites no grill question — add "← q<n>" or tag it [assumed]`,
          { line: item.startLine, section: "decisions" },
        ),
      );
      continue;
    }
    for (const qid of cited === undefined ? [] : cited.split(",").map((q) => q.trim())) {
      if (!known.has(qid)) {
        issues.push(
          issue(
            "L3",
            "E_UNKNOWN_QUESTION_CITED",
            severity,
            `Decision ${label} cites ${qid}, which is not in this session's grill transcript`,
            { line: item.startLine, section: "decisions" },
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
  /** Comment threads existing at submit time, with their resolved state. */
  commentThreads: { id: string; resolved: boolean }[];
  /** thread id → resolution reply provided with this submit. */
  replies: Record<string, string>;
  /** The agent's changelog provided with this submit. */
  changelog?: string;
}

/**
 * L5 (DESIGN.md §5, §9): a resubmit must resolve every unresolved comment
 * thread, and every revision ≥ 2 must carry a changelog. Unknown thread ids
 * (typos, question ids — questions are answered via `otacon answer`, never
 * resolved) are errors; re-resolving an already-resolved thread is allowed
 * because at-least-once delivery makes duplicate submits legitimate.
 */
export function checkL5(ctx: ResolutionContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const known = new Set(ctx.commentThreads.map((t) => t.id));
  for (const [thread, reply] of Object.entries(ctx.replies)) {
    if (!known.has(thread)) {
      issues.push(
        issue("L5", "E_UNKNOWN_THREAD", "error", `Resolution targets unknown comment thread "${thread}"`, { thread }),
      );
    } else if (reply.trim() === "") {
      issues.push(
        issue("L5", "E_EMPTY_RESOLUTION", "error", `Resolution reply for thread "${thread}" is empty`, { thread }),
      );
    }
  }
  for (const { id, resolved } of ctx.commentThreads) {
    if (resolved) continue;
    const reply = ctx.replies[id];
    if (reply === undefined) {
      issues.push(
        issue(
          "L5",
          "E_THREAD_UNRESOLVED",
          "error",
          `Comment thread "${id}" has no resolution reply — every open thread needs one (submit --resolutions)`,
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
