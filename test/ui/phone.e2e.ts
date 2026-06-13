// M5b e2e: the §10 phone review surface, against the real daemon and the
// real built CLI. Section ⋯ menus mint section-only anchors ({section}, no
// exact quote) that round-trip to a parked `otacon wait`; the sticky bar is
// the whole one-thumb control surface (❓ queue jump, drawer + send all,
// approve); the header switcher scrolls as chips and navigates; `otacon
// clean` removes a session live everywhere. Desktop keeps its header strip —
// the phone controls never show there.

import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { reapCli, runCli } from "./cli.js";
import type { Session } from "./helpers.js";
import {
  createSession,
  plantMarker,
  readMarker,
  submitFixturePlan,
  uniqueTitle,
} from "./helpers.js";

test.afterEach(reapCli);

const PHONE = { width: 375, height: 720 };

async function openReview(page: Page, request: APIRequestContext, label: string): Promise<Session> {
  const session = await createSession(request, uniqueTitle(label));
  await submitFixturePlan(request, session.id, "valid-plan.md");
  await page.goto(`/s/${session.id}`);
  await expect(page.locator("#summary .md")).toBeVisible();
  return session;
}

async function ask(request: APIRequestContext, id: string, question: string): Promise<void> {
  const res = await request.post(`/api/sessions/${id}/ask`, { data: { question } });
  expect(res.status()).toBe(201);
}

