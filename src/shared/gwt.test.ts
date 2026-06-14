import { describe, expect, test } from "bun:test";
import { parseGwt } from "./gwt.js";

describe("parseGwt", () => {
  test("a single well-formed scenario keeps each clause's text", () => {
    const { scenarios } = parseGwt(
      "Given a fresh session\nWhen the agent submits a plan\nThen review opens",
    );
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]).toEqual({
      given: ["a fresh session"],
      when: ["the agent submits a plan"],
      then: ["review opens"],
      valid: true,
    });
  });

  test("blank lines separate scenarios; surrounding blanks are dropped", () => {
    const { scenarios } = parseGwt(
      "\nGiven a\nWhen b\nThen c\n\nGiven d\nWhen e\nThen f\n\n",
    );
    expect(scenarios).toHaveLength(2);
    expect(scenarios.every((s) => s.valid)).toBeTrue();
  });

  test("And/But continue the most recent clause", () => {
    const { scenarios } = parseGwt(
      "Given a\nAnd a2\nWhen b\nThen c\nAnd c2\nBut c3",
    );
    expect(scenarios[0]).toMatchObject({
      given: ["a", "a2"],
      when: ["b"],
      then: ["c", "c2", "c3"],
      valid: true,
    });
  });

  test("keyword matching is case-insensitive", () => {
    expect(parseGwt("GIVEN a\nwhen b\nThen c").scenarios[0]!.valid).toBeTrue();
  });

  test("a scenario missing a clause is invalid", () => {
    expect(parseGwt("Given a\nWhen b").scenarios[0]!.valid).toBeFalse();
  });

  test("clauses out of order are invalid", () => {
    expect(parseGwt("When b\nGiven a\nThen c").scenarios[0]!.valid).toBeFalse();
  });

  test("a stray non-step line invalidates the scenario", () => {
    expect(parseGwt("Given a\nplain prose\nWhen b\nThen c").scenarios[0]!.valid).toBeFalse();
  });

  test("a dangling And with no clause to continue is invalid", () => {
    expect(parseGwt("And nothing yet\nGiven a\nWhen b\nThen c").scenarios[0]!.valid).toBeFalse();
  });

  test("an empty body yields no scenarios", () => {
    expect(parseGwt("").scenarios).toEqual([]);
    expect(parseGwt("\n  \n").scenarios).toEqual([]);
  });
});
