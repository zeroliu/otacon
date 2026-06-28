// M5b e2e: the review UI phone review surface, against the real daemon and the
// real built CLI. Section ⋯ menus mint section-only anchors ({section}, no
// exact quote) that round-trip to a parked `otacon wait`; the sticky bar is
// the whole one-thumb control surface (❓ queue jump, drawer + send all,
// approve); the ☰ button opens the mobile session sheet (the app-shell list
// below 960px) that navigates and badges unread; `otacon clean` removes a
// session live everywhere. Desktop keeps its header strip + the persistent
// sidebar — the phone controls never show there.

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

  // Jumping from the thread still washes the section (anchor sans quote). The
  // jump lives on the meta row (no quote here), not the card body.
  await thread.locator(".thread-meta").click();
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

  // From deep in the plan, ❓ opens the Interview panel and deep-links the first
  // open question (q1) into reach (the panel is the single grill surface; the
  // open zone is newest-first, so q1 is centered, not the topmost card).
  await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
  await page.locator(".bar-quest").click();
  await expect(page.locator(".interview-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(async () => {
    const box = await page.locator('.iv-zone-open .grill-card[data-iv="q1"]').boundingBox();
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
  const session = await openReview(page, request, "bar-approve");

  const approve = page.locator(".bar-approve");
  await expect(approve).toBeVisible();
  const box = await approve.boundingBox();
  expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);

  await approve.click();
  const sheetBox = await page.locator(".approve-sheet").boundingBox();
  expect(sheetBox).not.toBeNull();
  expect(sheetBox!.y + sheetBox!.height).toBeGreaterThan(PHONE.height * 0.8); // thumb range
  // No open threads, so Save Plan finalizes straight away (no warn). A Save-approve
  // redirects the viewed session home (DECISIONS "Approving the viewed session
  // redirects home").
  await page.locator(".btn-approve", { hasText: "Save Plan" }).click();
  await expect(page).toHaveURL(/\/$/);

  // Re-open it (already over → no redirect): read-only, with the phone control
  // surface (sticky bar approve, section ⋯) gone.
  await page.goto(`/s/${session.id}`);
  await expect(page.locator(".approved-note")).toBeVisible();
  await expect(page.locator(".chip")).toHaveText("approved");
  await expect(page.locator(".drawer")).toHaveCount(0);
  await expect(page.locator(".bar-approve")).toHaveCount(0);
  await expect(page.locator(".sec-menu").first()).toBeHidden(); // no anchors to mint
});