test("375px: ⋯ menu → section comment → sticky-bar send all delivers a section-only anchor to a parked CLI wait", async ({
  page,
  request,
}) => {
  await page.setViewportSize(PHONE);
  const session = await openReview(page, request, "sec-comment");

  // The ⋯ menu opens as a bottom sheet with ≥44px rows, named for its slug.
  await page.locator("#phase-1 .sec-menu").click();
  const sheet = page.locator(".sec-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".sec-slug")).toHaveText("#phase-1");
  for (const item of await sheet.locator(".sec-item").all()) {
    const box = await item.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
  }

  // Comment on section → the composer sheet, targeted at the slug, no quote.
  await sheet.locator(".sec-item", { hasText: "comment on section" }).click();
  const composer = page.locator(".composer");
  await expect(composer).toHaveClass(/composer-sheet/);
  await expect(composer.locator(".composer-mode")).toHaveText("comment");
  await expect(composer.locator(".composer-target")).toHaveText("→ #phase-1");
  await expect(composer.locator(".composer-quote")).toHaveCount(0);
  await composer.locator(".composer-input").fill("split key rotation into its own phase");
  await composer.locator(".btn-primary", { hasText: "add to drawer" }).click();

  // Batched, badged on the sticky bar (◆1), not sent yet.
  await expect(page.locator(".drawer-tally .drawer-count")).toHaveText("1");
  await expect(page.locator(".thread")).toHaveCount(0);

  // Send all from the sticky bar wakes the REAL parked CLI with the anchor.
  const parked = runCli(["wait", "--timeout", "30", "--session", session.id]);
  await page.locator(".drawer-bar .btn-primary", { hasText: "send all" }).click();
  const result = await parked;
  expect(result.code).toBe(0);
  const event = JSON.parse(result.stdout) as {
    event: string;
    items: { anchor: { section: string; exact?: string }; body: string }[];
  };
  expect(event.event).toBe("comments");
  expect(event.items).toHaveLength(1);
  expect(event.items[0]!.anchor.section).toBe("phase-1");
  expect(event.items[0]!.anchor.exact).toBeUndefined(); // section-only by design
  expect(event.items[0]!.body).toBe("split key rotation into its own phase");

  // The rail thread shows the slug and (having no quote) no blockquote.
  const thread = page.locator(".thread-comment");
  await expect(thread).toHaveCount(1);
  await expect(thread.locator(".thread-where")).toHaveText("#phase-1");
  await expect(thread.locator(".thread-quote")).toHaveCount(0);

  // Jumping from the thread still washes the section (anchor sans quote).
  await thread.click();
  await expect(page.locator("#phase-1.anchor-hit")).toHaveCount(1);
});

test("375px: ⋯ ask fires instantly with the section anchor", async ({ page, request }) => {
  await page.setViewportSize(PHONE);
  const session = await openReview(page, request, "sec-ask");

  await page.locator("#summary .sec-menu").click();
  await page.locator(".sec-item", { hasText: "ask about section" }).click();
  await expect(page.locator(".composer-mode")).toHaveText("ask");
  await page.locator(".composer-input").fill("does the summary cover token revocation?");
  await page.locator(".btn-primary", { hasText: "ask now" }).click();

  // Instant thread with the answering placeholder; the wait gets the anchor.
  await expect(page.locator(".thread-question .thread-answering")).toBeVisible();
  const delivered = await runCli(["wait", "--timeout", "30", "--session", session.id]);
  expect(delivered.code).toBe(0);
  const event = JSON.parse(delivered.stdout) as {
    event: string;
    anchor: { section: string; exact?: string };
    body: string;
  };
  expect(event.event).toBe("question");
  expect(event.anchor.section).toBe("summary");
  expect(event.anchor.exact).toBeUndefined();
  expect(event.body).toBe("does the summary cover token revocation?");
});

test("375px: sticky bar counts live-update over SSE; ❓ jumps to the question queue", async ({
  page,
  request,
}) => {
  await page.setViewportSize(PHONE);
  const session = await openReview(page, request, "bar-counts");
  await plantMarker(page);

  // No questions, nothing pending: the bar shows neither badge.
  await expect(page.locator(".bar-quest")).toHaveCount(0);
  await expect(page.locator(".drawer-tally")).toHaveCount(0);

  // An agent ask raises the ❓ badge live.
  await ask(request, session.id, "Which storage backend should the index use?");
  await expect(page.locator(".bar-quest .bar-count")).toHaveText("1");
  await ask(request, session.id, "Hard cutover or migration window?");
  await expect(page.locator(".bar-quest .bar-count")).toHaveText("2");

  // A stacked comment raises the ◆ badge.
  await page.locator("#decisions .sec-menu").click();
  await page.locator(".sec-item", { hasText: "comment on section" }).click();
  await page.locator(".composer-input").fill("cite the grill answer for D1");
  await page.locator(".btn-primary", { hasText: "add to drawer" }).click();
  await expect(page.locator(".drawer-tally .drawer-count")).toHaveText("1");
  expect(await readMarker(page)).toBe(true); // all of it over SSE, no reload

  // From deep in the plan, ❓ brings the question queue back into reach.
  await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
  await page.locator(".bar-quest").click();
  await expect(async () => {
    const box = await page.locator(".grill-queue").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(-10);
    expect(box!.y).toBeLessThan(PHONE.height);
  }).toPass();
});

test("375px: approve from the sticky bar walks the confirm sheet and ends the session", async ({
  page,
  request,
}) => {
  await page.setViewportSize(PHONE);
  await openReview(page, request, "bar-approve");

  const approve = page.locator(".bar-approve");
  await expect(approve).toBeVisible();
  const box = await approve.boundingBox();
  expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);

  await approve.click();
  const sheetBox = await page.locator(".approve-sheet").boundingBox();
  expect(sheetBox).not.toBeNull();
  expect(sheetBox!.y + sheetBox!.height).toBeGreaterThan(PHONE.height * 0.8); // thumb range
  await page.locator(".btn-approve", { hasText: "finalize & end" }).click();

  // The session frame flips the screen read-only: note up, controls gone.
  await expect(page.locator(".approved-note")).toBeVisible();
  await expect(page.locator(".chip")).toHaveText("approved");
  await expect(page.locator(".drawer")).toHaveCount(0);
  await expect(page.locator(".sec-menu").first()).toBeHidden(); // no anchors to mint
});

