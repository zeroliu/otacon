// UI e2e for delete-pending-session: a real browser deletes a pending session
// from both surfaces (index card + review header), and confirms an approved
// session offers no delete control. Sessions are seeded through the real HTTP
// API; the daemon hard-removes working state and pushes the `removed` frame.

import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Session } from "./helpers.js";
import { createSession, submitFixturePlan, uniqueTitle } from "./helpers.js";

const submitPlan = (request: APIRequestContext, id: string) =>
  submitFixturePlan(request, id, "valid-plan.md");

const cardFor = (page: Page, session: Session) =>
  page.locator(".card", { hasText: session.title });

test("delete a pending session from the index card drops it live", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("trash"));
  await page.goto("/");
  const card = cardFor(page, session);
  await expect(card).toBeVisible();

  // The card is a link; the ✕ must open the sheet, not navigate into it.
  await card.locator(".card-delete").click();
  await expect(page).toHaveURL(/\/$/);
  const sheet = page.locator(".delete-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("can't be undone");

  await sheet.locator(".btn-delete").click();
  // The terminal `removed` SSE frame drops the card without a reload.
  await expect(card).toHaveCount(0);
});

test("delete from the review screen returns to the index", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("screen-trash"));
  await page.goto(`/s/${session.id}`);
  await expect(page.locator(".session-title")).toHaveText(session.title);

  await page.locator(".session-delete").click();
  await expect(page.locator(".delete-sheet")).toBeVisible();
  await page.locator(".btn-delete").click();

  // Deleting from the screen navigates home; the card is gone there too.
  await expect(page.locator(".masthead")).toBeVisible();
  await expect(cardFor(page, session)).toHaveCount(0);
});

test("a pending delete can be cancelled, leaving the session untouched", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("keep"));
  await page.goto("/");
  const card = cardFor(page, session);

  await card.locator(".card-delete").click();
  await page.locator(".delete-sheet .btn-ghost").click();
  await expect(page.locator(".delete-sheet")).toHaveCount(0);
  await expect(card).toBeVisible();
});

test("an approved session is deletable too, and its sheet says it is archived", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("approved-del"));
  await submitPlan(request, session.id);
  const approved = await request.post(`/api/sessions/${session.id}/approve`, {
    data: { force: true },
  });
  expect(approved.ok()).toBeTruthy();

  await page.goto("/");
  const card = cardFor(page, session);
  await expect(card.locator(".chip")).toHaveText("approved");

  // Approved sessions also carry the ✕, but the sheet promises archive (not purge).
  await card.locator(".card-delete").click();
  const sheet = page.locator(".delete-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("recoverable");
  await sheet.locator(".btn-delete").click();
  await expect(card).toHaveCount(0);
});
