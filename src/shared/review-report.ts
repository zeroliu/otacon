import type { KnowledgeHash } from "./knowledge.js";

export const REVIEW_REPORT_SECTIONS = ["Background", "Intuition", "Code", "Quiz"] as const;
export type ReviewReportSectionName = (typeof REVIEW_REPORT_SECTIONS)[number];
export type ReviewAltitude = "balanced" | "expert";
export type ReviewCodeGroupKind = "interface" | "integration" | "implementation";

export interface ReviewReportFrontmatter {
  type: "otacon-pr-review";
  version: 1;
  session: string;
  /** Independent persisted-report revision, not the PR-head generation. */
  revision: number;
  pr: string;
  head: string;
  knowledgeSnapshot: KnowledgeHash;
  altitude: ReviewAltitude;
}

export interface ReviewReportSection {
  name: ReviewReportSectionName;
  id: Lowercase<ReviewReportSectionName>;
  /** Inclusive, one-based source range including the heading. */
  startLine: number;
  endLine: number;
  /** Markdown below the H2, excluding the heading. */
  markdown: string;
}

export interface ReviewCodeSurface {
  file: string;
  symbol: string;
}

export interface ReviewCodeGroup {
  id: string;
  kind?: ReviewCodeGroupKind;
  title: string;
  startLine: number;
  endLine: number;
  markdown: string;
  purpose?: string;
  changedBehavior?: string;
  surfaces: ReviewCodeSurface[];
}

export interface ReviewReportParseIssue {
  code: string;
  message: string;
  line?: number;
}

export interface ReviewReportLintIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  line?: number;
  group?: string;
}

export interface ReviewKnowledgeSnapshot {
  version: 1;
  session: string;
  /** Persisted report revision; independent from `headRevision`. */
  revision: number;
  headRevision: number;
  headSha: string;
  capturedAt: string;
  hash: KnowledgeHash;
  user: { hash: KnowledgeHash; markdown: string };
  project: { repo: string; hash: KnowledgeHash; markdown: string };
}

export interface ReviewReportRevision {
  version: 1;
  session: string;
  revision: number;
  headRevision: number;
  headSha: string;
  snapshotHash: KnowledgeHash;
  createdAt: string;
  submittedAt?: string;
  status: "prepared" | "submitted";
}

export interface ReviewReportRevisionPayload {
  revision: ReviewReportRevision;
  snapshot: ReviewKnowledgeSnapshot;
  report?: string;
  quiz?: unknown;
  warnings: ReviewReportLintIssue[];
}

export interface ParsedReviewReport {
  frontmatter?: ReviewReportFrontmatter;
  sections: ReviewReportSection[];
  codeGroups: ReviewCodeGroup[];
  errors: ReviewReportParseIssue[];
}

const FRONTMATTER_KEYS = [
  "type",
  "version",
  "session",
  "revision",
  "pr",
  "head",
  "knowledge-snapshot",
  "altitude",
] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const SESSION = /^otc_[a-z0-9]+$/;
const PR = /^github\.com\/[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]+#\d+$/;
const SURFACE = /^([^\s`#,]+)#([^\s`,]+)$/;
const CODE_GROUP = /^(Interface changes|Integration path|Implementation walkthrough)\s*(?:[—:-])\s*(.+)$/;
const KIND_BY_LABEL: Record<string, ReviewCodeGroupKind> = {
  "Interface changes": "interface",
  "Integration path": "integration",
  "Implementation walkthrough": "implementation",
};

function slugify(value: string): string {
  const tokens: string[] = [];
  let ascii = "";
  const flushAscii = (): void => {
    if (ascii !== "") tokens.push(ascii);
    ascii = "";
  };
  for (const character of value.normalize("NFKC").toLowerCase()) {
    if (/^[a-z0-9]$/.test(character)) {
      ascii += character;
      continue;
    }
    flushAscii();
    // Keep non-Latin authored titles semantic and stable instead of falling
    // back to their current array index (which changes when a group is moved).
    if (/^[\p{Letter}\p{Number}]$/u.test(character)) {
      tokens.push(`u${character.codePointAt(0)!.toString(16)}`);
    }
  }
  flushAscii();
  return tokens.join("-");
}

function stripScalar(value: string): string {
  return value.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, double, single) => double ?? single ?? "");
}

