// Pins the one split both the switcher and the home list read (DESIGN.md §7,
// §10): approved is the only divider, order is preserved on both sides, and no
// session is dropped or duplicated — the property the "they can never disagree"
// claim rests on. Runs under the root tsconfig/bun (no DOM needed).

import { describe, expect, test } from "bun:test";
import type { SessionStatus, SessionSummary } from "../shared/types.js";
import { isApproved, partitionByApproval } from "./session-filter.js";

function session(id: string, status: SessionStatus): SessionSummary {
  return {
    id,
    title: id,
    repo: "/repo",
    branch: "",
    quick: false,
    status,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    revision: 1,
    lastReviewedRevision: 0,
    pendingEvents: 0,
    openQuestions: 0,
    parked: false,
  };
}

describe("isApproved", () => {
  test("is true only for the approved status", () => {
    expect(isApproved("approved")).toBe(true);
    for (const status of ["draft", "in_review", "revising"] as const) {
      expect(isApproved(status)).toBe(false);
    }
  });
});

describe("partitionByApproval", () => {
  test("splits on status === approved", () => {
    const { active, approved } = partitionByApproval([
      session("a", "in_review"),
      session("b", "approved"),
      session("c", "draft"),
      session("d", "approved"),
    ]);
    expect(active.map((s) => s.id)).toEqual(["a", "c"]);
    expect(approved.map((s) => s.id)).toEqual(["b", "d"]);
  });

  test("preserves the input order within each list", () => {
    const { active, approved } = partitionByApproval([
      session("p3", "approved"),
      session("x2", "revising"),
      session("p1", "approved"),
      session("x1", "in_review"),
    ]);
    expect(active.map((s) => s.id)).toEqual(["x2", "x1"]);
    expect(approved.map((s) => s.id)).toEqual(["p3", "p1"]);
  });

  test("never drops or duplicates a session", () => {
    const input = [
      session("a", "approved"),
      session("b", "in_review"),
      session("c", "approved"),
    ];
    const { active, approved } = partitionByApproval(input);
    expect(active.length + approved.length).toBe(input.length);
    expect([...active, ...approved].map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
  });

  test("empty input yields two empty lists", () => {
    const { active, approved } = partitionByApproval([]);
    expect(active).toEqual([]);
    expect(approved).toEqual([]);
  });

  test("all-approved leaves the active list empty", () => {
    const { active, approved } = partitionByApproval([
      session("a", "approved"),
      session("b", "approved"),
    ]);
    expect(active).toEqual([]);
    expect(approved.map((s) => s.id)).toEqual(["a", "b"]);
  });
});
