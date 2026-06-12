// Server-computed structural diff between two plan revisions (DESIGN.md §6,
// §9 layer 3). The plan is segmented into the same slug units the review
// screen renders (summary, decisions, phase-<n>, risks, open-questions) by
// reusing the linter's pure parser; each unit gets a changed/unchanged status
// for the gutter markers plus unified-style line hunks for the diff view.
// The line diff is a hand-rolled LCS — plan units are budgeted-small, so the
// quadratic table is trivially cheap and no dependency is worth it
// (DECISIONS.md "Diff engine: hand-rolled LCS over slug units").

import type { DiffHunk, DiffLine, SectionDiff } from "../shared/types.js";
import { parsePlan } from "./linter/parse.js";

/** One diffable/anchorable plan unit: a slug plus its raw lines in the plan. */
export interface PlanUnit {
  id: string;
  title: string;
  /** 1-based line of the unit's heading in the plan file. */
  startLine: number;
  /** Raw lines from the heading through the unit's last line. */
  lines: string[];
}

/**
 * Segment a plan into slug units. Frontmatter is excluded (the daemon-owned
 * revision counter changes every submit — pure noise); the Phases section
 * yields one unit per phase, with any preamble before the first H3 staying on
 * the "phases" unit. Mirrors the slugs the UI renders as DOM ids.
 */
export function segmentPlan(content: string): PlanUnit[] {
  const lines = content.split("\n");
  const plan = parsePlan(content);
  const slice = (start: number, end: number): string[] => lines.slice(start - 1, end);
  const units: PlanUnit[] = [];
  for (const section of plan.sections) {
    const phases = section.phases ?? [];
    if (section.id !== "phases" || phases.length === 0) {
      units.push({
        id: section.id,
        title: section.title,
        startLine: section.startLine,
        lines: slice(section.startLine, section.endLine),
      });
      continue;
    }
    const first = phases[0] as (typeof phases)[number];
    if (first.startLine > section.startLine) {
      units.push({
        id: "phases",
        title: section.title,
        startLine: section.startLine,
        lines: slice(section.startLine, first.startLine - 1),
      });
    }
    phases.forEach((phase, i) => {
      const end = i + 1 < phases.length
        ? (phases[i + 1] as (typeof phases)[number]).startLine - 1
        : section.endLine;
      units.push({
        id: `phase-${phase.n}`,
        title: phase.name,
        startLine: phase.startLine,
        lines: slice(phase.startLine, end),
      });
    });
  }
  return units;
}

/** Plain LCS line diff: del lines of `a`, add lines of `b`, in order. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  // Trim the common head and tail first — the LCS table then only covers the
  // changed middle, which keeps the quadratic cost negligible.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);

  // lcs[i][j] = LCS length of am[i..] vs bm[j..].
  const rows = am.length + 1;
  const cols = bm.length + 1;
  const lcs: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = am.length - 1; i >= 0; i--) {
    for (let j = bm.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        am[i] === bm[j]
          ? (lcs[i + 1]![j + 1] as number) + 1
          : Math.max(lcs[i + 1]![j] as number, lcs[i]![j + 1] as number);
    }
  }

  const out: DiffLine[] = a.slice(0, head).map((text) => ({ op: "context", text }));
  let i = 0;
  let j = 0;
  while (i < am.length && j < bm.length) {
    if (am[i] === bm[j]) {
      out.push({ op: "context", text: am[i] as string });
      i++;
      j++;
    } else if ((lcs[i + 1]![j] as number) >= (lcs[i]![j + 1] as number)) {
      out.push({ op: "del", text: am[i] as string });
      i++;
    } else {
      out.push({ op: "add", text: bm[j] as string });
      j++;
    }
  }
  for (; i < am.length; i++) out.push({ op: "del", text: am[i] as string });
  for (; j < bm.length; j++) out.push({ op: "add", text: bm[j] as string });
  for (const text of a.slice(a.length - tail)) out.push({ op: "context", text });
  return out;
}

/** Group a line diff into unified-style hunks with `context` lines around changes. */
export function buildHunks(diff: DiffLine[], context = 3): DiffHunk[] {
  // Indices of changed lines; nearby changes (≤ 2*context apart) share a hunk.
  const changed = diff.flatMap((line, idx) => (line.op === "context" ? [] : [idx]));
  if (changed.length === 0) return [];

  const ranges: [number, number][] = [];
  for (const idx of changed) {
    const last = ranges[ranges.length - 1];
    if (last && idx - last[1] <= 2 * context) last[1] = idx;
    else ranges.push([idx, idx]);
  }

  // Walk the diff once, tracking 1-based from/to line numbers per diff index.
  const fromLine: number[] = [];
  const toLine: number[] = [];
  let f = 1;
  let t = 1;
  for (const line of diff) {
    fromLine.push(f);
    toLine.push(t);
    if (line.op !== "add") f++;
    if (line.op !== "del") t++;
  }

  return ranges.map(([rawStart, rawEnd]) => {
    const start = Math.max(0, rawStart - context);
    const end = Math.min(diff.length - 1, rawEnd + context);
    const lines = diff.slice(start, end + 1);
    return {
      fromStart: fromLine[start] as number,
      fromCount: lines.filter((l) => l.op !== "add").length,
      toStart: toLine[start] as number,
      toCount: lines.filter((l) => l.op !== "del").length,
      lines,
    };
  });
}

/**
 * The full structural diff between two revisions' markdown. Units follow the
 * `to` plan's order; units that disappeared are appended as "removed".
 */
export function diffPlans(fromContent: string, toContent: string): SectionDiff[] {
  const fromUnits = new Map(segmentPlan(fromContent).map((u) => [u.id, u]));
  const sections: SectionDiff[] = [];
  for (const unit of segmentPlan(toContent)) {
    const before = fromUnits.get(unit.id);
    fromUnits.delete(unit.id);
    if (!before) {
      sections.push({
        id: unit.id,
        title: unit.title,
        status: "added",
        hunks: buildHunks(unit.lines.map((text) => ({ op: "add", text }))),
      });
    } else {
      const diff = diffLines(before.lines, unit.lines);
      const hunks = buildHunks(diff);
      sections.push({
        id: unit.id,
        title: unit.title,
        status: hunks.length === 0 ? "unchanged" : "changed",
        hunks,
      });
    }
  }
  for (const unit of fromUnits.values()) {
    sections.push({
      id: unit.id,
      title: unit.title,
      status: "removed",
      hunks: buildHunks(unit.lines.map((text) => ({ op: "del", text }))),
    });
  }
  return sections;
}