function readFrontmatter(lines: string[], errors: ReviewReportParseIssue[]): {
  frontmatter?: ReviewReportFrontmatter;
  contentStart: number;
} {
  if (lines[0]?.trim() !== "---") {
    errors.push({ code: "E_REPORT_FRONTMATTER", message: "report must start with fixed YAML frontmatter", line: 1 });
    return { contentStart: 0 };
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close === -1) {
    errors.push({ code: "E_REPORT_FRONTMATTER", message: "report frontmatter is not closed", line: 1 });
    return { contentStart: 1 };
  }
  const entries: Array<[string, string, number]> = [];
  for (let index = 1; index < close; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    const match = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line);
    if (match === null) {
      errors.push({ code: "E_REPORT_FRONTMATTER", message: "frontmatter fields must be scalar key/value pairs", line: index + 1 });
      continue;
    }
    entries.push([match[1]!, stripScalar(match[2] ?? ""), index + 1]);
  }
  const keys = entries.map(([key]) => key);
  if (keys.join("\0") !== FRONTMATTER_KEYS.join("\0")) {
    errors.push({
      code: "E_REPORT_FRONTMATTER_KEYS",
      message: `frontmatter must contain exactly these fields in order: ${FRONTMATTER_KEYS.join(", ")}`,
      line: 2,
    });
  }
  const values = Object.fromEntries(entries.map(([key, value]) => [key, value])) as Record<string, string>;
  const revision = Number(values.revision);
  const valid =
    values.type === "otacon-pr-review" && values.version === "1" &&
    SESSION.test(values.session ?? "") && Number.isInteger(revision) && revision > 0 &&
    PR.test(values.pr ?? "") && typeof values.head === "string" && values.head !== "" &&
    SHA256.test(values["knowledge-snapshot"] ?? "") &&
    (values.altitude === "balanced" || values.altitude === "expert");
  if (!valid) {
    errors.push({
      code: "E_REPORT_FRONTMATTER_VALUE",
      message: "frontmatter values do not match the PR review report contract",
      line: 2,
    });
    return { contentStart: close + 1 };
  }
  return {
    frontmatter: {
      type: "otacon-pr-review",
      version: 1,
      session: values.session!,
      revision,
      pr: values.pr!,
      head: values.head!,
      knowledgeSnapshot: values["knowledge-snapshot"] as KnowledgeHash,
      altitude: values.altitude as ReviewAltitude,
    },
    contentStart: close + 1,
  };
}

interface LabeledValue {
  value: string;
  /** One-based line within the Code group's Markdown body. */
  line: number;
}

