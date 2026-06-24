import { describe, expect, test } from "bun:test";
import {
  freshOpenQuestionIds,
  hasOpenQuestion,
  initialInterviewOpen,
} from "./interview-open.js";
import type { TranscriptEntry } from "../api";

const AT = "2026-06-21T00:00:00.000Z";

// Same factory shape as interview.test.tsx: a question defaults to open
// (no `answer`); pass `answer` to settle it. Override `id` to model new asks.
function entry(fields: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: "q1", askedAt: AT, question: "why?", ...fields };
}

const answered = (id: string): TranscriptEntry =>
  entry({ id, answer: { answeredAt: AT, choice: "A" } });

describe("hasOpenQuestion", () => {
  test("an empty transcript has no open question", () => {
    expect(hasOpenQuestion([])).toBe(false);
  });

  test("a transcript where every entry is answered has no open question", () => {
    expect(hasOpenQuestion([answered("q1"), answered("q2")])).toBe(false);
  });

  test("a transcript with at least one unanswered entry has an open question", () => {
    expect(hasOpenQuestion([answered("q1"), entry({ id: "q2" })])).toBe(true);
  });
});

describe("initialInterviewOpen", () => {
  test("the grill phase opens the panel even with nothing pending", () => {
    expect(initialInterviewOpen(true, [answered("q1")])).toBe(true);
  });

  test("outside the grill phase with nothing pending the panel is collapsed", () => {
    expect(initialInterviewOpen(false, [answered("q1")])).toBe(false);
  });

  test("a pending question opens the panel outside the grill phase (reload mid-question)", () => {
    expect(initialInterviewOpen(false, [entry({ id: "q1" })])).toBe(true);
  });

  test("the grill phase with a pending question opens the panel", () => {
    expect(initialInterviewOpen(true, [entry({ id: "q1" })])).toBe(true);
  });
});

describe("freshOpenQuestionIds", () => {
  test("a new unanswered id absent from `seen` is fresh", () => {
    const seen = new Set(["q1"]);
    const transcript = [answered("q1"), entry({ id: "q2" })];
    expect(freshOpenQuestionIds(seen, transcript)).toEqual(["q2"]);
  });

  test("a new id that arrived already answered is not fresh", () => {
    const seen = new Set(["q1"]);
    const transcript = [answered("q1"), answered("q2")];
    expect(freshOpenQuestionIds(seen, transcript)).toEqual([]);
  });

  test("an answer landing on a known id is never fresh", () => {
    // q2 is already in `seen` (it was asked before); now it carries an answer.
    const seen = new Set(["q1", "q2"]);
    const transcript = [answered("q1"), answered("q2")];
    expect(freshOpenQuestionIds(seen, transcript)).toEqual([]);
  });

  test("multiple new unanswered ids are all returned, in transcript order", () => {
    const seen = new Set(["q1"]);
    const transcript = [answered("q1"), entry({ id: "q2" }), entry({ id: "q3" })];
    expect(freshOpenQuestionIds(seen, transcript)).toEqual(["q2", "q3"]);
  });

  test("no new ids yields an empty list", () => {
    const seen = new Set(["q1", "q2"]);
    const transcript = [answered("q1"), entry({ id: "q2" })];
    expect(freshOpenQuestionIds(seen, transcript)).toEqual([]);
  });

  test("does not mutate the `seen` set", () => {
    const seen = new Set(["q1"]);
    freshOpenQuestionIds(seen, [answered("q1"), entry({ id: "q2" })]);
    expect([...seen]).toEqual(["q1"]);
  });
});
