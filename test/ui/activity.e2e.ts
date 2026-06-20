// UI e2e for live agent activity (review loop and daemon API, review UI): a posted `otacon
// progress` note drives the activity-driven draft chip, the live activity log,
// and the agent-presence dot — over the real built daemon (see
// playwright.config.ts). Sessions are seeded through the real HTTP API.

import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { createSession, plantMarker, readMarker, uniqueTitle } from "./helpers.js";

async function postProgress(
  request: APIRequestContext,
  id: string,
  note: string,
): Promise<void> {
  const res = await request.post(`/api/sessions/${id}/progress`, { data: { note } });
  expect(res.status()).toBe(200);
}

test("a progress note drives the draft chip, the activity log, and the live dot", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("activity"));
  await postProgress(request, session.id, "reading the auth module");
  await page.goto(`/s/${session.id}`);

  // The activity-driven draft chip reads the latest note (review UI, D3),
  // not a fixed "agent drafting".
  await expect(page.locator(".review-header .chip")).toHaveText("reading the auth module");
  // The pre-plan placeholder leads with the activity log, open.
  await expect(page.locator(".review-wait .activity .act-text")).toContainText(
    "reading the auth module",
  );
  // Posting progress bumped last-contact, so the agent dot reads live; it is
  // distinct from the link dot (labelled "agent").
  await expect(page.locator(".review-header .agent-dot")).toHaveClass(/is-live/);
  await expect(page.locator(".review-header .agent-dot")).toContainText("agent");
});

test("a progress note posted while watching appears live (SSE), no reload", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("activity-live"));
  await page.goto(`/s/${session.id}`);
  // No note yet: the draft chip falls back to "agent working".
  await expect(page.locator(".review-header .chip")).toHaveText("agent working");
  await expect(page.locator(".review-wait")).toBeVisible();
  await plantMarker(page);

  await postProgress(request, session.id, "drafting the plan");
  await expect(page.locator(".review-header .chip")).toHaveText("drafting the plan");
  await expect(page.locator(".review-wait .activity .act-text")).toContainText(
    "drafting the plan",
  );
  expect(await readMarker(page)).toBe(true); // SSE updated the screen, no navigation
});

test("the index card shows the latest note and a live agent dot", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("activity-card"));
  await postProgress(request, session.id, "exploring the daemon");
  await page.goto("/");
  const card = page.locator(".card", { hasText: session.title });
  await expect(card.locator(".chip")).toHaveText("exploring the daemon");
  await expect(card.locator(".agent-dot")).toHaveClass(/is-live/);
});

test("the activity log keeps multiple notes; the chip shows the newest", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("activity-feed"));
  await postProgress(request, session.id, "first note");
  await postProgress(request, session.id, "second note");
  await page.goto(`/s/${session.id}`);

  await expect(page.locator(".review-wait .activity .act-entry")).toHaveCount(2);
  await expect(page.locator(".review-header .chip")).toHaveText("second note");
});
