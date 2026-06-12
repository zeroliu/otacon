import { describe, expect, test } from "bun:test";
import type { DiffLine } from "../shared/types.js";
import { buildHunks, diffLines, diffPlans, segmentPlan } from "./diff.js";

const plan = (body: string): string => `---
title: t
session: otc_test01
revision: 1
status: in_review
created: 2026-06-13
---

${body}`;

const BASE = plan(`## Summary

Replace session auth with JWT.

## Decisions

- D1: RS256 over HS256 ← q7

## Phases

### Phase 1 — Token issuance

Goal: Issue RS256 JWTs.
Files:
- src/auth/issuer.ts
Verification: Unit tests.

### Phase 2 — Middleware

Goal: Verify JWTs in middleware.
Files:
- src/middleware/jwt.ts
Verification: Integration tests.

## Risks

- Clock skew.

## Open Questions

- None.`);

describe("segmentPlan", () => {
  test("yields slug units, one per section and per phase, frontmatter excluded", () => {
    const units = segmentPlan(BASE);
    expect(units.map((u) => u.id)).toEqual([
      "summary",
      "decisions",
      "phases",
      "phase-1",
      "phase-2",
      "risks",
      "open-questions",
    ]);
    const phase2 = units.find((u) => u.id === "phase-2");
    expect(phase2?.title).toBe("Middleware");
    expect(phase2?.lines[0]).toBe("### Phase 2 — Middleware");
    expect(phase2?.lines).toContain("Verification: Integration tests.");
    expect(units.every((u) => !u.lines.some((l) => l.startsWith("title:")))).toBe(true);
  });

  test("the phases unit holds the heading and any preamble before the first H3", () => {
    // BASE has a blank line between "## Phases" and the first H3.
    expect(segmentPlan(BASE).find((u) => u.id === "phases")?.lines).toEqual(["## Phases", ""]);
    const tight = BASE.replace("## Phases\n\n### Phase 1", "## Phases\n### Phase 1");
    expect(segmentPlan(tight).find((u) => u.id === "phases")?.lines).toEqual(["## Phases"]);
  });

  test("an empty plan has no units", () => {
    expect(segmentPlan("")).toEqual([]);
  });
});

describe("diffLines", () => {
  const ops = (d: DiffLine[]): string => d.map((l) => l.op[0]).join("");

  test("identical inputs are all context", () => {
    expect(ops(diffLines(["a", "b"], ["a", "b"]))).toBe("cc");
  });

  test("pure insertion and pure deletion", () => {
    expect(diffLines(["a", "c"], ["a", "b", "c"])).toEqual([
      { op: "context", text: "a" },
      { op: "add", text: "b" },
      { op: "context", text: "c" },
    ]);
    expect(ops(diffLines(["a", "b", "c"], ["a", "c"]))).toBe("cdc");
  });

  test("a changed line is a del+add pair", () => {
    expect(diffLines(["a", "old", "z"], ["a", "new", "z"])).toEqual([
      { op: "context", text: "a" },
      { op: "del", text: "old" },
      { op: "add", text: "new" },
      { op: "context", text: "z" },
    ]);
  });

  test("empty sides", () => {
    expect(ops(diffLines([], ["a", "b"]))).toBe("aa");
    expect(ops(diffLines(["a", "b"], []))).toBe("dd");
    expect(diffLines([], [])).toEqual([]);
  });

  test("repeated lines keep the longest common subsequence", () => {
    const diff = diffLines(["x", "x", "y"], ["y", "x", "x"]);
    const kept = diff.filter((l) => l.op === "context").map((l) => l.text);
    expect(kept.length).toBeGreaterThanOrEqual(2);
    // Round-trip: dels+context reproduce `a`, adds+context reproduce `b`.
    expect(diff.filter((l) => l.op !== "add").map((l) => l.text)).toEqual(["x", "x", "y"]);
    expect(diff.filter((l) => l.op !== "del").map((l) => l.text)).toEqual(["y", "x", "x"]);
  });
});