function visitOutsideFences(markdown: string, visit: (line: string, index: number) => void): void {
  const lines = markdown.split("\n");
  let fence: { character: "`" | "~"; length: number } | undefined;
  lines.forEach((line, index) => {
    if (fence !== undefined) {
      const close = new RegExp(`^\\s*${fence.character === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      if (close.test(line)) fence = undefined;
      return;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (open !== undefined) {
      fence = { character: open[0] as "`" | "~", length: open.length };
      return;
    }
    visit(line, index);
  });
}

function readLabeledValues(markdown: string, label: string): LabeledValue[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\*\\*${escaped}:\\*\\*\\s*(.+?)\\s*$`, "i");
  const values: LabeledValue[] = [];
  visitOutsideFences(markdown, (line, index) => {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined) values.push({ value: match[1].trim(), line: index + 1 });
  });
  return values;
}

function parseSurfaces(raw: string | undefined): { surfaces: ReviewCodeSurface[]; malformed: boolean } {
  if (raw === undefined) return { surfaces: [], malformed: false };
  let malformed = false;
  const surfaces = raw.split(",").flatMap((rawItem) => {
    const quoted = /^`([^`]+)`$/.exec(rawItem.trim());
    const match = quoted === null ? null : SURFACE.exec(quoted[1]!);
    if (match === null) {
      malformed = true;
      return [];
    }
    return [{ file: match[1]!, symbol: match[2]! }];
  });
  return { surfaces, malformed };
}

/** Remove only the contract labels that occur outside fenced code. */
export function stripReviewCodeGroupMetadata(markdown: string): string {
  const metadataLines = new Set<number>();
  visitOutsideFences(markdown, (line, index) => {
    if (/^\*\*(?:Purpose|Changed behavior|Surfaces):\*\*/i.test(line)) metadataLines.add(index);
  });
  return markdown
    .split("\n")
    .filter((_line, index) => !metadataLines.has(index))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * Parse both accepted reports and damaged/manual edits. Consumers may render
 * every recovered section, while submit treats `errors` as hard failures.
 */
export function parseReviewReport(markdown: string): ParsedReviewReport {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const errors: ReviewReportParseIssue[] = [];
  const { frontmatter, contentStart } = readFrontmatter(lines, errors);
  const headings: Array<{ name: ReviewReportSectionName; line: number }> = [];
  const sectionBoundaries: number[] = [];
  visitOutsideFences(lines.slice(contentStart).join("\n"), (line, relativeIndex) => {
    const index = contentStart + relativeIndex;
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match === null) return;
    sectionBoundaries.push(index + 1);
    if (!REVIEW_REPORT_SECTIONS.includes(match[1] as ReviewReportSectionName)) {
      errors.push({ code: "E_REPORT_SECTION_UNKNOWN", message: `unexpected level-two section: ${match[1]}`, line: index + 1 });
      return;
    }
    headings.push({ name: match[1] as ReviewReportSectionName, line: index + 1 });
  });
  if (headings.map(({ name }) => name).join("\0") !== REVIEW_REPORT_SECTIONS.join("\0")) {
    errors.push({
      code: "E_REPORT_SECTION_ORDER",
      message: "report must contain exactly ## Background, ## Intuition, ## Code, ## Quiz in that order",
      line: headings[0]?.line ?? contentStart + 1,
    });
  }
  const sections: ReviewReportSection[] = headings.map((heading) => {
    const nextBoundary = sectionBoundaries.find((line) => line > heading.line);
    const endLine = (nextBoundary ?? (lines.length + 1)) - 1;
    return {
      name: heading.name,
      id: heading.name.toLowerCase() as Lowercase<ReviewReportSectionName>,
      startLine: heading.line,
      endLine,
      markdown: lines.slice(heading.line, endLine).join("\n").replace(/^\n+|\n+$/g, ""),
    };
  });

  const code = sections.find((section) => section.name === "Code");
  const codeGroups: ReviewCodeGroup[] = [];
  if (code !== undefined) {
    const starts: Array<{ line: number; rawTitle: string }> = [];
    visitOutsideFences(lines.slice(code.startLine, code.endLine).join("\n"), (text, relativeIndex) => {
      const line = code.startLine + relativeIndex + 1;
      const match = /^###\s+(.+?)\s*$/.exec(text);
      if (match !== null) starts.push({ line, rawTitle: match[1]! });
    });
    starts.forEach((start, index) => {
      const endLine = (starts[index + 1]?.line ?? (code.endLine + 1)) - 1;
      const kindMatch = CODE_GROUP.exec(start.rawTitle);
      const title = kindMatch?.[2]?.trim() ?? start.rawTitle;
      const groupMarkdown = lines.slice(start.line, endLine).join("\n").replace(/^\n+|\n+$/g, "");
      if (kindMatch === null) {
        errors.push({
          code: "E_REPORT_GROUP_HEADING",
          message: "Code group heading must begin with Interface changes, Integration path, or Implementation walkthrough",
          line: start.line,
        });
      }
      const purpose = readLabeledValues(groupMarkdown, "Purpose");
      const changedBehavior = readLabeledValues(groupMarkdown, "Changed behavior");
      const surfaceLabels = readLabeledValues(groupMarkdown, "Surfaces");
      for (const [label, values] of [["Purpose", purpose], ["Changed behavior", changedBehavior], ["Surfaces", surfaceLabels]] as const) {
        if (values.length > 1) {
          errors.push({
            code: "E_REPORT_GROUP_METADATA_DUPLICATE",
            message: `Code group must contain exactly one **${label}:** statement`,
            line: start.line + values[1]!.line,
          });
        }
      }
      const parsedSurfaces = parseSurfaces(surfaceLabels[0]?.value);
      if (parsedSurfaces.malformed) {
        errors.push({
          code: "E_REPORT_GROUP_SURFACE",
          message: "every Code group surface must be a backticked `file#symbol` reference",
          line: start.line + (surfaceLabels[0]?.line ?? 0),
        });
      }
      codeGroups.push({
        id: `code-${kindMatch === null ? "group" : KIND_BY_LABEL[kindMatch[1]!]!}-${slugify(title) || index + 1}`,
        kind: kindMatch === null ? undefined : KIND_BY_LABEL[kindMatch[1]!],
        title,
        startLine: start.line,
        endLine,
        markdown: groupMarkdown,
        purpose: purpose[0]?.value,
        changedBehavior: changedBehavior[0]?.value,
        surfaces: parsedSurfaces.surfaces,
      });
    });
  }
  return { frontmatter, sections, codeGroups, errors };
}
