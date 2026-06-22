import { describe, expect, test } from "bun:test";
import { isDesktopWidth, shouldCloseSheet, SIDEBAR_VIEWPORT } from "./session-sheet-state.js";

describe("isDesktopWidth", () => {
  test("at and above the breakpoint the sidebar is the list", () => {
    expect(isDesktopWidth(SIDEBAR_VIEWPORT)).toBe(true);
    expect(isDesktopWidth(SIDEBAR_VIEWPORT + 400)).toBe(true);
  });

  test("below the breakpoint the sheet is the face", () => {
    expect(isDesktopWidth(SIDEBAR_VIEWPORT - 1)).toBe(false);
    expect(isDesktopWidth(390)).toBe(false);
  });
});

describe("shouldCloseSheet", () => {
  test("a closed sheet stays closed regardless of the rest", () => {
    expect(shouldCloseSheet(false, "/", "/s/abc", false)).toBe(false);
    expect(shouldCloseSheet(false, "/", "/", true)).toBe(false);
  });

  test("an open sheet stays open while the route holds on a phone width", () => {
    expect(shouldCloseSheet(true, "/s/abc", "/s/abc", false)).toBe(false);
    expect(shouldCloseSheet(true, "/", "/", false)).toBe(false);
  });

  test("a route change under an open sheet closes it (row tap / back-forward)", () => {
    expect(shouldCloseSheet(true, "/", "/s/abc", false)).toBe(true);
    expect(shouldCloseSheet(true, "/s/abc", "/s/def", false)).toBe(true);
    expect(shouldCloseSheet(true, "/s/abc", "/settings", false)).toBe(true);
  });

  test("crossing up to the desktop width closes it even when the route is unchanged", () => {
    expect(shouldCloseSheet(true, "/s/abc", "/s/abc", true)).toBe(true);
    expect(shouldCloseSheet(true, "/", "/", true)).toBe(true);
  });
});