test("375px: the ☰ session sheet lists sessions, navigates, and badges unread", async ({
  page,
  request,
}) => {
  await page.setViewportSize(PHONE);
  const a = await createSession(request, uniqueTitle("switch-a"));
  const b = await createSession(request, uniqueTitle("switch-b"));
  const c = await createSession(request, uniqueTitle("switch-c"));
  await submitFixturePlan(request, a.id, "valid-plan.md");
  await submitFixturePlan(request, b.id, "valid-plan.md");

  await page.goto(`/s/${a.id}`);
  await expect(page.locator("#summary .md")).toBeVisible();

  // Below 960px the sidebar is hidden; the ☰ button opens the session sheet.
  const sheet = page.locator(".ss-sheet");
  const rowFor = (s: Session) => sheet.locator(".sl-row", { hasText: s.title });
  await page.locator(".rh-menu").click();
  await expect(sheet).toBeVisible();
  // The open session is marked current in the list.
  await expect(rowFor(a)).toHaveAttribute("aria-current", "page");
  // b has an unseen r1 on this device: its row wears ●1; c (r0) wears none.
  await expect(rowFor(b).locator(".sl-unread")).toHaveText("●1");
  await expect(rowFor(c).locator(".sl-unread")).toHaveCount(0);

  // Tapping b switches screens in place (and closes the sheet) and clears unread.
  await rowFor(b).click();
  await expect(page).toHaveURL(`/s/${b.id}`);
  await expect(page.locator(".session-title")).toHaveText(b.title);

  // Re-open the sheet: b is now current and its badge cleared (reading it).
  await page.locator(".rh-menu").click();
  await expect(sheet).toBeVisible();
  await expect(rowFor(b)).toHaveAttribute("aria-current", "page");
  await expect(rowFor(b).locator(".sl-unread")).toHaveCount(0);
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

  // The index is the inline session list on phone; the approved doomed sits in
  // the collapsed `approved` disclosure — expand it to reveal the row. Scope to
  // `.app-content`: the (hidden) sidebar list is still in the DOM below 960px, so
  // an unscoped `.sl-*` selector would match both lists.
  const onIndex = await ctx.newPage();
  await onIndex.goto("/");
  const indexList = onIndex.locator(".app-content");
  await indexList.locator(".sl-approved-toggle").click();
  const indexRow = indexList.locator(".sl-approved-rows .sl-row", { hasText: doomed.title });
  await expect(indexRow).toBeVisible();

  // The keeper's nav is the ☰ session sheet; the doomed row lives in its approved
  // disclosure too.
  const onKeeper = await ctx.newPage();
  await onKeeper.goto(`/s/${keeper.id}`);
  await onKeeper.locator(".rh-menu").click();
  await onKeeper.locator(".ss-sheet .sl-approved-toggle").click();
  const sheetRow = onKeeper.locator(".ss-sheet .sl-approved-rows .sl-row", { hasText: doomed.title });
  await expect(sheetRow).toBeVisible();
  await Promise.all([plantMarker(onDoomed), plantMarker(onIndex), plantMarker(onKeeper)]);

  // The REAL CLI cleans from the session's repo: daemon DELETE + archive move.
  const cleaned = await runCli(["clean"], { cwd: doomed.repo });
  expect(cleaned.code).toBe(0);
  const out = JSON.parse(cleaned.stdout) as { cleaned: { session: string }[] };
  expect(out.cleaned.map((entry) => entry.session)).toEqual([doomed.id]);

  // All three screens react live to the `removed` frame — no navigation.
  await expect(indexRow).toHaveCount(0);
  await expect(sheetRow).toHaveCount(0);
  await expect(onDoomed.locator(".empty-title")).toHaveText("session closed");
  await expect(onDoomed.locator(".empty-body")).toContainText("left the codec");
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

  // The header instrument strip holds approve; the desktop nav is the persistent
  // sidebar (the mobile ☰ menu is hidden ≥960px).
  await expect(page.locator(".review-header .ctrl-approve")).toBeVisible();
  await expect(page.locator(".app-sidebar")).toBeVisible();
  await expect(page.locator(".rh-menu")).toBeHidden();

  // The phone-only bar instruments stay dormant even with a question open. The
  // pending question force-opens the Interview panel on load, so the open card is
  // already reachable (no toggle, which would collapse it again).
  await expect(page.locator(".iv-zone-open .grill-card")).toBeVisible();
  await expect(page.locator(".bar-quest")).toBeHidden();
  await expect(page.locator(".bar-approve")).toBeHidden();

  // ⋯ menus are always available — as a popover here, not a sheet.
  await page.locator("#decisions .sec-menu").click();
  await expect(page.locator(".sec-pop")).toBeVisible();
  await expect(page.locator(".sec-sheet")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".sec-pop")).toHaveCount(0);

  // The sidebar navigates between sessions.
  const other = await createSession(request, uniqueTitle("desktop-hop"));
  await page.locator(".app-sidebar .sl-row", { hasText: other.title }).click();
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

  // The phone face is on: the sidebar is hidden (the ☰ session sheet is the nav).
  await expect(page.locator(".app-sidebar")).toBeHidden();
  await expect(page.locator(".rh-menu")).toBeVisible();

  // So the ⋯ menu docks as the thumb-range sheet, never a desktop popover.
  await page.locator("#decisions .sec-menu").click();
  await expect(page.locator(".sec-sheet")).toBeVisible();
  await expect(page.locator(".sec-pop")).toHaveCount(0);
});

test("375px dark: menu sheet, sticky bar, and session menu render on the dark scheme", async ({
  page,
  request,
}) => {
  await page.setViewportSize(PHONE);
  await page.emulateMedia({ colorScheme: "dark" });
  const session = await openReview(page, request, "phone-dark");
  await ask(request, session.id, "Dark mode question?");

  await expect(page.locator(".bar-quest .bar-count")).toHaveText("1");
  await expect(page.locator(".bar-approve")).toBeVisible();
  await expect(page.locator(".rh-menu")).toBeVisible();

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
