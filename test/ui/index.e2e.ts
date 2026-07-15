// UI e2e: real browser against the real built daemon (see playwright.config.ts;
// the webServer boots `node dist/daemon/main.js` with a temp OTACON_HOME).
// Sessions are seeded through the real HTTP API; titles carry a unique suffix
// so parallel tests never match each other's cards.

import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Session } from "./helpers.js";
import {
  createReviewSession,
  createSession,
  plantMarker,
  readMarker,
  submitFixturePlan,
  submitFixtureReview,
  uniqueTitle,
} from "./helpers.js";

const submitPlan = (request: APIRequestContext, id: string) =>
  submitFixturePlan(request, id, "valid-plan.md");

async function postComment(request: APIRequestContext, id: string): Promise<void> {
  const res = await request.post(`/api/sessions/${id}/comments`, {
    data: { items: [{ anchor: null, body: "tighten phase 2" }] },
  });
  expect(res.status()).toBe(202);
}

/** Mirrors src/ui/accent.ts — the test locks the algorithm in place. */
function expectedHue(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

const rowFor = (page: Page, session: Session) =>
  page.locator(".app-shell > .app-sidebar .sl-row", { hasText: session.title });

async function showPlans(page: Page): Promise<void> {
  const plans = page
    .locator(".app-shell > .app-sidebar")
    .getByRole("group", { name: "session kind" })
    .getByRole("button", { name: "Plans" });
  if ((await plans.getAttribute("aria-pressed")) !== "true") await plans.click();
  await expect(plans).toHaveAttribute("aria-pressed", "true");
}

test("index renders sidebar rows with the correct status glyphs", async ({ page, request }) => {
  const drafting = await createSession(request, uniqueTitle("drafting"));
  const awaiting = await createSession(request, uniqueTitle("awaiting"));
  await submitPlan(request, awaiting.id);
  const revising = await createSession(request, uniqueTitle("revising"));
  await submitPlan(request, revising.id);
  await postComment(request, revising.id);

  await page.goto("/");
  await showPlans(page);
  await expect(rowFor(page, drafting).locator(".sl-glyph")).toHaveAttribute("aria-label", "stalled");
  await expect(rowFor(page, awaiting).locator(".sl-glyph")).toHaveAttribute("aria-label", "review needed");
  await expect(rowFor(page, revising).locator(".sl-glyph")).toHaveAttribute("aria-label", "revising");
  // repo + branch metadata renders on the row
  await expect(rowFor(page, drafting).locator(".sl-where")).toContainText("zero/prototype");
});

test("a session created via the API appears live, without a reload (SSE)", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator(".app-shell > .app-sidebar .app-sidebar-head")).toBeVisible();
  await showPlans(page);
  await plantMarker(page);

  const fresh = await createSession(request, uniqueTitle("fresh"));
  await expect(rowFor(page, fresh)).toBeVisible();
  expect(await readMarker(page)).toBe(true); // no navigation happened
});

test("a status change flips the chip live and raises the unread badge", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("flip"));
  await page.goto("/");
  await showPlans(page);
  const row = rowFor(page, session);
  await expect(row.locator(".sl-glyph")).toHaveAttribute("aria-label", "stalled");
  await plantMarker(page);

  await submitPlan(request, session.id);
  await expect(row.locator(".sl-glyph")).toHaveAttribute("aria-label", "review needed");
  await expect(row.locator(".sl-unread")).toHaveAttribute("aria-label", "1 unread");
  expect(await readMarker(page)).toBe(true);
});

test("the /s/:id shell renders the session header in its accent color", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("shell"));
  await page.goto(`/s/${session.id}`);

  await expect(page.locator(".session-title")).toHaveText(session.title);
  // The status pill renders in the always-on bar even before any plan lands (r0);
  // the old r0 revision pill is gone, so the chip is the no-plan header's signal.
  await expect(page.locator(".chip")).toHaveText("agent working");

  const hue = await page
    .locator(".page")
    .evaluate((el) => el.style.getPropertyValue("--hue"));
  expect(Number(hue)).toBe(expectedHue(session.id));
  // ...and the hue actually lands on the accent rule along the header's top
  // edge (the hairline-telemetry treatment; review UI). getComputedStyle is reached
  // through the element so no DOM globals leak into the tsconfig.
  const edge = await page
    .locator(".review-header")
    .evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).borderTopColor);
  expect(edge).toMatch(/^(rgb|color|lab|okl)/);
  expect(edge).not.toBe("rgba(0, 0, 0, 0)");
});

