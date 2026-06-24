import { type GwtScenario, parseGwt } from "../../shared/gwt.js";
import type { LintIssue } from "../../shared/types.js";

// Single-pass, line-based plan parser (DECISIONS.md "Plan parser"). Purely
// structural: it never judges the plan, it only measures it; all verdicts
// live in rules.ts. Budgeted line counts follow DECISIONS.md "Budget
// counting": non-blank lines, excluding fence delimiters and fence content.

export interface ListItem {
  startLine: number;
  lineCount: number;
  /** Raw item text — the bullet line plus continuation lines (L3 reads it). */
  text: string;
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

/**
 * A ```gwt behavioral-assertion fence (plan structure, lint, and anchoring). Captured structurally —
 * `scenarios` is tokenized once here by the shared grammar (src/shared/gwt.ts)
 * so the linter (shape/budget verdicts) and a UI that ever reuses this never
 * re-parse; `field` is the active phase field when the fence opened, so the
 * linter can require gwt under Verification. A gwt fence in a non-phase section
 * (Summary, Contract, …) is captured too — with `field` null — so the linter
 * can reject it as misplaced rather than silently treat it as a budgeted fence
 * while the UI renders it as a scenario checklist.
 */
export interface GwtBlock {
  startLine: number;
  field: PhaseFieldName | null;
  scenarios: GwtScenario[];
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
  /** Markdown-native visuals (callouts, matrices) outside Details — capped. */
  visualCount: number;
  /** Behavioral-assertion blocks in the read path; budget-exempt, validated separately. */
  gwtBlocks: GwtBlock[];
}

export interface Section {
  id: string;
  title: string;
  startLine: number;
  endLine: number;
  budgetedLineCount: number;
  fenceCount: number;
  /** Markdown-native visuals (callouts, matrices) in the section read path. */
  visualCount: number;
  /** Mermaid fences in the section read path — the lead-diagram check (L7). */
  diagramCount: number;
  /** A `<!-- no-lead-diagram -->` escape-hatch marker was seen in this section. */
  leadDiagramOptOut: boolean;
  /**
   * Stray gwt fences in this section's read path (outside any phase). gwt belongs
   * in a phase's Verification, so any block here is misplaced — captured (not
   * silently budgeted) so the linter rejects it, matching what the UI renders.
   */
  gwtBlocks: GwtBlock[];
  listItems: ListItem[];
  phases?: Phase[];
}

/**
 * A ```mermaid fence's source, captured for a later phase that validates the
 * diagram renders. `code` is the body between the open/close fences (no
 * delimiter lines), `startLine` is the opening fence line, and `section` is the
 * slug of the enclosing section. Captured at the same seam as
 * `section.diagramCount`, so the count and the bodies can never disagree.
 */
export interface DiagramFence {
  code: string;
  startLine: number;
  section: string;
}

export interface ParsedPlan {
  frontmatter: Record<string, string> | null;
  frontmatterEndLine: number;
  sections: Section[];
  diagrams: DiagramFence[];
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
// Capture the info string too — a `gwt` fence is a behavioral-assertion block,
// not a budgeted/visual fence (plan structure, lint, and anchoring). Group 1 stays the delimiter.
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*(.*)$/;
const LIST_ITEM_RE = /^[-*+]\s+/;
// A blockquote line, and the callout marker that must be its first line — the
// same closed type set the renderer styles (src/ui/plan/callout.tsx). A known
// callout's lines are budget-exempt and count as one visual; a plain
// blockquote (or an unknown `[!type]`) stays ordinary budgeted prose.
const QUOTE_RE = /^\s*>/;
const CALLOUT_RE = /^\s*>\s*\[!(?:risk|note|decision|assumption)\]\s*$/i;
// The lead-diagram escape hatch (plan structure, lint, and anchoring): an HTML-comment directive that
// suppresses the L7 nudge when a chart isn't meaningful. Like a callout marker
// it is chrome, not prose, so a section's read path exempts it from the budget.
const LEAD_OPT_OUT_RE = /^\s*<!--\s*no-lead-diagram\b.*?-->\s*$/i;

// A GFM table: a header row (has a pipe) immediately followed by a delimiter
// row (pipes plus only `-:` and spaces, with at least one `-`). The renderer
// styles such tables as decision matrices; the parser exempts their lines from
// the line budget and counts the table as one visual, like a callout.
const TABLE_ROW_RE = /\|/;
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("-") && trimmed.includes("|") && /^[|\s:-]+$/.test(trimmed);
}
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
  const diagrams: DiagramFence[] = [];

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
  /** Name of the active phase field — gwt placement keys off it. */
  let fieldName: PhaseFieldName | null = null;
  let item: ListItem | null = null;
  let fence: string | null = null;
  let fenceOpenLine = 0;
  // When the open fence is a ```gwt block, collect its body here instead of
  // counting it as a read-path fence; finalized onto its container at the close.
  // `gwtTarget` is the array (a phase's or a stray section's) the finished block
  // lands in — fixed at open time so it survives even if structure closes mid-fence.
  let gwtBody: string[] | null = null;
  let gwtStartLine = 0;
  let gwtField: PhaseFieldName | null = null;
  let gwtTarget: GwtBlock[] | null = null;
  // When the open fence is a ```mermaid block in a section read path, buffer its
  // body here and push a DiagramFence at the close — opened at the same seam as
  // section.diagramCount++ so the count and the captured bodies never disagree.
  let mermaidBody: string[] | null = null;
  let mermaidStartLine = 0;
  let mermaidSection = "";
  // Open blockquote run: a callout (budget-exempt, counts as one visual) or a
  // plain quote (ordinary budgeted prose). Reset by any structural boundary.
  let quote: { callout: boolean } | null = null;
  // Open GFM table run (a decision matrix): budget-exempt, counts as one
  // visual. Reset by any structural boundary.
  let inTable = false;
  let inDetails = false;
  let openDetails: DetailsBlock | null = null;
  let detailsLastContent = 0;

