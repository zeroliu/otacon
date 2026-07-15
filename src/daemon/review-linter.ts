import { parseReviewReport } from "../shared/review-report.js";
import type {
  ParsedReviewReport,
  ReviewCodeGroupKind,
  ReviewReportLintIssue,
} from "../shared/review-report.js";

export type ReviewLintSeverity = "error" | "warning";

export type ReviewLintIssue = ReviewReportLintIssue;

export interface ReviewLintResult {
  ok: boolean;
  errors: ReviewLintIssue[];
  warnings: ReviewLintIssue[];
  parsed: ParsedReviewReport;
}

const LAYER_RANK: Record<ReviewCodeGroupKind, number> = {
  interface: 0,
  integration: 1,
  implementation: 2,
};
const MAX_WARNINGS = 8;

/** Hard shape validation plus intentionally bounded editorial nudges. */
export function lintReviewReport(markdown: string): ReviewLintResult {
  const parsed = parseReviewReport(markdown);
  const errors: ReviewLintIssue[] = parsed.errors.map((issue) => ({ ...issue, severity: "error" }));
  const warnings: ReviewLintIssue[] = [];
  const error = (code: string, message: string, line?: number, group?: string): void => {
    errors.push({ code, severity: "error", message, line, group });
  };
  const warn = (code: string, message: string, line?: number, group?: string): void => {
    if (warnings.length < MAX_WARNINGS) warnings.push({ code, severity: "warning", message, line, group });
  };

  if (parsed.codeGroups.length === 0) {
    error("E_REPORT_CODE_GROUPS", "## Code must contain typed causal reading groups");
  }
  let lastRank = -1;
  const kinds = new Set<ReviewCodeGroupKind>();
  const ids = new Set<string>();
  for (const group of parsed.codeGroups) {
    if (ids.has(group.id)) {
      error("E_REPORT_GROUP_ID", `Code group identity is duplicated: ${group.title}`, group.startLine, group.id);
    }
    ids.add(group.id);
    if (group.kind === undefined) {
      // The structural parser already emits the line-aware heading error.
      continue;
    }
    kinds.add(group.kind);
    const rank = LAYER_RANK[group.kind];
    if (rank < lastRank) {
      error(
        "E_REPORT_GROUP_ORDER",
        "Code groups must read causally: interfaces, then integration boundaries, then implementation internals",
        group.startLine,
        group.id,
      );
    }
    lastRank = Math.max(lastRank, rank);
    if (group.purpose === undefined) {
      error("E_REPORT_GROUP_PURPOSE", "Code group needs a **Purpose:** statement", group.startLine, group.id);
    }
    if (group.changedBehavior === undefined) {
      error("E_REPORT_GROUP_BEHAVIOR", "Code group needs a **Changed behavior:** statement", group.startLine, group.id);
    }
    if (group.surfaces.length === 0) {
      error(
        "E_REPORT_GROUP_SURFACES",
        "Code group needs **Surfaces:** with at least one high-level `file#symbol` reference",
        group.startLine,
        group.id,
      );
    }
    if ((group.purpose?.length ?? 0) < 24) {
      warn("W_REPORT_PURPOSE_THIN", "Purpose should explain why this group belongs in the reader's path", group.startLine, group.id);
    }
    if ((group.changedBehavior?.length ?? 0) < 24) {
      warn("W_REPORT_BEHAVIOR_THIN", "Changed behavior should contrast the reader-visible before and after", group.startLine, group.id);
    }
    if (group.markdown.split("\n").filter((line) => line.trim() !== "").length > 40) {
      warn("W_REPORT_GROUP_LONG", "This Code group is long; split it at a causal boundary if the concepts are independent", group.startLine, group.id);
    }
  }
  for (const kind of ["interface", "integration", "implementation"] as const) {
    if (!kinds.has(kind)) {
      error("E_REPORT_GROUP_LAYER", `## Code needs at least one ${kind} group`);
    }
  }

  for (const section of parsed.sections) {
    const proseLines = section.markdown.split("\n").filter((line) => line.trim() !== "").length;
    if (section.name !== "Quiz" && proseLines < 2) {
      warn("W_REPORT_SECTION_THIN", `## ${section.name} may be too thin to orient the reader`, section.startLine);
    }
  }
  return { ok: errors.length === 0, errors, warnings, parsed };
}
