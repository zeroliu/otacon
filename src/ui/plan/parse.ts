// Render-model plan parser: the same line grammar as the daemon's linter
// parser (src/daemon/linter/parse.ts — headings, "### Phase n — name",
// Goal/Files/Verification labels, "#### Details", fences) but it keeps the
// content the linter only measures (DECISIONS.md "Review screen renders via a
// ported line grammar, not the linter parser"). Section and phase ids are the
// anchoring contract (plan structure, lint, and anchoring): slugified H2 titles and "phase-<n>".
//
// The parser is deliberately tolerant: every stored revision already passed
// the linter at submit, so anything structurally odd renders as plain
// markdown rather than erroring.

export interface MarkdownBlock {
  kind: "markdown";
  text: string;
}

export interface FenceBlock {
  kind: "fence";
  /** First info-string token, lowercased; "" for a bare fence. */
  lang: string;
  /** Remaining info tokens, lowercased — "before"/"after" mark pairs (plan structure, lint, and anchoring). */
  tags: string[];
  code: string;
}

/** Two adjacent fences tagged `before` / `after`, rendered side-by-side. */
export interface PairBlock {
  kind: "pair";
  before: FenceBlock;
  after: FenceBlock;
}

export type Block = MarkdownBlock | FenceBlock | PairBlock;

export interface PlanField {
  key: "goal" | "files" | "verification" | "out-of-scope";
  label: string;
  blocks: Block[];
}

export interface PlanDetails {
  /**
   * Raw lines after the "#### Details" header through the last non-blank one —
   * the same measure the linter's L6 soft cap uses, so the size badge and the
   * warning always quote the same number.
   */
  lineCount: number;
  diagrams: number;
  codeBlocks: number;
  blocks: Block[];
}

export interface PlanPhase {
  /** "phase-<n>" — the anchor id (plan structure, lint, and anchoring). */
  id: string;
  n: number;
  name: string;
  /** Content before the first labeled field (rare; usually empty). */
  body: Block[];
  fields: PlanField[];
  details?: PlanDetails;
}

export interface PlanSection {
  /** Slug of the H2 title — the anchor id (plan structure, lint, and anchoring). */
  id: string;
  title: string;
  blocks: Block[];
  /** Populated only for the Phases section. */
  phases: PlanPhase[];
}

export interface PlanDoc {
  /** First H1 before any section; the screen header already shows the title. */
  title: string | null;
  /** Content between frontmatter/H1 and the first H2. */
  preamble: Block[];
  sections: PlanSection[];
}

const FIELD_KEYS: Record<string, PlanField["key"]> = {
  Goal: "goal",
  Files: "files",
  Verification: "verification",
  "Out of scope": "out-of-scope",
};

