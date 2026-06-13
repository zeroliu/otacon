import { describe, expect, test } from "bun:test";
import { CliError } from "../output.js";
import { parseBatch } from "./ask.js";

/** parseBatch rejects with a usage error (E_USAGE, exit 2). */
function expectUsage(content: string): void {
  let thrown: unknown;
  try {
    parseBatch(content);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CliError);
  expect((thrown as CliError).code).toBe("E_USAGE");
  expect((thrown as CliError).exitCode).toBe(2);
}

describe("parseBatch", () => {
  test("normalizes an array of question specs", () => {
    const specs = parseBatch(
      JSON.stringify([
        { question: "free text?" },
        { question: "pick one?", options: ["A", "B"], recommend: "B" },
        { question: "pick any?", options: ["x", "y", "z"], multi: true },
      ]),
    );
    expect(specs).toEqual([
      { question: "free text?" },
      { question: "pick one?", options: ["A", "B"], recommend: "B" },
      { question: "pick any?", options: ["x", "y", "z"], multi: true },
    ]);
  });

  test("drops multi:false and an absent recommend from the normalized spec", () => {
    expect(parseBatch(JSON.stringify([{ question: "q", options: ["A", "B"], multi: false }]))).toEqual([
      { question: "q", options: ["A", "B"] },
    ]);
  });

  test("rejects non-JSON, non-array, and empty-array payloads", () => {
    expectUsage("not json");
    expectUsage(JSON.stringify({ question: "not an array" }));
    expectUsage(JSON.stringify([]));
    expectUsage(JSON.stringify("a string"));
  });

  test("rejects a malformed member, naming its index", () => {
    expectUsage(JSON.stringify([{ question: "ok" }, { notQuestion: "x" }])); // missing question
    expectUsage(JSON.stringify([{ question: "" }])); // empty question
    expectUsage(JSON.stringify([{ question: "q", options: ["only one"] }])); // <2 options
    expectUsage(JSON.stringify([{ question: "q", options: ["A", "A"] }])); // dup options
    expectUsage(JSON.stringify([{ question: "q", options: ["A", "B"], recommend: "C" }])); // recommend off-list
    expectUsage(JSON.stringify([{ question: "q", multi: true }])); // multi without options
    expectUsage(JSON.stringify(["just a string member"]));
  });

  test("the index named in a member error points at the offending member", () => {
    try {
      parseBatch(JSON.stringify([{ question: "ok" }, { question: "ok" }, { question: "" }]));
      throw new Error("expected parseBatch to throw");
    } catch (error) {
      expect((error as CliError).message).toContain("--batch[2]");
    }
  });
});
