import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createElement } from "react";
import { PromptCard } from "./prompt-card.js";

/** Render the card to static markup; the toggle starts collapsed (default state). */
function render(prompt?: string): string {
  return renderToStaticMarkup(createElement(PromptCard, { prompt }));
}

describe("PromptCard collapsed default", () => {
  test("renders the label and a one-line preview of the request", () => {
    const html = render("Add a dark-mode toggle to the settings pane");
    expect(html).toContain("prompt-word"); // the eyebrow label
    expect(html).toContain("prompt-preview");
    expect(html).toContain("Add a dark-mode toggle");
    // Collapsed: the full-text body is not mounted yet.
    expect(html).not.toContain("prompt-body");
  });

  test("the toggle reports collapsed via aria-expanded", () => {
    expect(render("anything")).toContain('aria-expanded="false"');
  });
});

describe("PromptCard hidden when absent", () => {
  test("renders nothing when the prompt is undefined", () => {
    expect(render(undefined)).toBe("");
  });

  test("renders nothing when the prompt is empty or whitespace-only", () => {
    expect(render("")).toBe("");
    expect(render("   \n  ")).toBe("");
  });
});

describe("PromptCard expand on click", () => {
  test("clicking the toggle reveals the full request body", async () => {
    // Mount into a happy-dom DOM and click the header, asserting the collapsed
    // preview gives way to the full pre-wrap body (mirrors rail.test.tsx).
    const win = new Window();
    const prevDocument = (globalThis as { document?: unknown }).document;
    const prevWindow = (globalThis as { window?: unknown }).window;
    // react-dom/client reads the global document/window; point them at happy-dom.
    (globalThis as { document?: unknown }).document = win.document;
    (globalThis as { window?: unknown }).window = win;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const full = "line one\nline two";
    try {
      const host = win.document.createElement("div");
      win.document.body.appendChild(host);
      const root = createRoot(host as unknown as Element);
      await act(async () => {
        root.render(createElement(PromptCard, { prompt: full }));
      });
      // Collapsed first: preview present, body absent.
      expect(host.querySelector(".prompt-preview")).not.toBeNull();
      expect(host.querySelector(".prompt-body")).toBeNull();
      const btn = host.querySelector(".prompt-toggle") as unknown as HTMLElement | null;
      expect(btn).not.toBeNull();
      await act(async () => {
        btn?.click();
      });
      // Expanded: the full body is mounted with the verbatim multi-line text.
      const body = host.querySelector(".prompt-body") as unknown as HTMLElement | null;
      expect(body).not.toBeNull();
      expect(body?.textContent).toBe(full);
      expect(btn?.getAttribute("aria-expanded")).toBe("true");
      await act(async () => {
        root.unmount();
      });
    } finally {
      (globalThis as { document?: unknown }).document = prevDocument;
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  });
});
