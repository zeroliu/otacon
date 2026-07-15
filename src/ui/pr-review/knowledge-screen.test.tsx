import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { knowledgeMarkdown, newerKnowledgeMarkdown, userKnowledgeMarkdown } from "./fixtures.js";
import { KnowledgeScreen, type KnowledgeEditorState } from "./knowledge-screen.js";

let cleanup: (() => Promise<void>) | undefined;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(state: KnowledgeEditorState): Promise<{ host: HTMLElement; win: Window }> {
  const win = new Window();
  const oldDocument = (globalThis as { document?: unknown }).document;
  const oldWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { document?: unknown }).document = win.document;
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const happyHost = win.document.createElement("div");
  win.document.body.appendChild(happyHost);
  const host = happyHost as unknown as HTMLElement;
  const root: Root = createRoot(host);
  await act(async () => root.render(
    <KnowledgeScreen
      documents={{
        user: { markdown: userKnowledgeMarkdown },
        project: {
          markdown: state === "saved" ? knowledgeMarkdown : `${knowledgeMarkdown}\n- My local draft.\n`,
          baselineMarkdown: knowledgeMarkdown,
          diskMarkdown: newerKnowledgeMarkdown,
          state,
        },
      }}
    />,
  ));
  cleanup = async () => {
    await act(async () => root.unmount());
    (globalThis as { document?: unknown }).document = oldDocument;
    (globalThis as { window?: unknown }).window = oldWindow;
  };
  return { host, win };
}

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function enterText(win: Window, element: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    valueSetter?.call(element, value);
    element.dispatchEvent(new win.InputEvent("input", {
      bubbles: true,
      data: value,
      inputType: "insertText",
    }) as unknown as Event);
    element.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
  });
}