// Identical grammar to the linter parser (accepted label/heading forms per
// DECISIONS.md "Plan grammar").
const FIELD_RE = /^(?:\*\*)?(Goal|Files|Verification|Out of scope)(?:\*\*)?:(?:\*\*)?\s*(.*)$/;
const PHASE_RE = /^### Phase (\d+) [—-] (.+?)\s*$/;
const HEADING_RE = /^(#{1,4})\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*(.*)$/;

/** Same slug algorithm as the linter — the section-id contract. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Accumulates markdown runs and fences into a Block list, pairing before/after fences. */
class Collector {
  private readonly blocks: Block[] = [];
  private run: string[] = [];

  line(text: string): void {
    this.run.push(text);
  }

  fence(fence: FenceBlock): void {
    this.flush();
    const previous = this.blocks[this.blocks.length - 1];
    if (
      fence.tags.includes("after") &&
      previous?.kind === "fence" &&
      previous.tags.includes("before")
    ) {
      this.blocks[this.blocks.length - 1] = { kind: "pair", before: previous, after: fence };
      return;
    }
    this.blocks.push(fence);
  }

  done(): Block[] {
    this.flush();
    return this.blocks;
  }

  /** True while nothing but blank lines has been collected. */
  isEmpty(): boolean {
    return this.blocks.length === 0 && this.run.every((l) => l.trim() === "");
  }

  private flush(): void {
    const text = this.run.join("\n").replace(/^\n+|\s+$/g, "");
    this.run = [];
    if (text !== "") this.blocks.push({ kind: "markdown", text });
  }
}

function detailsStats(blocks: Block[]): { diagrams: number; codeBlocks: number } {
  let diagrams = 0;
  let codeBlocks = 0;
  const count = (fence: FenceBlock): void => {
    if (fence.lang === "mermaid") diagrams += 1;
    else codeBlocks += 1;
  };
  for (const block of blocks) {
    if (block.kind === "fence") count(block);
    else if (block.kind === "pair") {
      count(block.before);
      count(block.after);
    }
  }
  return { diagrams, codeBlocks };
}

/** The one container currently receiving content lines. */
interface ActiveTarget {
  assign(blocks: Block[]): void;
  /** Set while a Details block is active — needs its size finalized on close. */
  details?: PlanDetails;
}

export function parsePlan(content: string): PlanDoc {
  const lines = content.split("\n");
  const doc: PlanDoc = { title: null, preamble: [], sections: [] };

  let start = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close !== -1) start = close + 1;
  }

  let collector = new Collector();
  let active: ActiveTarget = { assign: (blocks) => (doc.preamble = blocks) };
  let section: PlanSection | null = null;
  let phase: PlanPhase | null = null;
  let detailsHeaderLine = 0;
  let detailsLastContent = 0;

  // Exactly one container owns the collector at any time; every structural
  // boundary finishes it (assigning its blocks once) and opens a fresh one.
  const finish = (next: ActiveTarget): void => {
    active.assign(collector.done());
    const details = active.details;
    if (details) {
      details.lineCount = Math.max(0, detailsLastContent - detailsHeaderLine);
      Object.assign(details, detailsStats(details.blocks));
    }
    collector = new Collector();
    active = next;
  };

  for (let idx = start; idx < lines.length; idx++) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;
    const inDetails = active.details !== undefined;

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const delimiter = fenceMatch[1]!;
      const info = (fenceMatch[2] ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      const code: string[] = [];
      if (inDetails) detailsLastContent = lineNo;
      while (++idx < lines.length) {
        const inner = lines[idx] ?? "";
        if (inDetails && inner.trim() !== "") detailsLastContent = idx + 1;
        if (inner.trimStart().startsWith(delimiter)) break;
        code.push(inner);
      }
      collector.fence({
        kind: "fence",
        lang: info[0] ?? "",
        tags: info.slice(1),
        code: code.join("\n"),
      });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!;
      // Only a leading H1 is the document title; an H1 after preamble prose
      // is content — swallowing it would silently drop plan text.
      if (level === 1 && section === null && doc.title === null && collector.isEmpty()) {
        doc.title = title;
        continue;
      }
      if (level === 2) {
        const next: PlanSection = { id: slugify(title), title, blocks: [], phases: [] };
        doc.sections.push(next);
        finish({ assign: (blocks) => (next.blocks = blocks) });
        section = next;
        phase = null;
        continue;
      }
      if (level === 3 && section?.id === "phases") {
        const m = PHASE_RE.exec(line);
        if (m) {
          // Normalize the digits exactly like the linter's phaseSlug
          // (`phase-${Number(n)}`) — "Phase 01" must anchor and badge as
          // "phase-1", or L6 warnings would miss their Details block.
          const n = Number(m[1]);
          const next: PlanPhase = {
            id: `phase-${n}`,
            n,
            name: m[2]!,
            body: [],
            fields: [],
          };
          section.phases.push(next);
          finish({ assign: (blocks) => (next.body = blocks) });
          phase = next;
          continue;
        }
      }
      if (level === 4 && phase && title === "Details" && !phase.details) {
        const next: PlanDetails = { lineCount: 0, diagrams: 0, codeBlocks: 0, blocks: [] };
        phase.details = next;
        detailsHeaderLine = lineNo;
        detailsLastContent = lineNo;
        finish({ assign: (blocks) => (next.blocks = blocks), details: next });
        continue;
      }
      // Any other heading is content — fall through to the line handlers.
    }

    if (inDetails) {
      if (line.trim() !== "") detailsLastContent = lineNo;
      collector.line(line);
      continue;
    }

    if (phase) {
      const fm = FIELD_RE.exec(line);
      if (fm) {
        const next: PlanField = { key: FIELD_KEYS[fm[1]!]!, label: fm[1]!, blocks: [] };
        phase.fields.push(next);
        finish({ assign: (blocks) => (next.blocks = blocks) });
        if ((fm[2] ?? "") !== "") collector.line(fm[2]!);
        continue;
      }
    }

    collector.line(line);
  }

  finish({ assign: () => undefined });
  return doc;
}
