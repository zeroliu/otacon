// UI e2e for live agent activity (review loop and daemon API, the live-activity
// stream §10a, review UI): a posted `otacon progress` note drives the
// activity-driven draft chip, flows into the live-activity stream as a
// `highlight` event (the now-playing bar + the live console below it), and bumps
// the agent-presence dot, over the real built daemon (see playwright.config.ts).
// Sessions are seeded through the real HTTP API.

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

test("a progress note drives the draft chip, the now-playing bar + console, and the live dot", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("activity"));
  await postProgress(request, session.id, "reading the auth module");
  await page.goto(`/s/${session.id}`);

  // The activity-driven draft chip reads the latest note (review UI, D3),
  // not a fixed "agent drafting".
  await expect(page.locator(".review-header .chip")).toHaveText("reading the auth module");
  // The always-on now-playing bar shows the latest event's label. The console
  // starts collapsed and never auto-expands now, so open it to see the highlight.
  await expect(page.locator(".now-playing .np-label")).toContainText("reading the auth module");
  await page.locator(".now-playing").click();
  await expect(page.locator(".live-console .lc-highlight-body")).toContainText(
    "reading the auth module",
  );
  // A floor-only stream (only progress notes) reads "notes", not "live".
  await expect(page.locator(".now-playing .np-mode")).toHaveText("notes");
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
  // The bar is present from the first second (the session is agent-active in
  // `draft`), even before any stream event lands; it shows a resting line.
  await expect(page.locator(".now-playing")).toBeVisible();
  await plantMarker(page);

  await postProgress(request, session.id, "drafting the plan");
  await expect(page.locator(".review-header .chip")).toHaveText("drafting the plan");
  await expect(page.locator(".now-playing .np-label")).toContainText("drafting the plan");
  // The console is collapsed by default; open it to see the highlight row.
  await page.locator(".now-playing").click();
  await expect(page.locator(".live-console .lc-highlight-body")).toContainText(
    "drafting the plan",
  );
  expect(await readMarker(page)).toBe(true); // SSE updated the screen, no navigation
});

test("the index sidebar row shows a live agent dot after a progress note", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("activity-card"));
  await postProgress(request, session.id, "exploring the daemon");
  await page.goto("/");
  // The sidebar row carries no note text (that rides the session header's chip),
  // but the progress note bumped last-contact, so the row's agent dot reads live.
  const row = page.locator(".sl-row", { hasText: session.title });
  await expect(row.locator(".agent-dot")).toHaveClass(/is-live/);
});

test("the console keeps multiple notes as distinct highlights; the chip shows the newest", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("activity-feed"));
  await postProgress(request, session.id, "first note");
  await postProgress(request, session.id, "second note");
  await page.goto(`/s/${session.id}`);

  // Each progress note is its own chapter divider (highlights never collapse),
  // so two notes render two highlight rows once the (collapsed) console is opened;
  // the draft chip rides the newest.
  await page.locator(".now-playing").click();
  await expect(page.locator(".live-console .lc-highlight")).toHaveCount(2);
  await expect(page.locator(".review-header .chip")).toHaveText("second note");
});
