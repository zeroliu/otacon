// Shared setup for the UI e2e specs (not collected as a spec itself —
// playwright.config.ts matches only *.e2e.ts). Sessions are seeded through
// the real HTTP API; titles carry a unique suffix so parallel tests never
// match each other's cards.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export interface Session {
  id: string;
  title: string;
  /** The throwaway repo root — a Save's .otacon/plans project copy lands here. */
  repo: string;
}

export interface ReviewSession extends Session {
  number: number;
  headSha: string;
  snapshotHash: string;
}

export const uniqueTitle = (label: string) =>
  `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function createSession(
  request: APIRequestContext,
  title: string,
): Promise<Session> {
  const repo = mkdtempSync(join(tmpdir(), "otacon-ui-e2e-repo-"));
  const res = await request.post("/api/sessions", {
    data: { title, repo, branch: "zero/prototype" },
  });
  expect(res.status()).toBe(201);
  return { ...((await res.json()) as { id: string; title: string }), repo };
}

/**
 * Start one production PR-review session through its canonical identity API.
 * The large per-test PR number prevents fully-parallel Playwright workers from
 * accidentally reusing one another's session for the shared acme/app fixture.
 */
export async function createReviewSession(
  request: APIRequestContext,
  title: string,
): Promise<ReviewSession> {
  const repo = mkdtempSync(join(tmpdir(), "otacon-ui-e2e-review-repo-"));
  const number = Date.now() * 1_000 + Math.floor(Math.random() * 1_000);
  const headSha = "a".repeat(40);
  const res = await request.post("/api/reviews", {
    data: {
      repo,
      repository: "acme/app",
      branch: "main",
      pullRequest: {
        identity: {
          host: "github.com",
          repository: "acme/app",
          number,
          key: `github.com/acme/app#${number}`,
        },
        url: `https://github.com/acme/app/pull/${number}`,
        title,
        author: "octo",
        baseRef: "main",
        headRef: "feature/review-e2e",
        headRepository: "acme/app",
        headSha,
        state: "open",
        isCrossRepository: false,
        permissions: {
          maintainerCanModify: true,
          viewerPermission: "write",
          readOnly: false,
        },
      },
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as {
    session: { id: string; title: string };
    preparation: { snapshot: { hash: string } };
  };
  return {
    id: body.session.id,
    title: body.session.title,
    repo,
    number,
    headSha,
    snapshotHash: body.preparation.snapshot.hash,
  };
}

/** Submit the strict report + private quiz companions through the real API. */
export async function submitFixtureReview(
  request: APIRequestContext,
  session: ReviewSession,
): Promise<void> {
  const replaceSentinels = (source: string): string => source
    .replaceAll("otc_test01", session.id)
    .replaceAll("0".repeat(64), session.snapshotHash)
    .replaceAll("github.com/acme/app#42", `github.com/acme/app#${session.number}`);
  const report = replaceSentinels(readFileSync(join(fixturesDir, "review-report.md"), "utf8"));
  const quiz = replaceSentinels(readFileSync(join(fixturesDir, "review-quiz.json"), "utf8"));
  const res = await request.post(`/api/reviews/${session.id}/submit`, {
    data: { report, quiz },
  });
  expect(res.status()).toBe(201);
}

/**
 * Submit a fixture plan (session id substituted) through the real endpoint.
 * Pass `resolutions` ({changelog, threads}) on revisions ≥ 2 — lint L5
 * requires a changelog there, exactly like production.
 */
export async function submitFixturePlan(
  request: APIRequestContext,
  id: string,
  fixture: string,
  mutate: (plan: string) => string = (plan) => plan,
  resolutions?: { changelog?: string; threads?: Record<string, string> },
): Promise<void> {
  const plan = mutate(
    readFileSync(join(fixturesDir, fixture), "utf8").replace("otc_test01", id),
  );
  const res = resolutions
    ? await request.post(`/api/sessions/${id}/submit`, { data: { plan, resolutions } })
    : await request.post(`/api/sessions/${id}/submit`, {
        headers: { "content-type": "text/markdown" },
        data: plan,
      });
  expect(res.ok()).toBeTruthy();
}

// Marker that survives SPA updates but not a page reload — proves SSE updated
// the screen without a navigation. String-expression evaluate keeps browser
// globals out of the server tsconfig (no DOM lib).
export const plantMarker = (page: Page) => page.evaluate("window.__otaconMarker = true");
export const readMarker = (page: Page) => page.evaluate("window.__otaconMarker === true");

/**
 * Select `needle` inside the element at `selector` the way a user would —
 * a real DOM Range over the text node, which fires selectionchange. The
 * string-expression evaluate keeps DOM types out of the server tsconfig.
 */
export async function selectText(page: Page, selector: string, needle: string): Promise<void> {
  const found = await page.evaluate(
    `(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return false;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node.nodeValue ?? "").indexOf(${JSON.stringify(needle)});
        if (at !== -1) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + ${needle.length});
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          return true;
        }
      }
      return false;
    })()`,
  );
  expect(found, `could not select ${JSON.stringify(needle)} in ${selector}`).toBe(true);
}