  const closeItem = (): void => {
    item = null;
  };
  const closeField = (): void => {
    field = null;
    fieldName = null;
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
      if (line.trimStart().startsWith(fence)) {
        fence = null;
        if (gwtBody !== null && gwtTarget) {
          gwtTarget.push({
            startLine: gwtStartLine,
            field: gwtField,
            scenarios: parseGwt(gwtBody.join("\n")).scenarios,
          });
        }
        if (mermaidBody !== null) {
          diagrams.push({
            code: mermaidBody.join("\n"),
            startLine: mermaidStartLine,
            section: mermaidSection,
          });
        }
        gwtBody = null;
        gwtTarget = null;
        mermaidBody = null;
      } else {
        if (gwtBody !== null) gwtBody.push(line);
        if (mermaidBody !== null) mermaidBody.push(line);
      }
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      fenceOpenLine = lineNo;
      const lang = (fenceMatch[2] ?? "").trim().toLowerCase().split(/\s+/)[0];
      const isGwt = lang === "gwt";
      const isMermaid = lang === "mermaid";
      quote = null;
      inTable = false;
      closeItem();
      if (inDetails) detailsLastContent = lineNo;
      else if (isGwt && (phase || section)) {
        // A gwt block is the read path's behavioral-assertion checklist, exempt
        // from the one-fence cap; its body is buffered and validated separately.
        // It belongs in a phase's Verification, but we also capture a stray block
        // in a non-phase section (field null) so the linter rejects it as
        // misplaced — otherwise it would slip through as a budgeted fence while
        // the UI still renders it as scenario cards (producer/consumer drift).
        gwtBody = [];
        gwtStartLine = lineNo;
        gwtField = phase ? fieldName : null;
        gwtTarget = phase ? phase.gwtBlocks : section!.gwtBlocks;
      } else if (phase) {
        // A mermaid diagram is exempt from the fence cap (like a diagram inside
        // Details, which is already uncounted); only code and before/after fences
        // spend a phase's one-fence allowance.
        if (!isMermaid) phase.fenceCount++;
      } else if (section) {
        // A mermaid fence in a section read path is exempt from the fence cap; it
        // counts only toward diagramCount (L7 reads Summary's count) and is never
        // a candidate for E_FENCE_CAP. Buffer its body at this same seam so
        // diagrams[] and diagramCount stay in lockstep; the L8 render check later
        // validates each captured fence renders. Code and before/after fences keep
        // spending the one-fence allowance.
        if (isMermaid) {
          section.diagramCount++;
          mermaidBody = [];
          mermaidStartLine = lineNo;
          mermaidSection = section.id;
        } else section.fenceCount++;
      }
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      quote = null; // a heading ends any open blockquote run
      inTable = false;
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
          visualCount: 0,
          diagramCount: 0,
          leadDiagramOptOut: false,
          gwtBlocks: [],
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
          visualCount: 0,
          gwtBlocks: [],
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

    // Blockquote runs (outside Details). A known callout is exempt from the
    // line budget and counts as one visual; a plain blockquote stays budgeted
    // prose, exactly as before this primitive existed.
    if (quote) {
      if (QUOTE_RE.test(line)) {
        if (!quote.callout && !phase && section) section.budgetedLineCount++;
        continue;
      }
      quote = null; // a non-quote line ends the run; fall through to handle it
    }
    if (QUOTE_RE.test(line)) {
      const callout = CALLOUT_RE.test(line);
      quote = { callout };
      closeItem();
      if (callout) {
        if (phase) phase.visualCount++;
        else if (section) section.visualCount++;
      } else if (!phase && section) {
        section.budgetedLineCount++;
      }
      continue;
    }

    // GFM table runs (outside Details): budget-exempt, one visual each. A table
    // starts where a pipe-bearing line is followed by a delimiter row.
    if (inTable) {
      if (TABLE_ROW_RE.test(line)) continue;
      inTable = false; // a non-row line ends the table; fall through
    }
    if (TABLE_ROW_RE.test(line) && isTableDelimiter(lines[idx + 1] ?? "")) {
      inTable = true;
      closeItem();
      if (phase) phase.visualCount++;
      else if (section) section.visualCount++;
      continue;
    }

    // The lead-diagram escape hatch (plan structure, lint, and anchoring): in a section's read path it
    // records the opt-out and, being chrome, is exempt from the line budget —
    // so declining a diagram never costs a Summary content line.
    if (section && !phase && LEAD_OPT_OUT_RE.test(line)) {
      section.leadDiagramOptOut = true;
      closeItem();
      continue;
    }

    if (phase) {
      const fm = FIELD_RE.exec(line);
      if (fm) {
        closeField();
        fieldName = FIELD_LABELS[fm[1]!]!;
        field = { startLine: lineNo, budgetedLineCount: 1, listItemCount: 0 };
        phase.fields[fieldName] = field;
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
        item = { startLine: lineNo, lineCount: 1, text: line };
        section.listItems.push(item);
        section.budgetedLineCount++;
      }
      continue;
    }

    if (field) {
      field.budgetedLineCount++;
    } else if (item && section) {
      item.lineCount++;
      item.text += `\n${line}`;
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

  return { frontmatter, frontmatterEndLine, sections, diagrams, parseErrors };
}
