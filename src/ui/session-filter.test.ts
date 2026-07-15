// Pins the split every session surface reads (session registry and switcher,
// review UI, approval and archive lifecycle): `isOver` is the binary terminal
// divider, and `partitionSessions` layers the three-way active / PR review / done
// split keyed off the PR. Order is preserved within each group, and no session
// is dropped or duplicated (the property the "they can never disagree" claim
// rests on). `implementing` is active, not over; a reopened amendment that
// carries a prUrl but is still non-terminal stays active, NOT in PR review. Runs
// under the root tsconfig/bun (no DOM needed).

import { describe, expect, test } from "bun:test";
import type { SessionStatus, SessionSummary } from "../shared/types.js";
import {
  isOver,
  partitionReviewSessions,
  partitionSessionKinds,
  partitionSessions,
  prInReview,
  shouldRedirectAfterTerminalTransition,
} from "./session-filter.js";

function session(
  id: string,
  status: SessionStatus,
  pr?: { prUrl?: string; prState?: "open" | "merged" | "closed" },
): Extract<SessionSummary, { kind: "plan" }> {
  return {
    kind: "plan",
    id,
    title: id,
    repo: "/repo",
    branch: "",
    quick: false,
    socratic: false,
    status,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    revision: 1,
    lastReviewedRevision: 0,
    pendingEvents: 0,
    openQuestions: 0,
    parked: false,
    ...pr,
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

describe("terminal screen redirect", () => {
  test("redirects a live plan transition but leaves a completed review readable", () => {
    expect(shouldRedirectAfterTerminalTransition({ kind: "plan", status: "approved" }, true)).toBe(true);
    expect(shouldRedirectAfterTerminalTransition({ kind: "review", status: "done" }, true)).toBe(false);
  });
});

describe("prInReview", () => {
  test("terminal + prUrl + open → true", () => {
    expect(prInReview(session("a", "implemented", { prUrl: "u", prState: "open" }))).toBe(true);
  });

  test("terminal + prUrl + no prState → true (not yet probed counts as open)", () => {
    expect(prInReview(session("a", "implemented", { prUrl: "u" }))).toBe(true);
  });

  test("terminal + prUrl + merged or closed → false", () => {
    expect(prInReview(session("a", "implemented", { prUrl: "u", prState: "merged" }))).toBe(false);
    expect(prInReview(session("a", "implemented", { prUrl: "u", prState: "closed" }))).toBe(false);
  });

  test("terminal with NO prUrl → false", () => {
    expect(prInReview(session("a", "approved"))).toBe(false);
    expect(prInReview(session("a", "implement_failed"))).toBe(false);
  });

  test("non-terminal WITH a prUrl → false (reopened amendment stays active)", () => {
    expect(prInReview(session("a", "implementing", { prUrl: "u", prState: "open" }))).toBe(false);
    expect(prInReview(session("a", "revising", { prUrl: "u" }))).toBe(false);
  });
});

describe("partitionSessions", () => {
  test("routes each membership case to exactly one bucket", () => {
    const { active, prReview, done } = partitionSessions([
      // terminal + open PR → prReview
      session("pr-open", "implemented", { prUrl: "u", prState: "open" }),
      // terminal + PR not yet probed → prReview (treated as open)
      session("pr-unprobed", "implemented", { prUrl: "u" }),
      // terminal + merged PR → done
      session("pr-merged", "implemented", { prUrl: "u", prState: "merged" }),
      // terminal + closed PR → done
      session("pr-closed", "implemented", { prUrl: "u", prState: "closed" }),
      // terminal approved, Save-only (no PR) → done
      session("save-only", "approved"),
      // terminal failed build, no PR → done
      session("failed", "implement_failed"),
      // non-terminal reopened amendment carrying a prUrl → active (NOT prReview)
      session("amend", "implementing", { prUrl: "u", prState: "open" }),
      // plain non-terminal → active
      session("review", "in_review"),
      session("draft", "draft"),
    ]);
    expect(active.map((s) => s.id)).toEqual(["amend", "review", "draft"]);
    expect(prReview.map((s) => s.id)).toEqual(["pr-open", "pr-unprobed"]);
    expect(done.map((s) => s.id)).toEqual(["pr-merged", "pr-closed", "save-only", "failed"]);
  });

  test("preserves the input order within each bucket", () => {
    const { active, prReview, done } = partitionSessions([
      session("p3", "approved"),
      session("x2", "revising"),
      session("r1", "implemented", { prUrl: "u", prState: "open" }),
      session("p1", "implemented"),
      session("x1", "implementing"),
      session("r2", "implemented", { prUrl: "u" }),
    ]);
    expect(active.map((s) => s.id)).toEqual(["x2", "x1"]);
    expect(prReview.map((s) => s.id)).toEqual(["r1", "r2"]);
    expect(done.map((s) => s.id)).toEqual(["p3", "p1"]);
  });

  test("never drops or duplicates a session", () => {
    const input = [
      session("a", "approved"),
      session("b", "in_review"),
      session("c", "implement_failed"),
      session("d", "implementing"),
      session("e", "implemented", { prUrl: "u", prState: "open" }),
      session("f", "implemented", { prUrl: "u", prState: "merged" }),
    ];
    const { active, prReview, done } = partitionSessions(input);
    expect(active.length + prReview.length + done.length).toBe(input.length);
    expect([...active, ...prReview, ...done].map((s) => s.id).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  test("empty input yields three empty lists", () => {
    const { active, prReview, done } = partitionSessions([]);
    expect(active).toEqual([]);
    expect(prReview).toEqual([]);
    expect(done).toEqual([]);
  });

  test("all-terminal leaves the active list empty", () => {
    const { active, prReview, done } = partitionSessions([
      session("a", "approved"),
      session("b", "implemented", { prUrl: "u", prState: "open" }),
    ]);
    expect(active).toEqual([]);
    expect(prReview.map((s) => s.id)).toEqual(["b"]);
    expect(done.map((s) => s.id)).toEqual(["a"]);
  });
});

describe("partitionSessionKinds", () => {
  test("keeps plans and reviews in separate sidebar modes", () => {
    const plan = session("plan", "draft");
    const review = {
      ...plan,
      id: "review",
      kind: "review",
      status: "working",
      review: {},
    } as unknown as SessionSummary;
    const groups = partitionSessionKinds([plan, review]);
    expect(groups.plans.map((item) => item.id)).toEqual(["plan"]);
    expect(groups.reviews.map((item) => item.id)).toEqual(["review"]);
  });
});

describe("partitionReviewSessions", () => {
  test("keeps active reviews visible and completed reviews in Done", () => {
    const active = { kind: "review", id: "active", status: "reviewing" } as unknown as
      Extract<SessionSummary, { kind: "review" }>;
    const done = { kind: "review", id: "done", status: "done" } as unknown as
      Extract<SessionSummary, { kind: "review" }>;
    const groups = partitionReviewSessions([done, active]);
    expect(groups.active.map((item) => item.id)).toEqual(["active"]);
    expect(groups.done.map((item) => item.id)).toEqual(["done"]);
  });
});