test("375px: switcher chips scroll horizontally, navigate, and badge unread", async ({
  page,
  request,
}) => {
  await page.setViewportSize(PHONE);
  const a = await createSession(request, uniqueTitle("switch-a chip overflow"));
  const b = await createSession(request, uniqueTitle("switch-b chip overflow"));
  const c = await createSession(request, uniqueTitle("switch-c chip overflow"));
  await submitFixturePlan(request, a.id, "valid-plan.md");
  await submitFixturePlan(request, b.id, "valid-plan.md");

  await page.goto(`/s/${a.id}`);
  await expect(page.locator("#summary .md")).toBeVisible();

  const chips = page.locator(".switch-chips");
  const chipFor = (s: Session) => chips.locator(".switch-chip", { hasText: s.title.slice(0, 16) });
  await expect(chipFor(a)).toBeVisible();
  await expect(chipFor(a)).toHaveAttribute("aria-current", "page");
  // The current chip leads the strip; the desktop dropdown stays hidden.
  await expect(chips.locator(".switch-chip").first()).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".switch-select")).toBeHidden();

  // Three+ sessions overflow 375px: the strip scrolls, the page does not.
  const metrics = (await page.evaluate(
    `(() => {
      const el = document.querySelector(".switch-chips");
      return { scroll: el.scrollWidth, client: el.clientWidth };
    })()`,
  )) as { scroll: number; client: number };
  expect(metrics.scroll).toBeGreaterThan(metrics.client);
  expect((await page.evaluate("document.documentElement.scrollWidth")) as number).toBeLessThanOrEqual(
    PHONE.width,
  );

  // b has an unseen r1 on this device: its chip wears ●1; c (r0) wears none.
  await expect(chipFor(b).locator(".switch-unread")).toHaveText("●1");
  await expect(chipFor(c).locator(".switch-unread")).toHaveCount(0);

  // Tapping b switches screens in place and clears its badge (now reading it).
  await chipFor(b).scrollIntoViewIfNeeded();
  await chipFor(b).click();
  await expect(page).toHaveURL(`/s/${b.id}`);
  await expect(page.locator(".session-title")).toHaveText(b.title);
  await expect(chipFor(b)).toHaveAttribute("aria-current", "page");
  await expect(chipFor(b).locator(".switch-unread")).toHaveCount(0);

  // Back on a, b stays cleared: seen is per-device state, not chip position.
  await chipFor(a).scrollIntoViewIfNeeded();
  await chipFor(a).click();
  await expect(page).toHaveURL(`/s/${a.id}`);
  await expect(chipFor(b).locator(".switch-unread")).toHaveCount(0);
});

test("clean (real CLI): the session vanishes live from index and switcher; its open screen shows the cleaned state", async ({
  browser,
  request,
}) => {
  const keeper = await createSession(request, uniqueTitle("clean-keeper"));
  const doomed = await createSession(request, uniqueTitle("clean-doomed"));
  await submitFixturePlan(request, doomed.id, "valid-plan.md");
  const approved = await request.post(`/api/sessions/${doomed.id}/approve`, {
    data: { force: true },
  });
  expect(approved.ok()).toBeTruthy();

  const ctx = await browser.newContext({ viewport: PHONE });
  const onDoomed = await ctx.newPage();
  await onDoomed.goto(`/s/${doomed.id}`);
  await expect(onDoomed.locator(".approved-note")).toBeVisible();
  const onIndex = await ctx.newPage();
  await onIndex.goto("/");
  const card = onIndex.locator(".card", { hasText: doomed.title });
  await expect(card).toBeVisible();
  const onKeeper = await ctx.newPage();
  await onKeeper.goto(`/s/${keeper.id}`);
  const doomedChip = onKeeper.locator(".switch-chip", { hasText: doomed.title.slice(0, 16) });
  await expect(doomedChip).toBeVisible();
  await Promise.all([plantMarker(onDoomed), plantMarker(onIndex), plantMarker(onKeeper)]);

  // The REAL CLI cleans from the session's repo: daemon DELETE + archive move.
  const cleaned = await runCli(["clean"], { cwd: doomed.repo });
  expect(cleaned.code).toBe(0);
  const out = JSON.parse(cleaned.stdout) as { cleaned: { session: string }[] };
  expect(out.cleaned.map((entry) => entry.session)).toEqual([doomed.id]);

  // All three screens react live to the `removed` frame — no navigation.
  await expect(card).toHaveCount(0);
  await expect(doomedChip).toHaveCount(0);
  await expect(onDoomed.locator(".empty-title")).toHaveText("session cleaned");
  await expect(onDoomed.locator(".empty-body")).toContainText("otacon clean");
  expect(await readMarker(onDoomed)).toBe(true);
  expect(await readMarker(onIndex)).toBe(true);
  expect(await readMarker(onKeeper)).toBe(true);

  // The keeper screen is untouched, still live on its own stream.
  await expect(onKeeper.locator(".session-title")).toHaveText(keeper.title);
  await ctx.close();
});

