import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { CapturedSelection } from "../review/anchor.js";
import { balancedFixture } from "./fixtures.js";
import { MemoryReviewAdapter } from "./model.js";
import { PrReviewScreen } from "./pr-review-screen.js";

interface Mounted {
  win: Window;
  host: HTMLElement;
  root: Root;
  adapter: MemoryReviewAdapter;
  restore: () => void;
}

let mounted: Mounted | undefined;

async function mountReview(
  gradingDelayMs = 1,
  selectionOverride?: CapturedSelection,
): Promise<Mounted> {
  const win = new Window({ url: "http://localhost/" });
  const previousDocument = (globalThis as { document?: unknown }).document;
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousElement = (globalThis as { Element?: unknown }).Element;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  (globalThis as { document?: unknown }).document = win.document;
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { Element?: unknown }).Element = win.Element;
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win) as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win) as unknown as typeof cancelAnimationFrame;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const happyHost = win.document.createElement("div");
  win.document.body.appendChild(happyHost);
  const host = happyHost as unknown as HTMLElement;
  const root = createRoot(host);
  const adapter = new MemoryReviewAdapter(balancedFixture, gradingDelayMs);
  await act(async () => root.render(
    <PrReviewScreen adapter={adapter} selectionOverride={selectionOverride} />,
  ));
  mounted = {
    win,
    host,
    root,
    adapter,
    restore: () => {
      (globalThis as { document?: unknown }).document = previousDocument;
      (globalThis as { window?: unknown }).window = previousWindow;
      (globalThis as { Element?: unknown }).Element = previousElement;
      globalThis.requestAnimationFrame = previousRequestAnimationFrame;
      globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
  return mounted;
}

afterEach(async () => {
  if (mounted === undefined) return;
  await act(async () => mounted?.root.unmount());
  mounted.restore();
  mounted = undefined;
});

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (found === undefined) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
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

async function wait(milliseconds: number): Promise<void> {
  await act(async () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)));
}

function textNodeContaining(root: Node, text: string): Text {
  const pending = [...root.childNodes];
  while (pending.length > 0) {
    const node = pending.shift() as Node;
    if (node.nodeType === 3 && node.textContent?.includes(text)) return node as Text;
    pending.unshift(...node.childNodes);
  }
  throw new Error(`text not found: ${text}`);
}

async function selectText(
  win: Window,
  root: HTMLElement,
  text: string,
  rect = { top: 120, bottom: 142, left: 260, width: 220 },
): Promise<void> {
  const node = textNodeContaining(root, text);
  const start = node.textContent?.indexOf(text) ?? -1;
  const range = win.document.createRange();
  range.setStart(node as never, start);
  range.setEnd(node as never, start + text.length);
  Object.defineProperty(range, "getBoundingClientRect", { value: () => rect });
  const selection = win.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await act(async () => {
    win.document.dispatchEvent(new win.Event("selectionchange"));
    await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
  });
}

