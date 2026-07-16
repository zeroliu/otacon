import { describe, expect, test } from "bun:test";
import { composerPlacement, SHEET_VIEWPORT } from "./feedback.js";

// The tuned plan-review placement both review surfaces share. Pure math —
// the rect is a CapturedSelection["rect"], the viewport is passed in.
describe("composerPlacement", () => {
  const desktop = { width: 1024, height: 768 };

  test("pins centered under a selection with room below (+12px gap)", () => {
    const at = composerPlacement({ top: 120, bottom: 142, left: 260, width: 220 }, desktop);
    expect(at).toEqual({ x: 370, y: 154 });
  });

  test("flips above a selection whose card would overflow the fold", () => {
    // 720 + 12 + 240 > 768 → above: 700 - 240 - 12.
    const at = composerPlacement({ top: 700, bottom: 720, left: 260, width: 220 }, desktop);
    expect(at?.y).toBe(448);
  });

  test("the flipped pin never leaves the top gutter", () => {
    // A tall selection near the top of a short viewport: flipping above would
    // go negative, so the pin floors at the 12px gutter.
    const at = composerPlacement(
      { top: 40, bottom: 380, left: 260, width: 220 },
      { width: 1024, height: 400 },
    );
    expect(at?.y).toBe(12);
  });

  test("clamps the pin a gutter inside the left and right edges", () => {
    // Half the 380px card plus the 12px gutter = 202.
    const left = composerPlacement({ top: 120, bottom: 142, left: 0, width: 10 }, desktop);
    expect(left?.x).toBe(202);
    const right = composerPlacement({ top: 120, bottom: 142, left: 1014, width: 10 }, desktop);
    expect(right?.x).toBe(1024 - 202);
  });

  test("the narrowest popover viewport still fits the full-width card's clamp", () => {
    // Every viewport ≥ SHEET_VIEWPORT (640) fits the 380px card plus gutters,
    // so the edge clamp is always the full card's 202 — the CSS width shrink
    // (min(380px, 100vw - 24px)) only ever engages on sheet-mode phones.
    const at = composerPlacement({ top: 120, bottom: 142, left: 0, width: 4 }, {
      width: SHEET_VIEWPORT,
      height: 768,
    });
    expect(at?.x).toBe(202);
  });

  test("below SHEET_VIEWPORT the composer is a bottom sheet (null)", () => {
    const rect = { top: 120, bottom: 142, left: 60, width: 120 };
    expect(composerPlacement(rect, { width: SHEET_VIEWPORT - 1, height: 800 })).toBeNull();
    expect(composerPlacement(rect, { width: SHEET_VIEWPORT, height: 800 })).not.toBeNull();
  });

  test("a zero-width rect (the section ⋯ menu's synthetic anchor) pins under its point", () => {
    const at = composerPlacement({ top: 300, bottom: 300, left: 500, width: 0 }, desktop);
    expect(at).toEqual({ x: 500, y: 312 });
  });
});
