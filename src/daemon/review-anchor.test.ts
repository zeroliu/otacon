import { describe, expect, test } from "bun:test";
import { reportContainsAnchorQuote } from "./review-anchor.js";

const REPORT = [
  "---",
  "type: otacon-pr-review",
  "---",
  "",
  "## Background",
  "",
  "Plain prose stays byte-identical after rendering.",
  "",
  "The `key` field is **never** rewritten when the head moves, and",
  "[the registry](https://example.com) keeps one entry per canonical PR.",
  "",
  "## Code",
  "",
  "### Interface changes — Identity",
  "",
  "- first item mentions `parsePullRequestMetadata`",
  "- second item mentions `reviewIsReadOnly`",
  "",
  "> quoted advice line",
  "",
  "```ts",
  "export interface PullRequestIdentity {",
  "  key: `github.com/${string}#${number}`;",
  "}",
  "```",
].join("\n");

describe("reportContainsAnchorQuote", () => {
  test("byte-identical prose matches without projection", () => {
    expect(reportContainsAnchorQuote(REPORT, "Plain prose stays byte-identical after rendering.")).toBe(true);
  });

  test("rendered inline code and bold match their source", () => {
    // Range#toString() of the rendered paragraph: no backticks, no asterisks.
    expect(reportContainsAnchorQuote(REPORT, "The key field is never rewritten when the head moves")).toBe(true);
  });

  test("rendered link text matches its markdown link", () => {
    expect(reportContainsAnchorQuote(REPORT, "the registry keeps one entry per canonical PR.")).toBe(true);
  });

  test("selection spanning list items matches despite markers and newlines", () => {
    expect(
      reportContainsAnchorQuote(
        REPORT,
        "first item mentions parsePullRequestMetadata\nsecond item mentions reviewIsReadOnly",
      ),
    ).toBe(true);
  });

  test("heading text matches without hash markers", () => {
    expect(reportContainsAnchorQuote(REPORT, "Interface changes — Identity")).toBe(true);
  });

  test("blockquote text matches without the > marker", () => {
    expect(reportContainsAnchorQuote(REPORT, "quoted advice line")).toBe(true);
  });

  test("code fence content matches without the fence delimiters", () => {
    expect(reportContainsAnchorQuote(REPORT, "export interface PullRequestIdentity {")).toBe(true);
  });

  test("a quote from another document is refused", () => {
    expect(reportContainsAnchorQuote(REPORT, "this sentence exists in no revision")).toBe(false);
  });

  test("a quote that is only markdown syntax is refused", () => {
    expect(reportContainsAnchorQuote(REPORT, "**`")).toBe(false);
  });

  test("empty and whitespace quotes are refused", () => {
    expect(reportContainsAnchorQuote(REPORT, "   ")).toBe(false);
  });
});
