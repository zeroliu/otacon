// UI e2e for delete-pending-session: a real browser deletes a pending session
// from both surfaces (sidebar row + review header), and confirms an approved
// session is deletable too. Sessions are seeded through the real HTTP API; the
// daemon hard-removes working state and pushes the `removed` frame. The index is
// the app-shell sidebar now (rows are `.sl-row`, the per-row ✕ is `.sl-delete`).

import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Session } from "./helpers.js";
import { createSession, submitFixturePlan, uniqueTitle } from "./helpers.js";

const submitPlan = (request: APIRequestContext, id: string) =>
  submitFixturePlan(request, id, "valid-plan.md");

const rowFor = (page: Page, session: Session) =>
  page.locator(".sl-row", { hasText: session.title });

test("delete a pending session from the sidebar row drops it live", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("trash"));
  await page.goto("/");
  const row = rowFor(page, session);
  await expect(row).toBeVisible();

  // The row is a link; the ✕ must open the sheet, not navigate into it. The ✕ is
  // hover-revealed (pointer-events:none at rest), so hover the row to reach it.
  await row.hover();
  await row.locator(".sl-delete").click();
  await expect(page).toHaveURL(/\/$/);
  const sheet = page.locator(".delete-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("can't be undone");

  await sheet.locator(".btn-delete").click();
  // The terminal `removed` SSE frame drops the row without a reload.
  await expect(row).toHaveCount(0);
});

test("delete from the review screen returns to the index", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("screen-trash"));
  await page.goto(`/s/${session.id}`);
  await expect(page.locator(".session-title")).toHaveText(session.title);

  await page.locator(".session-delete").click();
  await expect(page.locator(".delete-sheet")).toBeVisible();
  await page.locator(".btn-delete").click();

  // Deleting from the screen navigates home; the row is gone in the sidebar too.
  await expect(page).toHaveURL(/\/$/);
  await expect(rowFor(page, session)).toHaveCount(0);
});

test("a pending delete can be cancelled, leaving the session untouched", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("keep"));
  await page.goto("/");
  const row = rowFor(page, session);
  await expect(row).toBeVisible();

  await row.hover();
  await row.locator(".sl-delete").click();
  await page.locator(".delete-sheet .btn-ghost").click();
  await expect(page.locator(".delete-sheet")).toHaveCount(0);
  await expect(row).toBeVisible();
});

test("an approved session is deletable too, and its sheet says removal is permanent", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("approved-del"));
  await submitPlan(request, session.id);
  const approved = await request.post(`/api/sessions/${session.id}/approve`, {
    data: { force: true },
  });
  expect(approved.ok()).toBeTruthy();

  // Approved (over) sessions live behind the sidebar's collapsed `approved (n)`
  // disclosure; expand it to reach the row, which reads approved.
  await page.goto("/");
  await page.locator(".sl-approved-toggle").click();
  const row = rowFor(page, session);
  await expect(row).toBeVisible();
  await expect(row.locator(".sl-glyph")).toHaveAttribute("aria-label", "approved");

  // Approved sessions also carry the ✕; delete is now a permanent removal of the
  // home folder (the durable copy survives elsewhere: the saved plan / PR).
  await row.hover();
  await row.locator(".sl-delete").click();
  const sheet = page.locator(".delete-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("can't be undone");
  await sheet.locator(".btn-delete").click();
  await expect(row).toHaveCount(0);
});
