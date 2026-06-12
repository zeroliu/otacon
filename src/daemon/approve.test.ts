import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "../shared/types.js";
import { composeArtifact, localDate, pickArtifactRelPath } from "./approve.js";

const PLAN = `---
title: auth-refactor
session: otc_a1b2c3
revision: 2
status: in_review
created: 2026-06-12
---

## Summary

Ship it.
`;

function q(id: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { id, question: `Question ${id}?`, askedAt: "2026-06-13T00:00:00.000Z", ...extra };
}

describe("composeArtifact", () => {
  test("rewrites frontmatter status and revision to the daemon's truth", () => {
    const out = composeArtifact(PLAN, { revision: 4, entries: [] });
    expect(out).toContain("status: approved");
    expect(out).toContain("revision: 4");
    expect(out).not.toContain("status: in_review");
    expect(out).toContain("title: auth-refactor"); // untouched keys survive
  });

  test("an empty transcript appends no Interview section", () => {
    expect(composeArtifact(PLAN, { revision: 1, entries: [] })).not.toContain("## Interview");
  });

  test("the Interview section renders options, recommendation, and answers", () => {
    const out = composeArtifact(PLAN, {
      revision: 2,
      entries: [
        q("q1", {
          options: ["RS256", "HS256"],
          recommend: "RS256",
          answer: { choice: "RS256", answeredAt: "t" },
        }),
        q("q2", {
          options: ["A", "B", "C"],
          multi: true,
          answer: { choices: ["A", "C"], text: "B later", answeredAt: "t" },
        }),
        q("q3", { answer: { text: "free text\nsecond line", answeredAt: "t" } }),
        q("q4"),
      ],
    });
    expect(out).toContain("## Interview");
    expect(out).toContain("### q1 — Question q1?");
    expect(out).toContain("- Options: RS256 (recommended) | HS256");
    expect(out).toContain("- Answer: RS256");
    expect(out).toContain("- Options (multi): A | B | C");
    expect(out).toContain("- Answer: A, C — B later");
    expect(out).toContain("- Answer: free text\n  second line"); // continuation indent
    expect(out).toContain("- Answer: _unanswered_");
  });

  test("a multi-line question collapses to one heading line", () => {
    const out = composeArtifact(PLAN, {
      revision: 1,
      entries: [q("q1", { question: "line one\nline two?" })],
    });
    expect(out).toContain("### q1 — line one line two?");
  });
});

describe("pickArtifactRelPath", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "otacon-approve-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("slugs the title under docs/plans with the date", () => {
    expect(pickArtifactRelPath(repo, "Auth Refactor!", "2026-06-13")).toBe(
      join("docs", "plans", "2026-06-13-auth-refactor.md"),
    );
  });

  test("collisions get numeric suffixes, never overwrite", () => {
    mkdirSync(join(repo, "docs", "plans"), { recursive: true });
    writeFileSync(join(repo, "docs", "plans", "2026-06-13-auth.md"), "x");
    writeFileSync(join(repo, "docs", "plans", "2026-06-13-auth-2.md"), "x");
    expect(pickArtifactRelPath(repo, "auth", "2026-06-13")).toBe(
      join("docs", "plans", "2026-06-13-auth-3.md"),
    );
  });

  test("an unsluggable title falls back to 'plan'", () => {
    expect(pickArtifactRelPath(repo, "???", "2026-06-13")).toBe(
      join("docs", "plans", "2026-06-13-plan.md"),
    );
  });
});

describe("localDate", () => {
  test("formats YYYY-MM-DD in local time", () => {
    expect(localDate(new Date(2026, 5, 13, 1, 2, 3))).toBe("2026-06-13");
    expect(localDate(new Date(2026, 0, 2))).toBe("2026-01-02");
  });
});
