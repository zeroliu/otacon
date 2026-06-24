import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { Portal } from "./portal.js";

/** Mount the Portal into a happy-dom DOM and assert where its children land.
 *  react-dom/client + createPortal read the global document/window, so we point
 *  them at happy-dom for the duration of the test (like rail.test.tsx does). */
describe("Portal", () => {
  test("renders its children under document.body, not at the caller's mount point", async () => {
    const win = new Window();
    const prevDocument = (globalThis as { document?: unknown }).document;
    const prevWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { document?: unknown }).document = win.document;
    (globalThis as { window?: unknown }).window = win;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    try {
      // The caller's mount point sits inside a nested host (it stands in for the
      // sticky sidebar that would otherwise trap an inline overlay).
      const host = win.document.createElement("div");
      host.className = "caller-mount";
      win.document.body.appendChild(host);
      const root = createRoot(host as unknown as Element);
      await act(async () => {
        root.render(
          createElement(
            Portal,
            null,
            createElement("div", { className: "portal-child", "data-flag": "lifted" }, "hi"),
          ),
        );
      });

      // The portaled child lands under body but NOT under the caller's mount node:
      // the content escaped the host's subtree entirely. A `querySelector` from
      // each root proves the parentage without leaning on cross-realm `contains`.
      const child = win.document.body.querySelector(".portal-child");
      expect(child).not.toBeNull();
      expect(child?.textContent).toBe("hi");
      // Found from body, missing from the host: it is body's descendant, not host's.
      expect(host.querySelector(".portal-child")).toBeNull();
      // The host stayed empty (React mounted nothing into the caller's node).
      expect(host.childNodes.length).toBe(0);

      await act(async () => {
        root.unmount();
      });
      // Unmount cleans the portaled node back out of body.
      expect(win.document.body.querySelector(".portal-child")).toBeNull();
    } finally {
      (globalThis as { document?: unknown }).document = prevDocument;
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  });
});
