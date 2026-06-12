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
  return (await res.json()) as Session;
}

/** Submit a fixture plan (session id substituted) through the real endpoint. */
export async function submitFixturePlan(
  request: APIRequestContext,
  id: string,
  fixture: string,
  mutate: (plan: string) => string = (plan) => plan,
): Promise<void> {
  const plan = mutate(
    readFileSync(join(fixturesDir, fixture), "utf8").replace("otc_test01", id),
  );
  const res = await request.post(`/api/sessions/${id}/submit`, {
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
