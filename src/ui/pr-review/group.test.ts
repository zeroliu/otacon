import { describe, expect, test } from "bun:test";
import { conversationIsUnresolved, groupReviewThreads } from "./group.js";
import type { ReviewThread } from "./model.js";

const turn = (id: string, fields: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  intent: "question",
  anchor: "quote",
  body: `body ${id}`,
  createdAt: `2026-07-15T10:00:0${id.slice(1)}.000Z`,
  status: "open",
  ...fields,
});

describe("PR review conversation grouping", () => {
  test("folds follow-ups under their root in turn order and keeps an orphan visible", () => {
    const groups = groupReviewThreads([
      turn("q1", { response: "root answer", status: "answered" }),
      turn("q3", { replyTo: "q1" }),
      turn("q2", { replyTo: "q1" }),
      turn("t2", { intent: "comment", replyTo: "t9" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.turns.map((item) => item.id)).toEqual(["q1", "q2", "q3"]);
    expect(groups[1]?.root.id).toBe("t2");
  });

  test("counts a multi-turn conversation once while any turn or code action is unresolved", () => {
    const [open] = groupReviewThreads([
      turn("t1", { intent: "comment", response: "done", status: "answered" }),
      turn("t2", { intent: "comment", replyTo: "t1" }),
    ]);
    expect(conversationIsUnresolved(open!)).toBe(true);
    const [settled] = groupReviewThreads(open!.turns.map((item) => ({ ...item, response: "done", status: "answered" })));
    expect(conversationIsUnresolved(settled!)).toBe(false);
    settled!.root.codeActionStatus = "failed";
    expect(conversationIsUnresolved(settled!)).toBe(true);
  });
});
