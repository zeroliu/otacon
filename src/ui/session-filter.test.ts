// Pins the one split both the switcher and the home list read (session registry and switcher,
// review UI, approval and archive lifecycle): the terminal set is the only divider, order is preserved on both
// sides, and no session is dropped or duplicated — the property the "they can
// never disagree" claim rests on. `implementing` is active, not over. Runs
// under the root tsconfig/bun (no DOM needed).

import { describe, expect, test } from "bun:test";
import type { SessionStatus, SessionSummary } from "../shared/types.js";
import { isOver, partitionByApproval } from "./session-filter.js";

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

describe("isOver", () => {
  test("is true for every terminal status", () => {
    for (const status of ["approved", "implemented", "implement_failed"] as const) {
      expect(isOver(status)).toBe(true);
    }
  });

  test("is false for every active status — including implementing and finalizing", () => {
    for (const status of ["draft", "in_review", "revising", "finalizing", "implementing"] as const) {
      expect(isOver(status)).toBe(false);
    }
  });
});

describe("partitionByApproval", () => {
  test("splits on the terminal set; implementing stays active", () => {
    const { active, over } = partitionByApproval([
      session("a", "in_review"),
      session("b", "approved"),
      session("c", "implementing"),
      session("d", "implemented"),
      session("e", "implement_failed"),
    ]);
    expect(active.map((s) => s.id)).toEqual(["a", "c"]);
    expect(over.map((s) => s.id)).toEqual(["b", "d", "e"]);
  });

  test("preserves the input order within each list", () => {
    const { active, over } = partitionByApproval([
      session("p3", "approved"),
      session("x2", "revising"),
      session("p1", "implemented"),
      session("x1", "implementing"),
    ]);
    expect(active.map((s) => s.id)).toEqual(["x2", "x1"]);
    expect(over.map((s) => s.id)).toEqual(["p3", "p1"]);
  });

  test("never drops or duplicates a session", () => {
    const input = [
      session("a", "approved"),
      session("b", "in_review"),
      session("c", "implement_failed"),
      session("d", "implementing"),
    ];
    const { active, over } = partitionByApproval(input);
    expect(active.length + over.length).toBe(input.length);
    expect([...active, ...over].map((s) => s.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("empty input yields two empty lists", () => {
    const { active, over } = partitionByApproval([]);
    expect(active).toEqual([]);
    expect(over).toEqual([]);
  });

  test("all-terminal leaves the active list empty", () => {
    const { active, over } = partitionByApproval([
      session("a", "approved"),
      session("b", "implemented"),
    ]);
    expect(active).toEqual([]);
    expect(over.map((s) => s.id)).toEqual(["a", "b"]);
  });
});
