import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

const report = `---
type: otacon-pr-review
version: 1
session: otc_render1
revision: 1
pr: github.com/acme/app#42
head: abc
knowledge-snapshot: ${"a".repeat(64)}
altitude: expert
---

## Background

The old report read mutable knowledge.

## Intuition

Treat the snapshot as a labeled photograph.

## Code

Read the contract before the runtime handoff.

### Interface changes — Snapshot contract

**Purpose:** Make the frozen authoring input explicit to every caller.
**Changed behavior:** The revision now owns a snapshot instead of reading current knowledge.
**Surfaces:** \`src/shared/review.ts#ReviewSnapshot\`

\`\`\`ts
type ReviewSnapshot = { hash: string };
\`\`\`

### Integration path — Capture handoff

**Purpose:** Follow the frozen value across the daemon boundary.
**Changed behavior:** Submit verifies the prepared snapshot before publication.
**Surfaces:** \`src/daemon/app.ts#submitReview\`

### Implementation walkthrough — Atomic commit

**Purpose:** Inspect the one crash-safe publication boundary in the store.
**Changed behavior:** Report and quiz become visible together through one rename.
**Surfaces:** \`src/daemon/review-store.ts#submit\`

## Quiz

Answer in your own words.
`;

let root: Root | undefined;
let restore: (() => void) | undefined;

async function render(markdown = report): Promise<HTMLElement> {
  const win = new Window({ url: "http://localhost/" });
  const oldDocument = (globalThis as { document?: unknown }).document;
  const oldWindow = (globalThis as { window?: unknown }).window;
  const oldElement = (globalThis as { Element?: unknown }).Element;
  const oldActEnvironment =
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  restore = () => {
    (globalThis as { document?: unknown }).document = oldDocument;
    (globalThis as { window?: unknown }).window = oldWindow;
    (globalThis as { Element?: unknown }).Element = oldElement;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      oldActEnvironment;
  };
  (globalThis as { document?: unknown }).document = win.document;
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { Element?: unknown }).Element = win.Element;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  root = createRoot(host);
  const { ReportView } = await import("./report-view.js");
  await act(async () => root?.render(<ReportView markdown={markdown} quiz={<p data-quiz-card>quiz card</p>} />));
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  restore?.();
  root = undefined;
  restore = undefined;
});

describe("ReportView", () => {
  test("renders the fixed read path, stable anchors, source ranges, and shared code primitive", async () => {
    const host = await render();
    expect([...host.querySelectorAll(":scope > section > h2")].map((node) => node.textContent)).toEqual([
      "Background", "Intuition", "Code", "Quiz",
    ]);
    expect([...host.querySelectorAll("#code > .pr-code-layer > h3")].map((node) => node.textContent)).toEqual([
      "Interface changes", "Integration path", "Implementation walkthrough",
    ]);
    const group = host.querySelector("[data-code-kind='interface']") as HTMLElement;
    expect(group.id).toBe("code-interface-snapshot-contract");
    expect(group.dataset.sourceLines).toMatch(/^\d+-\d+$/);
    expect(group.textContent).toContain("The revision now owns a snapshot");
    expect(group.querySelector(".pr-changed-behavior")?.textContent).toContain(
      "Changed behavior: The revision now owns a snapshot",
    );
    expect(group.querySelector(".fence code")?.textContent).toContain("type ReviewSnapshot");
    expect(host.querySelector("[data-quiz-card]")?.textContent).toBe("quiz card");
  });

  test("tolerantly displays recovered sections and marks a damaged stored report", async () => {
    const host = await render(
      report.replace("## Background", "## Intuition").replace("Interface changes — Snapshot contract", "Unknown layer — Snapshot contract"),
    );
    expect(host.querySelector(".pr-report-recovery")?.textContent).toContain("recoverable parts");
    expect(host.querySelector("#code")).not.toBeNull();
    expect(host.querySelector("#code-recovered")?.textContent).toContain("Snapshot contract");
  });
});