describe("PrReviewScreen", () => {
  test("keeps Plans and Reviews inside the existing collapsible app sidebar hierarchy", async () => {
    const { host, win } = await mountReview();
    const sidebar = host.querySelector("aside.app-sidebar") as HTMLElement | null;
    expect(sidebar).not.toBeNull();
    expect(sidebar?.firstElementChild?.classList.contains("app-sidebar-head")).toBe(true);
    expect(sidebar?.querySelector(".app-sidebar-head [aria-label='settings']")).not.toBeNull();
    expect(sidebar?.querySelector(".app-sidebar-head [aria-label='collapse sidebar']")).not.toBeNull();
    const sidebarChildren = [...(sidebar?.children ?? [])];
    expect(sidebarChildren.indexOf(sidebar?.querySelector(".pr-sidebar-switch") as Element)).toBeLessThan(
      sidebarChildren.indexOf(sidebar?.querySelector(".pr-side-list") as Element),
    );
    expect(sidebar?.querySelectorAll(".pr-side-list > .sl-row")).toHaveLength(2);
    expect(sidebar?.querySelector(".pr-side-list > .sl-row .sl-text")).not.toBeNull();
    await click(button(sidebar as HTMLElement, "Plans"));
    expect(sidebar?.querySelectorAll(".pr-side-list > .sl-row")).toHaveLength(1);
    expect(sidebar?.querySelector(".pr-side-list > .sl-row .sl-text")).not.toBeNull();
    const openPrGroup = sidebar?.querySelector(".sl-group") as HTMLElement;
    const openPrToggle = openPrGroup.querySelector(".sl-group-toggle") as HTMLButtonElement;
    expect(openPrGroup.getAttribute("aria-label")).toBe("Open PR sessions (1)");
    expect(openPrToggle.getAttribute("aria-expanded")).toBe("true");
    expect(openPrGroup.querySelectorAll(".sl-group-rows .sl-row")).toHaveLength(1);
    await click(openPrToggle);
    expect(openPrGroup.querySelector(".sl-group-rows")).toBeNull();
    await click(openPrToggle);
    expect(openPrGroup.querySelectorAll(".sl-group-rows .sl-row")).toHaveLength(1);
    await click(button(sidebar as HTMLElement, "Reviews"));
    expect(host.querySelector("aside.pr-sidebar")).toBeNull();

    await click(button(sidebar as HTMLElement, "«"));
    expect(host.querySelector(".pr-review-app")?.classList.contains("collapsed")).toBe(true);
    await click(button(host, "»"));
    expect(host.querySelector(".pr-review-app")?.classList.contains("collapsed")).toBe(false);
    expect(host.querySelector(".pr-review-app")?.classList.contains("is-mobile-nav-open")).toBe(false);

    Object.defineProperty(win, "innerWidth", { value: 520, configurable: true });
    await click(button(sidebar as HTMLElement, "«"));
    await click(button(host, "»"));
    expect(host.querySelector(".pr-review-app")?.classList.contains("is-mobile-nav-open")).toBe(true);
    expect(sidebar?.getAttribute("role")).toBe("dialog");
    expect(sidebar?.getAttribute("aria-modal")).toBe("true");
    expect(host.ownerDocument.activeElement?.getAttribute("aria-label")).toBe("collapse sidebar");

    Object.defineProperty(win, "innerWidth", { value: 960, configurable: true });
    await act(async () => {
      win.dispatchEvent(new win.Event("resize"));
    });
    await wait(1);
    expect(host.querySelector(".pr-review-app")?.classList.contains("is-mobile-nav-open")).toBe(false);
    expect(host.ownerDocument.activeElement?.getAttribute("aria-label")).toBe("collapse sidebar");

    Object.defineProperty(win, "innerWidth", { value: 520, configurable: true });
    await click(button(host, "»"));
    await click(host.querySelector("[aria-label='close session navigation']") as HTMLButtonElement);
    await wait(1);
    expect(host.ownerDocument.activeElement?.getAttribute("aria-label")).toBe("show sessions");

    await click(button(host, "»"));
    await act(async () => host.ownerDocument.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event,
    ));
    await wait(1);
    expect(host.querySelector(".pr-review-app")?.classList.contains("is-mobile-nav-open")).toBe(false);
    expect(sidebar?.getAttribute("role")).toBeNull();
    expect(host.ownerDocument.activeElement?.getAttribute("aria-label")).toBe("show sessions");
  });

  test("orders Code as interface changes, integration path, then implementation walkthrough", async () => {
    const { host } = await mountReview();
    expect([...host.querySelectorAll("#code > .pr-code-layer > h3")].map((heading) => heading.textContent)).toEqual([
      "Interface changes",
      "Integration path",
      "Implementation walkthrough",
    ]);
    expect([...host.querySelectorAll(".pr-toc a.nested")].map((link) => [
      link.textContent,
      link.getAttribute("href"),
    ])).toEqual([
      ["Interface changes", "#code-interfaces"],
      ["Integration path", "#code-integration"],
      ["Implementation walkthrough", "#code-walkthrough"],
    ]);

    const changedFunction = host.querySelector('[data-interface-id="interface-begin-revision"]') as HTMLElement;
    expect(changedFunction.querySelector(".pr-contract-status")?.textContent).toBe("changed");
    expect(changedFunction.querySelector(".pr-contract-kind")?.textContent).toBe("function signature");
    expect(changedFunction.getAttribute("data-contract-status")).toBe("changed");
    expect(changedFunction.querySelectorAll(".pr-contract-excerpt")).toHaveLength(2);
    expect([...changedFunction.querySelectorAll(".pr-contract-excerpt")].map((excerpt) => [
      excerpt.getAttribute("data-state"),
      excerpt.querySelector(":scope > span")?.textContent,
    ])).toEqual([["before", "before"], ["after", "after"]]);
    expect(changedFunction.querySelector(".pr-contract-delta")?.getAttribute("role")).toBe("group");

    const path = [...host.querySelectorAll(".pr-integration-path > li")];
    expect(path.map((step) => step.getAttribute("data-integration-id"))).toEqual([
      "integration-start",
      "integration-capture",
      "integration-begin",
      "integration-submit",
      "integration-grade",
    ]);
    expect(path.map((step) => step.querySelector("h4")?.textContent)).toEqual([
      "src/cli/commands/review.ts#start",
      "src/daemon/knowledge-store.ts#capture",
      "src/daemon/review-store.ts#beginRevision",
      "src/cli/commands/review.ts#submit",
      "src/daemon/quiz-grader.ts#recordGrade",
    ]);
    expect(path[2]?.textContent).toContain("ReviewRevision { id, headSha, snapshotId }");
    const trace = host.querySelector(".pr-integration-trace") as HTMLElement;
    expect(trace.querySelector("h4")?.textContent).toBe("Quick boundary trace");
    expect(trace.textContent).toContain("knowledgeStore.capture(repositoryKey)");
    expect(trace.textContent).toContain("snapshotId: revision.snapshotId");
    expect(trace.textContent).toContain("quizGrader.recordGrade");
    const pathList = host.querySelector(".pr-integration-path") as HTMLElement;
    expect(pathList.getAttribute("aria-labelledby")).toBe("code-integration-details-title");
    expect(trace.compareDocumentPosition(pathList) & 4).toBe(4);
    expect(trace.compareDocumentPosition(host.querySelector("#code-walkthrough") as Node) & 4).toBe(4);
    expect(host.querySelector(".pr-surfaces code")?.textContent).toContain("#capture");
  });

  test("grades an incomplete open answer, explains the retry, then records a pass", async () => {
    const { host, win } = await mountReview(40);
    const card = host.querySelector('[data-quiz-id="q1"]') as HTMLElement;
    const answer = card.querySelector("textarea") as HTMLTextAreaElement;
    await enterText(win, answer, "It keeps a snapshot.");
    await click(button(card, "Check answer"));
    expect(card?.textContent).toContain("agent grading");
    await wait(45);
    expect(card?.textContent).toContain("Not quite");
    expect(card?.textContent).toContain("report revision");

    const retryAnswer = card.querySelector("textarea") as HTMLTextAreaElement;
    await enterText(win, retryAnswer, "The snapshot keeps the current report revision stable while knowledge changes.");
    await click(button(card, "Retry answer"));
    await wait(45);
    expect(card?.textContent).toContain("Correct");
    expect(card?.textContent).toContain("added to Project knowledge");
  });

  test("turns selected report text into Ask or Comment threads, then escalates only from a Comment thread", async () => {
    const selection: CapturedSelection = {
      anchor: {
        section: "background",
        exact: "Without a boundary, the report could become a moving target.",
      },
      rect: { top: 120, bottom: 142, left: 260, width: 220 },
    };
    const { host, win, adapter } = await mountReview(1, selection);
    expect(host.querySelector(".pr-selection")).toBeNull();
    const toolbar = host.querySelector('[role="toolbar"][aria-label="selection actions"]') as HTMLElement;
    expect(toolbar).not.toBeNull();
    expect(toolbar.textContent).not.toContain("Code change");
    await click(button(toolbar, "commentc"));
    const composer = host.querySelector('[role="dialog"][aria-label="comment composer"]') as HTMLElement;

    const remember = composer.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await click(remember);
    await click(button(composer, "User"));
    expect(button(composer, "User").getAttribute("aria-pressed")).toBe("true");
    await enterText(
      win,
      composer.querySelector("textarea") as HTMLTextAreaElement,
      "Explain why these writes stay separate.",
    );
    await click(button(composer, "Comment"));
    await wait(1);

    expect(adapter.getSnapshot().threads.at(-1)?.id).toBe("t4");
    const newest = host.querySelector('[data-thread-id="t4"]');
    expect(newest?.textContent).toContain("Comment");
    expect(newest?.textContent).toContain("Explain why these writes stay separate.");
    expect(newest?.textContent).toContain("Remembered in User knowledge");
    expect(newest?.textContent).toContain("Conduct code change");

    await click(button(newest as HTMLElement, "Conduct code change"));
    await wait(1);
    expect(newest?.textContent).toContain("change requested");
    expect(newest?.textContent).toContain("Worktree handoff requested");

    const codeToolbar = host.querySelector('[role="toolbar"][aria-label="selection actions"]') as HTMLElement;
    await click(button(codeToolbar, "askq"));
    const askComposer = host.querySelector('[role="dialog"][aria-label="question composer"]') as HTMLElement;
    await enterText(win, askComposer.querySelector("textarea") as HTMLTextAreaElement, "Why is this type the boundary?");
    await click(button(askComposer, "ask now"));
    await wait(1);
    const question = host.querySelector('[data-thread-id="t5"]');
    expect(question?.textContent).toContain("Question");
    expect(question?.textContent).toContain("Without a boundary");
  });

  test("captures real report prose and code-fence selections with the shared Ask and Comment composer", async () => {
    const { host, win, adapter } = await mountReview();
    const background = host.querySelector("#background") as HTMLElement;
    await selectText(win, background, "moving target");

    let toolbar = host.querySelector('[role="toolbar"][aria-label="selection actions"]') as HTMLElement;
    await click(button(toolbar, "askq"));
    let composer = host.querySelector('[role="dialog"][aria-label="question composer"]') as HTMLElement;
    expect(composer.querySelector("blockquote")?.textContent).toBe("moving target");
    await enterText(win, composer.querySelector("textarea") as HTMLTextAreaElement, "What makes it move?");
    await click(button(composer, "ask now"));
    await wait(1);
    expect(adapter.getSnapshot().threads.at(-1)).toMatchObject({
      intent: "question",
      anchor: "moving target",
    });
    expect(host.querySelector('[data-thread-id="t4"] .pr-conduct-change')).toBeNull();

    const codeFence = host.querySelector(".pr-integration-trace code") as HTMLElement;
    await selectText(win, codeFence, "knowledgeStore", { top: 420, bottom: 442, left: 310, width: 128 });
    toolbar = host.querySelector('[role="toolbar"][aria-label="selection actions"]') as HTMLElement;
    await click(button(toolbar, "commentc"));
    composer = host.querySelector('[role="dialog"][aria-label="comment composer"]') as HTMLElement;
    expect(composer.querySelector("blockquote")?.textContent).toBe("knowledgeStore");
    await enterText(win, composer.querySelector("textarea") as HTMLTextAreaElement, "Keep this boundary explicit.");
    await click(button(composer, "Comment"));
    await wait(1);
    expect(adapter.getSnapshot().threads.at(-1)).toMatchObject({
      intent: "comment",
      anchor: "knowledgeStore",
      status: "open",
    });
    expect(host.querySelector('[data-thread-id="t5"] .pr-conduct-change')).not.toBeNull();
  });

  test("warns with unresolved thread and quiz counts, then preserves a force-closed report", async () => {
    const { host, adapter } = await mountReview();
    await click(button(host, "Done"));
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("2 unresolved threads");
    expect(dialog?.textContent).toContain("3 unfinished quizzes");
    expect(host.ownerDocument.activeElement?.textContent).toBe("Continue review");

    await click(button(dialog as HTMLElement, "Close anyway"));
    expect(host.textContent).toContain("Review closed · report preserved as read-only");
    expect(button(host, "Done").disabled).toBe(true);
    expect(button(host, "Conduct code change").disabled).toBe(true);
    expect((host.querySelector('[data-quiz-id="q1"] textarea') as HTMLTextAreaElement).disabled).toBe(true);

    const before = adapter.getSnapshot();
    await act(async () => adapter.submitQuiz("q1", "snapshot revision"));
    await act(async () => adapter.createThread({
      intent: "question",
      anchor: "A preserved passage",
      body: "Can this still mutate?",
      remember: false,
      scope: "project",
    }));
    expect(adapter.getSnapshot()).toBe(before);
  });
});
