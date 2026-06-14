import { describe, expect, test } from "bun:test";
import { COMPACT_ENTER, COMPACT_EXIT, nextCompact } from "./compact.js";

describe("nextCompact", () => {
  test("at the top the header is always expanded", () => {
    expect(nextCompact(0, false)).toBe(false);
    expect(nextCompact(0, true)).toBe(false); // re-expands even from compact
    expect(nextCompact(COMPACT_EXIT, true)).toBe(false);
  });

  test("scrolled past the enter threshold the header compacts", () => {
    expect(nextCompact(COMPACT_ENTER, false)).toBe(true);
    expect(nextCompact(COMPACT_ENTER + 500, false)).toBe(true);
  });

  test("the hysteresis band holds the current state, so a settle can't flicker", () => {
    const mid = (COMPACT_ENTER + COMPACT_EXIT) / 2;
    expect(nextCompact(mid, false)).toBe(false); // was expanded → stays
    expect(nextCompact(mid, true)).toBe(true); // was compact → stays
  });

  test("the band has real width (exit strictly below enter)", () => {
    expect(COMPACT_EXIT).toBeLessThan(COMPACT_ENTER);
  });
});