test("an unknown session id renders the client-side not-found state", async ({ page }) => {
  await page.goto("/s/otc_zzzzzz");
  await expect(page.locator(".empty-title")).toHaveText("unknown session");
  await expect(page.locator(".empty-body")).toContainText("otc_zzzzzz");
});

async function backgroundLuminance(page: Page): Promise<number> {
  const bg = (await page.evaluate(
    "getComputedStyle(document.body).backgroundColor",
  )) as string;
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
  if (!match) throw new Error(`unparseable background color: ${bg}`);
  return (Number(match[1]) + Number(match[2]) + Number(match[3])) / 3;
}

test("light and dark color schemes both render the index", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("scheme"));

  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await showPlans(page);
  await expect(rowFor(page, session)).toBeVisible();
  const dark = await backgroundLuminance(page);

  await page.emulateMedia({ colorScheme: "light" });
  await expect(rowFor(page, session)).toBeVisible();
  const light = await backgroundLuminance(page);

  expect(dark).toBeLessThan(64);
  expect(light).toBeGreaterThan(192);
});

test("the vertical sidebar switches Plans and Reviews without changing Open PR plan grouping", async ({
  page,
  request,
}) => {
  const activePlan = await createSession(request, uniqueTitle("active-plan"));
  await submitPlan(request, activePlan.id);

  const openPrPlan = await createSession(request, uniqueTitle("open-pr-plan"));
  await submitPlan(request, openPrPlan.id);
  const approved = await request.post(`/api/sessions/${openPrPlan.id}/approve`, {
    data: { implement: true },
  });
  expect(approved.ok()).toBeTruthy();
  const implemented = await request.post(`/api/sessions/${openPrPlan.id}/implement-done`, {
    data: { pr: "https://example.test/pull/open" },
  });
  expect(implemented.ok()).toBeTruthy();

  const review = await createReviewSession(request, uniqueTitle("sidebar-review"));
  await submitFixtureReview(request, review);

  await page.goto("/");
  const sidebar = page.locator(".app-shell > .app-sidebar");
  const switcher = sidebar.getByRole("group", { name: "session kind" });
  await expect(switcher.getByRole("button")).toHaveText(["Plans", "Reviews"]);
  await showPlans(page);
  await expect(switcher.getByRole("button", { name: "Plans" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await expect(sidebar.locator(".sl-row", { hasText: activePlan.title })).toBeVisible();
  const openPrs = sidebar.locator('.sl-group[aria-label^="Open PRs sessions"]');
  await expect(openPrs).toBeVisible();
  await expect(openPrs.locator(".sl-group-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(openPrs.locator(".sl-row", { hasText: openPrPlan.title })).toBeVisible();
  await expect(sidebar.locator(".sl-row", { hasText: review.title })).toHaveCount(0);

  await switcher.getByRole("button", { name: "Reviews" }).click();
  await expect(switcher.getByRole("button", { name: "Reviews" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(sidebar.locator('.sl-group[aria-label^="Active sessions"]')).toBeVisible();
  await expect(sidebar.locator(".sl-row", { hasText: review.title })).toBeVisible();
  await expect(sidebar.locator(".sl-row", { hasText: activePlan.title })).toHaveCount(0);
  await expect(sidebar.locator('.sl-group[aria-label^="Open PRs sessions"]')).toHaveCount(0);

  await switcher.getByRole("button", { name: "Plans" }).click();
  await expect(sidebar.locator(".sl-row", { hasText: activePlan.title })).toBeVisible();
  await expect(openPrs.locator(".sl-row", { hasText: openPrPlan.title })).toBeVisible();
});
