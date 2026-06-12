import type { LintIssue } from "../../shared/types.js";

// Single-pass, line-based plan parser (DECISIONS.md "Plan parser"). Purely
// structural: it never judges the plan, it only measures it; all verdicts
// live in rules.ts. Budgeted line counts follow DECISIONS.md "Budget
// counting": non-blank lines, excluding fence delimiters and fence content.

export interface ListItem {
  startLine: number;
  lineCount: number;
}

export type PhaseFieldName = "goal" | "files" | "verification" | "outOfScope";

export interface PhaseField {
  startLine: number;
  budgetedLineCount: number;
  listItemCount: number;
}

export interface DetailsBlock {
  /** Line of the "#### Details" header. */
  startLine: number;
  /** Raw lines after the header through the last non-blank one. */
  lineCount: number;
}

export interface Phase {
  n: number;
  name: string;
  startLine: number;
  headingValid: boolean;
  rawHeading: string;
  fields: Partial<Record<PhaseFieldName, PhaseField>>;
  /** First Details block; later duplicates only bump detailsCount. */
  details?: DetailsBlock;
  detailsCount: number;
  strayH4s: number[];
  /** Fences outside Details — the phase's read path. */
  fenceCount: number;
}

export interface Section {
  id: string;
  title: string;
  startLine: number;
  endLine: number;
  budgetedLineCount: number;
  fenceCount: number;
  listItems: ListItem[];
  phases?: Phase[];
}

export interface ParsedPlan {
  frontmatter: Record<string, string> | null;
  frontmatterEndLine: number;
  sections: Section[];
  parseErrors: LintIssue[];
}

const FIELD_LABELS: Record<string, PhaseFieldName> = {
  Goal: "goal",
  Files: "files",
  Verification: "verification",
  "Out of scope": "outOfScope",
};

// Accepts "Goal:", "**Goal**:", and "**Goal:**" (DECISIONS.md "Plan grammar").
const FIELD_RE =
  /^(?:\*\*)?(Goal|Files|Verification|Out of scope)(?:\*\*)?:(?:\*\*)?\s*(.*)$/;
const PHASE_RE = /^### Phase (\d+) [—-] (.+?)\s*$/;
const HEADING_RE = /^(#{2,4})\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM_RE = /^[-*+]\s+/;
const FRONTMATTER_KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parsePlan(content: string): ParsedPlan {
  const lines = content.split("\n");
  const parseErrors: LintIssue[] = [];
  const sections: Section[] = [];

  let frontmatter: Record<string, string> | null = null;
  let frontmatterEndLine = 0;
  let start = 0;

  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close === -1) {
      parseErrors.push({
        rule: "L1",
        code: "E_FRONTMATTER_UNCLOSED",
        severity: "error",
        line: 1,
        message: "Frontmatter opened on line 1 is never closed",
      });
      start = 1;
    } else {
      frontmatter = {};
      for (let i = 1; i < close; i++) {
        const m = FRONTMATTER_KEY_RE.exec(lines[i] ?? "");
        if (m) {
          frontmatter[m[1]!] = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
        }
      }
      frontmatterEndLine = close + 1;
      start = close + 1;
    }
  }

  let section: Section | null = null;
  let phase: Phase | null = null;
  let field: PhaseField | null = null;
  let item: ListItem | null = null;
  let fence: string | null = null;
  let fenceOpenLine = 0;
  let inDetails = false;
  let openDetails: DetailsBlock | null = null;
  let detailsLastContent = 0;

  const closeItem = (): void => {
    item = null;
  };
  const closeField = (): void => {
    field = null;
    closeItem();
  };
  const closeDetails = (): void => {
    if (openDetails) {
      openDetails.lineCount = Math.max(0, detailsLastContent - openDetails.startLine);
    }
    openDetails = null;
    inDetails = false;
  };
  const closePhase = (): void => {
    closeDetails();
    closeField();
    phase = null;
  };
  const closeSection = (endLine: number): void => {
    closePhase();
    if (section) section.endLine = endLine;
    section = null;
  };

  for (let idx = start; idx < lines.length; idx++) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;
    const blank = line.trim() === "";

    if (fence) {
      if (inDetails && !blank) detailsLastContent = lineNo;
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      fenceOpenLine = lineNo;
      closeItem();
      if (inDetails) detailsLastContent = lineNo;
      else if (phase) phase.fenceCount++;
      else if (section) section.fenceCount++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!;
      if (level === 2) {
        closeSection(lineNo - 1);
        section = {
          id: slugify(title),
          title,
          startLine: lineNo,
          endLine: lines.length,
          budgetedLineCount: 0,
          fenceCount: 0,
          listItems: [],
        };
        sections.push(section);
        continue;
      }
      if (level === 3 && section?.id === "phases") {
        closeDetails();
        closeField();
        const m = PHASE_RE.exec(line);
        phase = {
          n: m ? Number(m[1]) : -1,
          name: m ? m[2]! : "",
          startLine: lineNo,
          headingValid: m !== null,
          rawHeading: line,
          fields: {},
          detailsCount: 0,
          strayH4s: [],
          fenceCount: 0,
        };
        (section.phases ??= []).push(phase);
        continue;
      }
      if (level === 4 && phase) {
        closeDetails();
        closeField();
        if (title === "Details") {
          phase.detailsCount++;
          openDetails = { startLine: lineNo, lineCount: 0 };
          detailsLastContent = lineNo;
          if (phase.detailsCount === 1) phase.details = openDetails;
          inDetails = true;
        } else {
          phase.strayH4s.push(lineNo);
        }
        continue;
      }
      // Any other heading (H3 outside Phases, H4 outside a phase) is content.
    }

    if (inDetails) {
      if (!blank) detailsLastContent = lineNo;
      continue;
    }

    if (phase) {
      const fm = FIELD_RE.exec(line);
      if (fm) {
        closeField();
        field = { startLine: lineNo, budgetedLineCount: 1, listItemCount: 0 };
        phase.fields[FIELD_LABELS[fm[1]!]!] = field;
        continue;
      }
    }

    if (blank) {
      closeItem();
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      closeItem();
      if (field) {
        field.listItemCount++;
        field.budgetedLineCount++;
      } else if (!phase && section) {
        item = { startLine: lineNo, lineCount: 1 };
        section.listItems.push(item);
        section.budgetedLineCount++;
      }
      continue;
    }

    if (field) {
      field.budgetedLineCount++;
    } else if (item && section) {
      item.lineCount++;
      section.budgetedLineCount++;
    } else if (!phase && section) {
      section.budgetedLineCount++;
    }
  }

  if (fence) {
    parseErrors.push({
      rule: "L1",
      code: "E_UNCLOSED_FENCE",
      severity: "error",
      line: fenceOpenLine,
      message: `Code fence opened on line ${fenceOpenLine} is never closed`,
    });
  }
  closeSection(lines.length);

  return { frontmatter, frontmatterEndLine, sections, parseErrors };
}
