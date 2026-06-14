import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { clearThreadHighlights, type LitThread, locateAnchor, paintThreads } from "./anchor.js";

// anchor.ts re-locates quotes over a real DOM (TreeWalker, Range, querySelector)
// and reads `NodeFilter`/`CSS` as browser globals. bun ships no DOM, so we wire
// happy-dom's. The Custom Highlight API (`Highlight`, `CSS.highlights`) is *not*
// in happy-dom — which is exactly the graceful-degradation path paintThreads
// must survive, so we assert it no-ops here rather than the registration itself
// (that is exercised by the Playwright e2e against a real browser).
let win: Window;
const g = globalThis as Record<string, unknown>;
const saved = { CSS: g.CSS, NodeFilter: g.NodeFilter };

beforeAll(() => {
  win = new Window();
  g.CSS = (win as unknown as { CSS: unknown }).CSS;
  g.NodeFilter = (win as unknown as { NodeFilter: unknown }).NodeFilter;
});

afterAll(() => {
  g.CSS = saved.CSS;
  g.NodeFilter = saved.NodeFilter;
});

/** A detached <main> standing in for the plan container. */
function container(html: string): HTMLElement {
  const doc = win.document as unknown as Document;
  const main = doc.createElement("main");
  main.innerHTML = html;
  return main as unknown as HTMLElement;
}

describe("locateAnchor", () => {
  test("re-locates an exact quote as a Range over the section text", () => {
    const root = container(`<section id="phase-1"><p>Issue tokens with RS256 keys.</p></section>`);
    const range = locateAnchor(root, { section: "phase-1", exact: "RS256 keys" });
    expect(range?.toString()).toBe("RS256 keys");
  });

  test("re-locates a quote spanning inline element boundaries", () => {
    const root = container(`<section id="s"><p>make it <em>brave</em> and bold</p></section>`);
    const range = locateAnchor(root, { section: "s", exact: "brave and bold" });
    expect(range?.toString()).toBe("brave and bold");
  });

  test("prefix disambiguates between repeated quotes", () => {
    const root = container(`<section id="s"><p>alpha world beta</p><p>gamma world delta</p></section>`);
    const range = locateAnchor(root, { section: "s", exact: "world", prefix: "gamma " });
    expect(range?.toString()).toBe("world");
    expect(range?.startContainer.textContent).toContain("gamma");
  });

  test("without a prefix the first occurrence wins", () => {
    const root = container(`<section id="s"><p>alpha world beta</p><p>gamma world delta</p></section>`);
    const range = locateAnchor(root, { section: "s", exact: "world" });
    expect(range?.startContainer.textContent).toContain("alpha");
  });

  test("a quote that no longer exists does not re-locate (orphaned)", () => {
    const root = container(`<section id="phase-1"><p>only this text</p></section>`);
    expect(locateAnchor(root, { section: "phase-1", exact: "vanished quote" })).toBeNull();
  });

  test("a whole-plan anchor (no exact) never locates", () => {
    const root = container(`<section id="phase-1"><p>body</p></section>`);
    expect(locateAnchor(root, { section: "phase-1" })).toBeNull();
  });

  test("an empty quote never locates (no indexOf('') match at the start)", () => {
    const root = container(`<section id="phase-1"><p>body</p></section>`);
    expect(locateAnchor(root, { section: "phase-1", exact: "" })).toBeNull();
  });

  test("a missing section never locates", () => {
    const root = container(`<section id="phase-1"><p>body</p></section>`);
    expect(locateAnchor(root, { section: "gone", exact: "body" })).toBeNull();
  });
});

describe("paintThreads / clearThreadHighlights without the Custom Highlight API", () => {
  test("are safe no-ops when Highlight is unavailable", () => {
    const root = container(`<section id="s"><p>lit me up</p></section>`);
    const lit: LitThread[] = [
      { id: "t1", anchor: { section: "s", exact: "lit me" }, kind: "comment" },
      { id: "q1", anchor: { section: "s", exact: "up" }, kind: "question" },
    ];
    expect(() => paintThreads(root, lit)).not.toThrow();
    expect(() => clearThreadHighlights()).not.toThrow();
  });
});
