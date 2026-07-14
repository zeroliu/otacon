import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { knowledgeMarkdown, newerKnowledgeMarkdown, userKnowledgeMarkdown } from "./fixtures.js";
import { KnowledgeScreen, type KnowledgeEditorState } from "./knowledge-screen.js";

let cleanup: (() => Promise<void>) | undefined;

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
    expect(host.textContent).toContain("github.com/zeroliu/otacon/knowledge.md");
    await act(async () => findButton(host, "User").click());
    expect(host.textContent).toContain("~/.otacon/knowledge/user.md");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toContain("# User knowledge");
    expect(findButton(host, "Save Markdown").disabled).toBe(true);
    await act(async () => findButton(host, "Project").click());
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toContain("My local draft");
    await act(async () => findButton(host, "Save Markdown").click());
    expect(host.textContent).toContain("saved");
    expect(findButton(host, "Save Markdown").disabled).toBe(true);
  });
});