describe("KnowledgeScreen", () => {
  test("keeps local text available while resolving a disk conflict", async () => {
    const { host, win } = await mount("conflict");
    expect(host.textContent).toContain("Knowledge changed on disk");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toContain("Demonstrated concepts");
    await act(async () => findButton(host, "Keep my version").click());
    expect(host.textContent).toContain("saved");
    expect(host.textContent).not.toContain("Knowledge changed on disk");
  });

  test("makes User and Project destinations explicit and saves a dirty fixture", async () => {
    const { host } = await mount("dirty");
    expect(host.querySelector(".pr-save-state")?.textContent).toBe("● unsaved");
    expect(host.textContent).toContain("github.com/zeroliu/otacon/knowledge.md");
    await act(async () => findButton(host, "User").click());
    expect(host.textContent).toContain("~/.otacon/knowledge/user.md");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toContain("# User knowledge");
    expect(findButton(host, "Save Markdown").disabled).toBe(true);
    await act(async () => findButton(host, "Project").click());
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toContain("My local draft");
    await act(async () => findButton(host, "Save Markdown").click());
    expect(host.querySelector(".pr-save-state")?.textContent).toBe("✓ saved");
    expect(findButton(host, "Save Markdown").disabled).toBe(true);
  });

  test("preserves a daemon-backed draft across a CAS conflict and retries against the new hash", async () => {
    const win = new Window({ url: "http://localhost/knowledge?repo=zeroliu/otacon" });
    const oldDocument = (globalThis as { document?: unknown }).document;
    const oldWindow = (globalThis as { window?: unknown }).window;
    const oldElement = (globalThis as { Element?: unknown }).Element;
    const oldFetch = globalThis.fetch;
    (globalThis as { document?: unknown }).document = win.document;
    (globalThis as { window?: unknown }).window = win;
    (globalThis as { Element?: unknown }).Element = win.Element;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const writes: Array<{ scope: string; markdown: string; baseHash: string; repo?: string }> = [];
    let finishSecondSave: ((response: Response) => void) | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== "PUT") {
        const project = url.includes("scope=project");
        return Response.json({
          document: {
            scope: project ? "project" : "user",
            ...(project ? { repo: "zeroliu/otacon" } : {}),
            path: project ? "/knowledge/project.md" : "/knowledge/user.md",
            markdown: project ? knowledgeMarkdown : userKnowledgeMarkdown,
            hash: project ? "a".repeat(64) : "b".repeat(64),
          },
        });
      }

      const body = JSON.parse(String(init.body)) as { scope: string; markdown: string; baseHash: string; repo?: string };
      writes.push(body);
      if (writes.length === 1) {
        return Response.json({
          error: { code: "E_KNOWLEDGE_CONFLICT", message: "knowledge changed on disk" },
          document: {
            scope: "project",
            repo: "zeroliu/otacon",
            path: "/knowledge/project.md",
            markdown: newerKnowledgeMarkdown,
            hash: "c".repeat(64),
          },
        }, { status: 409 });
      }
      const saved = Response.json({
        document: {
          scope: "project",
          repo: "zeroliu/otacon",
          path: "/knowledge/project.md",
          markdown: body.markdown,
          hash: "d".repeat(64),
        },
      });
      if (writes.length === 2) {
        return new Promise<Response>((resolve) => {
          finishSecondSave = resolve;
        });
      }
      return saved;
    }) as unknown as typeof fetch;

    const happyHost = win.document.createElement("div");
    win.document.body.appendChild(happyHost);
    const host = happyHost as unknown as HTMLElement;
    const root: Root = createRoot(host);
    cleanup = async () => {
      await act(async () => root.unmount());
      globalThis.fetch = oldFetch;
      (globalThis as { document?: unknown }).document = oldDocument;
      (globalThis as { window?: unknown }).window = oldWindow;
      (globalThis as { Element?: unknown }).Element = oldElement;
    };
    await act(async () => root.render(<KnowledgeScreen repo="zeroliu/otacon" initialScope="project" />));
    await flush();

    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    const draft = `${textarea.value}\n- My unsaved daemon draft.\n`;
    await enterText(win, textarea, draft);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(draft);
    expect(findButton(host, "Save Markdown").disabled).toBe(false);
    await act(async () => findButton(host, "Save Markdown").click());
    await flush();

    expect(host.textContent).toContain("Knowledge changed on disk");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(draft);
    expect(host.textContent).toContain("Show newer disk version");
    expect(writes[0]).toEqual({
      scope: "project",
      repo: "zeroliu/otacon",
      markdown: draft,
      baseHash: "a".repeat(64),
    });

    await act(async () => findButton(host, "Keep my version").click());
    expect(writes[1]?.baseHash).toBe("c".repeat(64));
    expect(writes[1]?.markdown).toBe(draft);

    // A slow successful save must not erase text typed after the request began.
    const laterDraft = `${draft}- Typed while save was in flight.\n`;
    await enterText(win, host.querySelector("textarea") as HTMLTextAreaElement, laterDraft);
    await act(async () => finishSecondSave?.(Response.json({
      document: {
        scope: "project",
        repo: "zeroliu/otacon",
        path: "/knowledge/project.md",
        markdown: draft,
        hash: "d".repeat(64),
      },
    })));
    await flush();
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(laterDraft);
    expect(host.textContent).not.toContain("Knowledge changed on disk");
    expect(findButton(host, "Save Markdown").disabled).toBe(false);

    await act(async () => findButton(host, "Save Markdown").click());
    await flush();
    expect(writes[2]?.baseHash).toBe("d".repeat(64));
    expect(writes[2]?.markdown).toBe(laterDraft);
    expect(findButton(host, "Save Markdown").disabled).toBe(true);

    const unsavedBeforeSwitch = `${laterDraft}- Keep this project draft.\n`;
    await enterText(win, host.querySelector("textarea") as HTMLTextAreaElement, unsavedBeforeSwitch);
    const repoInput = host.querySelector("#knowledge-project-repo") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(repoInput), "value")?.set;
      setter?.call(repoInput, "acme/other");
      repoInput.dispatchEvent(new win.InputEvent("input", { bubbles: true }) as unknown as Event);
    });
    await act(async () => findButton(host, "Open").click());
    expect(host.textContent).toContain("Save or resolve the current Project draft");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(unsavedBeforeSwitch);
  });
});
