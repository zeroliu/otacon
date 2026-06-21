import { describe, expect, test } from "bun:test";
import { orderedOptions, prefillFromAnswer } from "./answer-form.js";
import type { GrillAnswer, TranscriptEntry } from "../api";

const ANSWERED_AT = "2026-06-21T00:00:00.000Z";

function answer(fields: Partial<GrillAnswer>): GrillAnswer {
  return { answeredAt: ANSWERED_AT, ...fields };
}

function entry(fields: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: "q1", askedAt: ANSWERED_AT, question: "why?", ...fields };
}

describe("prefillFromAnswer", () => {
  test("choice-only lights that one chip, no note", () => {
    expect(prefillFromAnswer(answer({ choice: "B" }))).toEqual({ picked: ["B"], text: "" });
  });

  test("choices pre-pick the whole multi-select", () => {
    expect(prefillFromAnswer(answer({ choices: ["A", "C"] }))).toEqual({
      picked: ["A", "C"],
      text: "",
    });
  });

  test("text-only seeds the textarea with no chips", () => {
    expect(prefillFromAnswer(answer({ text: "free form" }))).toEqual({
      picked: [],
      text: "free form",
    });
  });

  test("choice plus text seeds both (chip lit, note shown)", () => {
    expect(prefillFromAnswer(answer({ choice: "B", text: "a note" }))).toEqual({
      picked: ["B"],
      text: "a note",
    });
  });

  test("multi choices plus text seeds both", () => {
    expect(prefillFromAnswer(answer({ choices: ["A", "B"], text: "context" }))).toEqual({
      picked: ["A", "B"],
      text: "context",
    });
  });
});

describe("orderedOptions", () => {
  test("the recommended option floats to the front", () => {
    expect(orderedOptions(entry({ options: ["A", "B", "C"], recommend: "B" }))).toEqual([
      "B",
      "A",
      "C",
    ]);
  });

  test("no recommend leaves the order untouched", () => {
    expect(orderedOptions(entry({ options: ["A", "B", "C"] }))).toEqual(["A", "B", "C"]);
  });

  test("no options is the empty list (free-text question)", () => {
    expect(orderedOptions(entry({}))).toEqual([]);
  });
});
