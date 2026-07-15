import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { saveKnowledge, useReviewDetail, viewerNavigationPath } from "./api.js";

const originalFetch = globalThis.fetch;
let root: Root | undefined;
let restoreDom: (() => void) | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  restoreDom?.();
  root = undefined;
  restoreDom = undefined;
  globalThis.fetch = originalFetch;
});

function DetailProbe({ revision }: { revision: number }) {
  const detail = useReviewDetail("otc_review1", revision);
  return createElement("span", null, detail === undefined ? "waiting" : "loaded");
}

async function mountDetail(revision: number): Promise<void> {
  const win = new Window({ url: "http://localhost/" });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousElement = globalThis.Element;
  const previousAct =
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  Object.assign(globalThis, { document: win.document, window: win, Element: win.Element });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  restoreDom = () => {
    Object.assign(globalThis, {
      document: previousDocument,
      window: previousWindow,
      Element: previousElement,
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
  };
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => root?.render(createElement(DetailProbe, { revision })));
}

describe("knowledge API client", () => {
  test("PUTs the complete project CAS contract and returns the persisted document", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = { url: String(input), init };
      return Response.json({
        document: {
          scope: "project",
          repo: "acme/app",
          path: "/home/knowledge.md",
          markdown: "# Project knowledge\n",
          hash: "a".repeat(64),
        },
      });
    }) as unknown as typeof fetch;

    const result = await saveKnowledge(
      "project",
      "acme/app",
      "# Project knowledge\n",
      "b".repeat(64),
    );

    expect(request?.url).toBe("/api/knowledge");
    expect(request?.init?.method).toBe("PUT");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      scope: "project",
      repo: "acme/app",
      markdown: "# Project knowledge\n",
      baseHash: "b".repeat(64),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(String(result.document.hash)).toBe("a".repeat(64));
  });

  test("returns the current document on a stale-hash conflict", async () => {
    globalThis.fetch = (async () => Response.json({
      error: { code: "E_KNOWLEDGE_CONFLICT", message: "knowledge changed on disk" },
      document: {
        scope: "user",
        path: "/home/user.md",
        markdown: "# User knowledge\n",
        hash: "c".repeat(64),
      },
    }, { status: 409 })) as unknown as typeof fetch;

    const result = await saveKnowledge("user", undefined, "draft", "b".repeat(64));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error.code).toBe("E_KNOWLEDGE_CONFLICT");
      expect(String(result.document?.hash)).toBe("c".repeat(64));
    }
  });

  test("normalizes an unreachable daemon into a typed error", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const result = await saveKnowledge("user", undefined, "draft", "b".repeat(64));
    expect(result).toEqual({
      ok: false,
      status: 0,
      error: { code: "E_UNREACHABLE", message: "couldn't reach otacond" },
    });
  });
});

describe("viewer navigation", () => {
  test("accepts only the selected client and safe session/index paths", () => {
    expect(viewerNavigationPath("tab-a", { clientId: "tab-a", path: "/s/otc_abc123" }))
      .toBe("/s/otc_abc123");
    expect(viewerNavigationPath("tab-a", { clientId: "tab-a", path: "/" })).toBe("/");
    expect(viewerNavigationPath("tab-a", { clientId: "tab-b", path: "/s/otc_abc123" }))
      .toBeUndefined();
    expect(viewerNavigationPath("tab-a", { clientId: "tab-a", path: "/settings" }))
      .toBeUndefined();
    expect(viewerNavigationPath("tab-a", { clientId: "tab-a", path: "https://example.com" }))
      .toBeUndefined();
  });
});

describe("review detail polling", () => {
  test("does not request revision zero and starts polling once revision one exists", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({});
    }) as typeof fetch;
    await mountDetail(0);
    expect(calls).toEqual([]);
    await act(async () => root?.render(createElement(DetailProbe, { revision: 1 })));
    expect(calls).toEqual(["/api/reviews/otc_review1?revision=1"]);
  });
});
