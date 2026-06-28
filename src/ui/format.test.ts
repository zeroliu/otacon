// Pins the format helpers the header and cards lean on. `prNumber` parses the
// "#N" label off a GitHub PR URL for the header badge (Phase 4): a real
// `/pull/<digits>` segment yields "#N", anything else yields undefined.

import { describe, expect, test } from "bun:test";
import { prNumber } from "./format";

describe("prNumber", () => {
  test("parses a single-digit PR number", () => {
    expect(prNumber("https://github.com/owner/repo/pull/4")).toBe("#4");
  });

  test("parses a multi-digit PR number", () => {
    expect(prNumber("https://github.com/owner/repo/pull/12345")).toBe("#12345");
  });

  test("undefined when the URL has no /pull/ segment", () => {
    expect(prNumber("https://github.com/owner/repo/issues/40")).toBeUndefined();
  });

  test("undefined when /pull/ carries no trailing digits", () => {
    expect(prNumber("https://github.com/owner/repo/pull/")).toBeUndefined();
  });
});