describe("buildHunks", () => {
  const line = (op: DiffLine["op"], text: string): DiffLine => ({ op, text });

  test("no changes, no hunks", () => {
    expect(buildHunks([line("context", "a"), line("context", "b")])).toEqual([]);
  });

  test("one change carries up to `context` lines around it, clamped at edges", () => {
    const diff = [
      line("context", "1"),
      line("context", "2"),
      line("del", "old"),
      line("add", "new"),
      line("context", "3"),
    ];
    const hunks = buildHunks(diff, 3);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toEqual({
      fromStart: 1,
      fromCount: 4,
      toStart: 1,
      toCount: 4,
      lines: diff,
    });
  });

  test("distant changes split into separate hunks with correct line numbers", () => {
    const diff: DiffLine[] = [
      line("add", "head"),
      ...Array.from({ length: 10 }, (_, i) => line("context", `mid${i}`)),
      line("del", "tail"),
    ];
    const hunks = buildHunks(diff, 2);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ fromStart: 1, fromCount: 2, toStart: 1, toCount: 3 });
    // Second hunk starts 2 context lines before the del: from-line 9, to-line 10.
    expect(hunks[1]).toMatchObject({ fromStart: 9, fromCount: 3, toStart: 10, toCount: 2 });
    expect(hunks[1]?.lines.map((l) => l.op)).toEqual(["context", "context", "del"]);
  });

  test("changes within 2*context of each other merge into one hunk", () => {
    const diff: DiffLine[] = [
      line("del", "a"),
      line("context", "1"),
      line("context", "2"),
      line("add", "b"),
    ];
    expect(buildHunks(diff, 2)).toHaveLength(1);
    expect(buildHunks(diff, 1)).toHaveLength(2); // gap 3 > 2*1 — separate hunks
  });
});

describe("diffPlans", () => {
  test("unchanged everywhere when both revisions are identical", () => {
    const sections = diffPlans(BASE, BASE);
    expect(sections.every((s) => s.status === "unchanged" && s.hunks.length === 0)).toBe(true);
  });

  test("an edited phase is changed; everything else stays unchanged", () => {
    const next = BASE.replace("Goal: Verify JWTs in middleware.", "Goal: Verify and refresh JWTs.");
    const sections = diffPlans(BASE, next);
    const byId = new Map(sections.map((s) => [s.id, s]));
    expect(byId.get("phase-2")?.status).toBe("changed");
    expect(byId.get("phase-2")?.hunks).toHaveLength(1);
    expect(byId.get("phase-2")?.hunks[0]?.lines).toContainEqual({
      op: "add",
      text: "Goal: Verify and refresh JWTs.",
    });
    expect(byId.get("phase-1")?.status).toBe("unchanged");
    expect(byId.get("summary")?.status).toBe("unchanged");
  });

  test("frontmatter-only changes diff as fully unchanged", () => {
    const next = BASE.replace("revision: 1", "revision: 2");
    expect(diffPlans(BASE, next).every((s) => s.status === "unchanged")).toBe(true);
  });

  test("a new phase is added; a deleted one is appended as removed", () => {
    const withP3 = BASE.replace(
      "## Risks",
      "### Phase 3 — Cleanup\n\nGoal: Drop sessions table.\nFiles:\n- db/migrations/\nVerification: Migration test.\n\n## Risks",
    );
    const added = diffPlans(BASE, withP3);
    expect(added.find((s) => s.id === "phase-3")).toMatchObject({ status: "added", title: "Cleanup" });
    expect(added.find((s) => s.id === "phase-3")?.hunks[0]?.lines.every((l) => l.op === "add")).toBe(true);

    const removed = diffPlans(withP3, BASE);
    const gone = removed.find((s) => s.id === "phase-3");
    expect(gone?.status).toBe("removed");
    expect(gone?.hunks[0]?.lines.every((l) => l.op === "del")).toBe(true);
    // Removed units come after the to-plan's units.
    expect(removed[removed.length - 1]?.id).toBe("phase-3");
  });

  test("diffing from the empty plan marks every unit added", () => {
    expect(diffPlans("", BASE).every((s) => s.status === "added")).toBe(true);
  });
});
