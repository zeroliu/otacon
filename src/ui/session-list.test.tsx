import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { CanonicalGitHubRepo } from "../shared/knowledge.js";
import { pullRequestIdentity } from "../shared/review.js";
import type { LiveSession } from "./api.js";
import { SessionListContents } from "./session-list.js";

let root: Root | undefined;
let restore: (() => void) | undefined;

const common = {
  repo: "/repo",
  branch: "main",
  quick: false,
  socratic: false,
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
  revision: 1,
  lastReviewedRevision: 0,
  pendingEvents: 0,
  openQuestions: 0,
  parked: false,
};

function plan(id: string, title: string, status: "draft" | "implemented", openPr = false): LiveSession {
  return {
    ...common,
    kind: "plan",
    id,
    title,
    status,
    ...(openPr ? { prUrl: "https://github.com/acme/app/pull/9", prState: "open" as const } : {}),
  };
}

function review(): LiveSession {
  const repository = "acme/app" as CanonicalGitHubRepo;
  const pullRequest = {
    identity: pullRequestIdentity(repository, 42),
    url: "https://github.com/acme/app/pull/42",
    title: "Typed sessions",
    author: "octo",
    baseRef: "main",
    headRef: "feature",
    headRepository: repository,
    headSha: "a".repeat(40),
    state: "open" as const,
    isCrossRepository: false,
    permissions: { maintainerCanModify: true, viewerPermission: "write" as const, readOnly: false },
  };
  return {
    ...common,
    kind: "review",
    id: "review",
    title: "#42 Typed sessions",
    quick: false,
    socratic: false,
    status: "reviewing",
    review: {
      pullRequest,
      head: { sha: pullRequest.headSha, ref: "feature", repository, capturedAt: common.updatedAt },
      revision: 1,
    },
  };
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  restore?.();
  root = undefined;
  restore = undefined;
});

async function mount(): Promise<HTMLElement> {
  const win = new Window({ url: "http://localhost/" });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousElement = globalThis.Element;
  Object.assign(globalThis, { document: win.document, window: win, Element: win.Element });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  restore = () => Object.assign(globalThis, {
    document: previousDocument,
    window: previousWindow,
    Element: previousElement,
  });
  const happyHost = win.document.createElement("div");
  win.document.body.appendChild(happyHost);
  const host = happyHost as unknown as HTMLElement;
  root = createRoot(host);
  await act(async () => root?.render(
    <SessionListContents
      sessions={[
        plan("active", "Active plan", "draft"),
        plan("open-pr", "Implemented plan", "implemented", true),
        review(),
      ]}
      now={Date.now()}
    />,
  ));
  return host;
}

describe("production Plans / Reviews sidebar switch", () => {
  test("keeps plan Open PRs separate and shows review-specific rows on switch", async () => {
    const host = await mount();
    expect(host.textContent).toContain("Active plan");
    expect(host.textContent).toContain("Open PRs");
    expect(host.textContent).not.toContain("Typed sessions");

    const reviews = [...host.querySelectorAll("button")].find((button) => button.textContent === "Reviews");
    if (!reviews) throw new Error("Reviews switch missing");
    await act(async () => (reviews as HTMLButtonElement).click());
    expect(host.textContent).toContain("#42 Typed sessions");
    expect(host.textContent).toContain("acme/app · acme/app:feature");
    expect(host.textContent).not.toContain("Active plan");
    expect(host.textContent).not.toContain("Open PRs");
    expect(host.querySelector('[aria-label="reviewing"]')).not.toBeNull();

    const remove = host.querySelector('[aria-label="delete session #42 Typed sessions"]');
    if (!remove) throw new Error("review delete control missing");
    await act(async () => (remove as HTMLButtonElement).click());
    expect(document.body.textContent).toContain("report, quiz history, threads, and local session");
    expect(document.body.textContent).not.toContain("approved plan still survives");
  });
});
