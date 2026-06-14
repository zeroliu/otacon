import { describe, expect, test } from "bun:test";
import type { Thread } from "../../shared/types.js";
import { groupThreads } from "./group.js";

const comment = (id: string): Thread => ({
  id,
  kind: "comment",
  batch: "b1",
  anchor: { section: "phase-1", exact: "RS256" },
  body: `comment ${id}`,
  createdAt: "2026-06-14T00:00:00.000Z",
});

const question = (id: string, extra: Partial<Extract<Thread, { kind: "question" }>> = {}): Thread => ({
  id,
  kind: "question",
  anchor: { section: "decisions" },
  body: `question ${id}`,
  createdAt: "2026-06-14T00:00:00.000Z",
  ...extra,
});

describe("groupThreads", () => {
  test("comments and root questions pass through as ordered singleton groups", () => {
    const groups = groupThreads([comment("t1"), question("q1"), comment("t2")]);
    expect(groups.map((g) => g.root.id)).toEqual(["t1", "q1", "t2"]);
    expect(groups.every((g) => g.followups.length === 0)).toBe(true);
  });

  test("follow-ups fold under their root and never appear as top-level entries", () => {
    const groups = groupThreads([
      question("q1"),
      question("q2", { replyTo: "q1", createdAt: "2026-06-14T00:01:00.000Z" }),
      question("q3", { replyTo: "q1", createdAt: "2026-06-14T00:02:00.000Z" }),
    ]);
    expect(groups.map((g) => g.root.id)).toEqual(["q1"]);
    expect(groups[0]?.followups.map((f) => f.id)).toEqual(["q2", "q3"]);
  });

  test("follow-ups are ordered by createdAt regardless of input order", () => {
    const groups = groupThreads([
      question("q1"),
      question("q3", { replyTo: "q1", createdAt: "2026-06-14T00:02:00.000Z" }),
      question("q2", { replyTo: "q1", createdAt: "2026-06-14T00:01:00.000Z" }),
    ]);
    expect(groups[0]?.followups.map((f) => f.id)).toEqual(["q2", "q3"]);
  });

  test("a follow-up on a follow-up (replyTo = root) folds into the same group", () => {
    // The daemon collapses chains to one root, so q3's replyTo is q1, not q2.
    const groups = groupThreads([
      question("q1"),
      question("q2", { replyTo: "q1", createdAt: "2026-06-14T00:01:00.000Z" }),
      question("q3", { replyTo: "q1", createdAt: "2026-06-14T00:02:00.000Z" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.followups.map((f) => f.id)).toEqual(["q2", "q3"]);
  });

  test("a conversation stays one group so it travels (orphans) as a unit", () => {
    // The rail splits live/orphaned by the ROOT's anchorState; grouping must
    // keep the follow-up attached so an orphaned root takes its whole chain to
    // the tray, regardless of the child's own anchor state.
    const groups = groupThreads([
      question("q1", { anchorState: "orphaned" }),
      question("q2", { replyTo: "q1" }), // child not independently orphaned
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.root.anchorState).toBe("orphaned");
    expect(groups[0]?.followups.map((f) => f.id)).toEqual(["q2"]);
  });

  test("a follow-up whose root is absent degrades to its own group, never dropped", () => {
    const groups = groupThreads([question("q2", { replyTo: "q1" })]);
    expect(groups.map((g) => g.root.id)).toEqual(["q2"]);
  });
});
