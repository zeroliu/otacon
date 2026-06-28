import { describe, expect, test } from "bun:test";
import { BADGE_RE, badgeHtml } from "./callout.js";

describe("badgeHtml", () => {
  test("renders each known type as its label-only badge span", () => {
    expect(badgeHtml("risk")).toBe('<span class="callout-badge callout-badge-risk">Risk</span>');
    expect(badgeHtml("note")).toBe('<span class="callout-badge callout-badge-note">Note</span>');
    expect(badgeHtml("decision")).toBe(
      '<span class="callout-badge callout-badge-decision">Decision</span>',
    );
    expect(badgeHtml("assumption")).toBe(
      '<span class="callout-badge callout-badge-assumption">Assumption</span>',
    );
  });
});

describe("BADGE_RE", () => {
  test("matches a known marker, case-insensitively", () => {
    expect(BADGE_RE.test("[!risk]")).toBeTrue();
    expect(BADGE_RE.test("[!RISK]")).toBeTrue();
    expect(BADGE_RE.test("[!Assumption] body")).toBeTrue();
  });

  test("the capture group names the lowercased type", () => {
    expect(BADGE_RE.exec("[!NOTE] x")![1]!.toLowerCase()).toBe("note");
  });

  test("does not match an unknown type", () => {
    expect(BADGE_RE.test("[!warning]")).toBeFalse();
  });
});