test("desktop regression: header strip intact, phone bar controls absent, ⋯ opens a popover", async ({
  page,
  request,
}) => {
  const session = await openReview(page, request, "desktop-strip");
  await ask(request, session.id, "Desktop still routes questions to the queue?");

  // The header instrument strip holds approve; the switcher is a dropdown.
  await expect(page.locator(".review-controls .ctrl-approve")).toBeVisible();
  await expect(page.locator(".switch-select select")).toBeVisible();
  await expect(page.locator(".switch-chips")).toBeHidden();

  // The phone-only bar instruments stay dormant even with a question open.
  await expect(page.locator(".grill-card")).toBeVisible();
  await expect(page.locator(".bar-quest")).toBeHidden();
  await expect(page.locator(".bar-approve")).toBeHidden();

  // ⋯ menus are always available — as a popover here, not a sheet.
  await page.locator("#decisions .sec-menu").click();
  await expect(page.locator(".sec-pop")).toBeVisible();
  await expect(page.locator(".sec-sheet")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".sec-pop")).toHaveCount(0);

  // The dropdown navigates like the chips do.
  const other = await createSession(request, uniqueTitle("desktop-hop"));
  await page.locator(".switch-select select").selectOption(other.id);
  await expect(page).toHaveURL(`/s/${other.id}`);
  await expect(page.locator(".session-title")).toHaveText(other.title);
});

test("tablet band (600px): the phone face and the menu sheet flip together, not at split widths", async ({
  page,
  request,
}) => {
  // 560–639px is the phone face in CSS (chip switcher, sticky bar). The
  // sheet-vs-popover JS threshold (SHEET_VIEWPORT) must match that breakpoint,
  // or the ⋯ here would open a desktop popover anchored off-thumb while the
  // rest of the surface is the phone's. Lock them in lockstep.
  await page.setViewportSize({ width: 600, height: 800 });
  await openReview(page, request, "tablet-band");

  // The phone face is on: chips, not the dropdown.
  await expect(page.locator(".switch-chips")).toBeVisible();
  await expect(page.locator(".switch-select select")).toBeHidden();

  // So the ⋯ menu docks as the thumb-range sheet, never a desktop popover.
  await page.locator("#decisions .sec-menu").click();
  await expect(page.locator(".sec-sheet")).toBeVisible();
  await expect(page.locator(".sec-pop")).toHaveCount(0);
});

test("375px dark: menu sheet, sticky bar, and switcher chips render on the dark scheme", async ({
  page,
  request,
}) => {
  await page.setViewportSize(PHONE);
  await page.emulateMedia({ colorScheme: "dark" });
  const session = await openReview(page, request, "phone-dark");
  await ask(request, session.id, "Dark mode question?");

  await expect(page.locator(".bar-quest .bar-count")).toHaveText("1");
  await expect(page.locator(".bar-approve")).toBeVisible();
  await expect(page.locator(".switch-chips .switch-chip").first()).toBeVisible();

  await page.locator("#summary .sec-menu").click();
  await expect(page.locator(".sec-sheet")).toBeVisible();

  const bg = (await page.evaluate(
    "getComputedStyle(document.querySelector('.sec-sheet')).backgroundColor",
  )) as string;
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
  expect(match).not.toBeNull();
  // The sheet is a dark surface, not a light card pasted onto the dark page.
  expect((Number(match![1]) + Number(match![2]) + Number(match![3])) / 3).toBeLessThan(64);
});
