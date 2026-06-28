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

// A progress note bumps the session's last-contact, so a working session reads
// its working word ("drafting"/"revising") in the sidebar glyph rather than the
// offline "stalled" — the agent is on the line.
async function postProgress(request: APIRequestContext, id: string, note: string): Promise<void> {
  const res = await request.post(`/api/sessions/${id}/progress`, { data: { note } });
  expect(res.status()).toBe(200);
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

// The index is the app-shell sidebar now: one `.sl-row` per session, status
// conveyed by the `.sl-glyph` (aria-label = the status word), not a `.card`/`.chip`.
const rowFor = (page: Page, session: Session) =>
  page.locator(".sl-row", { hasText: session.title });
const glyphFor = (page: Page, session: Session) => rowFor(page, session).locator(".sl-glyph");

test("the index sidebar renders rows with the correct status glyphs", async ({ page, request }) => {
  // The working sessions get a live agent (a progress note bumps last-contact),
  // so their glyph reads the working word rather than the offline "stalled".
  const drafting = await createSession(request, uniqueTitle("drafting"));
  await postProgress(request, drafting.id, "reading the auth module");
  const awaiting = await createSession(request, uniqueTitle("awaiting"));
  await submitPlan(request, awaiting.id);
  const revising = await createSession(request, uniqueTitle("revising"));
  await submitPlan(request, revising.id);
  await postComment(request, revising.id);
  await postProgress(request, revising.id, "folding in the comment");

  await page.goto("/");
  await expect(glyphFor(page, drafting)).toHaveAttribute("aria-label", "drafting");
  await expect(glyphFor(page, awaiting)).toHaveAttribute("aria-label", "review needed");
  await expect(glyphFor(page, revising)).toHaveAttribute("aria-label", "revising");
  // repo + branch metadata renders on the row
  await expect(rowFor(page, drafting).locator(".sl-where")).toContainText("zero/prototype");
});

test("a session created via the API appears live, without a reload (SSE)", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator(".app-sidebar")).toBeVisible();
  await plantMarker(page);

  const fresh = await createSession(request, uniqueTitle("fresh"));
  await expect(rowFor(page, fresh)).toBeVisible();
  expect(await readMarker(page)).toBe(true); // no navigation happened
});

test("a status change flips the glyph live and raises the unread badge", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("flip"));
  await page.goto("/");
  const row = rowFor(page, session);
  // Fresh draft, no agent on the line yet → the offline "stalled" glyph.
  await expect(row.locator(".sl-glyph")).toHaveAttribute("aria-label", "stalled");
  await plantMarker(page);

  await submitPlan(request, session.id);
  await expect(row.locator(".sl-glyph")).toHaveAttribute("aria-label", "review needed");
  await expect(row.locator(".sl-unread")).toHaveText("●1");
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
  await expect(rowFor(page, session)).toBeVisible();
  const dark = await backgroundLuminance(page);

  await page.emulateMedia({ colorScheme: "light" });
  await expect(rowFor(page, session)).toBeVisible();
  const light = await backgroundLuminance(page);

  expect(dark).toBeLessThan(64);
  expect(light).toBeGreaterThan(192);
});
