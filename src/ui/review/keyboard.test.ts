import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { keyboardInset, lockScroll } from "./keyboard.js";

describe("keyboardInset", () => {
  test("no visualViewport (desktop / unsupported) is no inset", () => {
    expect(keyboardInset(800, null)).toBe(0);
  });

  test("visual viewport filling the layout is no keyboard", () => {
    expect(keyboardInset(800, { height: 800, offsetTop: 0 })).toBe(0);
  });

  test("a shrunken visual viewport is the keyboard height", () => {
    expect(keyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
  });

  test("offsetTop (pinch-zoom pan) is subtracted from the gap", () => {
    expect(keyboardInset(800, { height: 500, offsetTop: 50 })).toBe(250);
  });

  test("a taller visual viewport (pulled-down URL bar) clamps to 0, never negative", () => {
    expect(keyboardInset(800, { height: 860, offsetTop: 0 })).toBe(0);
  });
});

describe("lockScroll", () => {
  // happy-dom gives a real CSSStyleDeclaration to read styles back off the body.
  function body(): HTMLElement {
    return new Window().document.body as unknown as HTMLElement;
  }

  test("pins the body fixed, shifted up by the scroll offset", () => {
    const el = body();
    lockScroll(el, 120);
    expect(el.style.position).toBe("fixed");
    expect(el.style.top).toBe("-120px");
    expect(el.style.overflow).toBe("hidden");
    expect(el.style.width).toBe("100%");
  });

  test("the restore thunk reverts every touched style to its prior value", () => {
    const el = body();
    const restore = lockScroll(el, 64);
    restore();
    expect(el.style.position).toBe("");
    expect(el.style.top).toBe("");
    expect(el.style.left).toBe("");
    expect(el.style.right).toBe("");
    expect(el.style.width).toBe("");
    expect(el.style.overflow).toBe("");
  });

  test("preserves pre-existing inline styles across a lock/unlock cycle", () => {
    const el = body();
    el.style.overflow = "auto";
    el.style.position = "relative";
    const restore = lockScroll(el, 0);
    expect(el.style.overflow).toBe("hidden"); // locked over the prior value
    restore();
    expect(el.style.overflow).toBe("auto"); // and handed back, not blanked
    expect(el.style.position).toBe("relative");
  });

  test("re-locking after a restore works (toggle reuse)", () => {
    const el = body();
    lockScroll(el, 10)();
    lockScroll(el, 30);
    expect(el.style.top).toBe("-30px");
  });
});
