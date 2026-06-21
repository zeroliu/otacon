import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { adjacentSession, isTypingTarget } from "./session-nav.js";

describe("adjacentSession", () => {
  test("steps forward to the next id", () => {
    expect(adjacentSession(["a", "b", "c"], "b", 1)).toBe("c");
  });

  test("wraps forward off the end back to the first", () => {
    expect(adjacentSession(["a", "b", "c"], "c", 1)).toBe("a");
  });

  test("wraps backward off the front to the last", () => {
    expect(adjacentSession(["a", "b", "c"], "a", -1)).toBe("c");
  });

  test("steps backward to the previous id", () => {
    expect(adjacentSession(["a", "b", "c"], "b", -1)).toBe("a");
  });

  test("a single-session list never navigates (either direction)", () => {
    expect(adjacentSession(["a"], "a", 1)).toBe(null);
    expect(adjacentSession(["a"], "a", -1)).toBe(null);
  });

  test("an empty list never navigates", () => {
    expect(adjacentSession([], "a", 1)).toBe(null);
  });

  test("a current id not in the list never navigates", () => {
    expect(adjacentSession(["a", "b"], "z", 1)).toBe(null);
  });
});

describe("isTypingTarget", () => {
  // happy-dom gives real elements with tagName + contentEditable semantics.
  const doc = new Window().document;
  const el = (tag: string) => doc.createElement(tag) as unknown as EventTarget;

  test("an <input> is a typing target", () => {
    expect(isTypingTarget(el("input"))).toBe(true);
  });

  test("a <textarea> is a typing target", () => {
    expect(isTypingTarget(el("textarea"))).toBe(true);
  });

  test("a <select> is a typing target", () => {
    expect(isTypingTarget(el("select"))).toBe(true);
  });

  test("a contentEditable element (attribute) is a typing target", () => {
    const div = doc.createElement("div");
    div.setAttribute("contenteditable", "");
    expect(isTypingTarget(div as unknown as EventTarget)).toBe(true);
  });

  test("a contentEditable element (isContentEditable) is a typing target", () => {
    const div = doc.createElement("div");
    div.contentEditable = "true";
    expect(isTypingTarget(div as unknown as EventTarget)).toBe(true);
  });

  test("contenteditable=\"false\" is not a typing target", () => {
    const div = doc.createElement("div");
    div.setAttribute("contenteditable", "false");
    expect(isTypingTarget(div as unknown as EventTarget)).toBe(false);
  });

  test("a plain <div> is not a typing target", () => {
    expect(isTypingTarget(el("div"))).toBe(false);
  });

  test("null is not a typing target", () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});
