// UI e2e: real browser against the real built daemon (see playwright.config.ts;
// the webServer boots `node dist/daemon/main.js` with a temp OTACON_HOME).
// Sessions are seeded through the real HTTP API; titles carry a unique suffix
// so parallel tests never match each other's cards.

import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Session } from "./helpers.js";
import { createSession, plantMarker, readMarker, submitFixturePlan, uniqueTitle } from "./helpers.js";

const submitPlan = (request: APIRequestContext, id: string) =>
  submitFixturePlan(request, id, "valid-plan.md");

async function postComment(request: APIRequestContext, id: string): Promise<void> {
  const res = await request.post(`/api/sessions/${id}/comments`, {
    data: { items: [{ anchor: null, body: "tighten phase 2" }] },
  });
  expect(res.status()).toBe(202);
}

/** Mirrors ui/src/accent.ts — the test locks the algorithm in place. */
function expectedHue(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

const cardFor = (page: Page, session: Session) =>
  page.locator(".card", { hasText: session.title });

test("index renders session cards with the correct status chips", async ({ page, request }) => {
  const drafting = await createSession(request, uniqueTitle("drafting"));
  const awaiting = await createSession(request, uniqueTitle("awaiting"));
  await submitPlan(request, awaiting.id);
  const revising = await createSession(request, uniqueTitle("revising"));
  await submitPlan(request, revising.id);
  await postComment(request, revising.id);

  await page.goto("/");
  await expect(cardFor(page, drafting).locator(".chip")).toHaveText("agent drafting");
  await expect(cardFor(page, awaiting).locator(".chip")).toHaveText("awaiting your review");
  await expect(cardFor(page, revising).locator(".chip")).toHaveText("agent revising");
  // repo + branch metadata renders on the card
  await expect(cardFor(page, drafting).locator(".card-where")).toContainText("zero/prototype");
});

test("a session created via the API appears live, without a reload (SSE)", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator(".masthead")).toBeVisible();
  await plantMarker(page);

  const fresh = await createSession(request, uniqueTitle("fresh"));
  await expect(cardFor(page, fresh)).toBeVisible();
  expect(await readMarker(page)).toBe(true); // no navigation happened
});

test("a status change flips the chip live and raises the unread badge", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("flip"));
  await page.goto("/");
  const card = cardFor(page, session);
  await expect(card.locator(".chip")).toHaveText("agent drafting");
  await plantMarker(page);

  await submitPlan(request, session.id);
  await expect(card.locator(".chip")).toHaveText("awaiting your review");
  await expect(card.locator(".badge")).toHaveText("r1 unread");
  expect(await readMarker(page)).toBe(true);
});

test("the /s/:id shell renders the session header in its accent color", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("shell"));
  await page.goto(`/s/${session.id}`);

  await expect(page.locator(".session-title")).toHaveText(session.title);
  await expect(page.locator(".chip")).toHaveText("agent drafting");
  await expect(page.locator(".session-rev")).toHaveText("r0");

  const hue = await page
    .locator(".page")
    .evaluate((el) => el.style.getPropertyValue("--hue"));
  expect(Number(hue)).toBe(expectedHue(session.id));
  // ...and the hue actually lands on the accent rule along the header's top
  // edge (the hairline-telemetry treatment; §10). getComputedStyle is reached
  // through the element so no DOM globals leak into the tsconfig.
  const edge = await page
    .locator(".session-head")
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
  await expect(cardFor(page, session)).toBeVisible();
  const dark = await backgroundLuminance(page);

  await page.emulateMedia({ colorScheme: "light" });
  await expect(cardFor(page, session)).toBeVisible();
  const light = await backgroundLuminance(page);

  expect(dark).toBeLessThan(64);
  expect(light).toBeGreaterThan(192);
});
