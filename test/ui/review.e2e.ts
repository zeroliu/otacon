// Review screen e2e: the rich-plan fixture goes through the REAL submit
// endpoint (lint included — its Phase 1 Details intentionally trips L6) and
// the dossier rendering is asserted in a real browser. Badge numbers are
// hard-coded from the fixture on purpose: the linter reports Phase 1 Details
// as 86 lines, and the UI badge must quote the same measure.

import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { createSession, plantMarker, readMarker, submitFixturePlan, uniqueTitle } from "./helpers.js";

const submitRichPlan = (
  request: APIRequestContext,
  id: string,
  revision = 1,
  mutate: (plan: string) => string = (plan) => plan,
) =>
  submitFixturePlan(
    request,
    id,
    "rich-plan.md",
    (plan) => mutate(plan.replace("revision: 1", `revision: ${revision}`)),
    // Revisions ≥ 2 must carry a changelog (lint L5, M3).
    revision >= 2 ? { changelog: `revision ${revision} for the e2e suite` } : undefined,
  );

const SLUG_IDS = [
  "summary",
  "decisions",
  "phases",
  "risks",
  "open-questions",
  "phase-1",
  "phase-2",
];

test("the dossier renders the plan schema under stable slug ids", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("dossier"));
  await submitRichPlan(request, session.id);
  await page.goto(`/s/${session.id}`);

  // The anchoring contract (plan structure, lint, and anchoring): slugged section ids + phase-<n>.
  for (const id of SLUG_IDS) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }

  // Schema-aware structure, not markdown soup: rails, phase heads, field labels.
  await expect(page.locator("#summary .section-title")).toHaveText("Summary");
  await expect(page.locator("#phase-1 .phase-name")).toHaveText("Token issuance");
  await expect(page.locator("#phase-1 .phase-n")).toHaveText("01");
  await expect(page.locator("#phase-1 .field-label")).toHaveText(["Goal", "Files", "Verification"]);
  await expect(page.locator("#decisions .md li").first()).toContainText("RS256 over HS256");
  await expect(page.locator("#phase-1 .field-files .field-value")).toContainText(
    "src/auth/issuer.ts",
  );

  // Details are collapsed by default, with accurate size badges (the linter
  // measured Phase 1 at 86 raw lines — the badge must quote the same number).
  await expect(page.locator("#phase-1 .details")).toHaveJSProperty("open", false);
  await expect(page.locator("#phase-2 .details")).toHaveJSProperty("open", false);
  await expect(page.locator("#phase-1 .details-body")).not.toBeVisible();
  await expect(page.locator("#phase-1 .details-size")).toHaveText(
    "86 lines · 1 diagram · 2 code blocks",
  );
  await expect(page.locator("#phase-2 .details-size")).toHaveText("18 lines · 3 code blocks");

  // The L6 warning rides the offending Details block — and only that one.
  await expect(page.locator("#phase-1 .l6-badge")).toHaveText(/over soft cap 80/);
  await expect(page.locator("#phase-2 .l6-badge")).toHaveCount(0);

  // The Summary's read-path mermaid fence rendered as an actual diagram —
  // including its node labels (DOMPurify strips foreignObject, so labels must
  // come out of mermaid as plain SVG text; see the htmlLabels note in code.tsx).
  await expect(page.locator("#summary .diagram-body svg")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#summary .diagram-body svg")).toContainText("issuer");
});

test("Details expand to highlighted code, diagrams, and side-by-side pairs", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("expand"));
  await submitRichPlan(request, session.id);
  await page.goto(`/s/${session.id}`);

  await page.locator("#phase-1 .details-summary").click();
  await expect(page.locator("#phase-1 .details")).toHaveJSProperty("open", true);
  await expect(page.locator("#phase-1 .details-body")).toBeVisible();
  // Syntax highlighting produced real token spans, not flat text.
  await expect(page.locator("#phase-1 .details-body .hljs-keyword").first()).toBeVisible();
  // The Details-only mermaid fence rendered too.
  await expect(page.locator("#phase-1 .diagram-body svg")).toBeVisible({ timeout: 20_000 });

  await page.locator("#phase-2 .details-summary").click();
  const before = page.locator("#phase-2 .pair-before");
  const after = page.locator("#phase-2 .pair-after");
  await expect(before.locator(".fence-head")).toHaveText("before · ts");
  await expect(after.locator(".fence-head")).toHaveText("after · ts");
  await expect(before).toContainText("cookieSession");
  await expect(after).toContainText("jwtVerify");

  // Side-by-side on a desktop viewport: same row, after to the right.
  const beforeBox = await before.boundingBox();
  const afterBox = await after.boundingBox();
  expect(beforeBox).not.toBeNull();
  expect(afterBox).not.toBeNull();
  expect(Math.abs(beforeBox!.y - afterBox!.y)).toBeLessThan(2);
  expect(afterBox!.x).toBeGreaterThanOrEqual(beforeBox!.x + beforeBox!.width);

  // The ASCII wireframe stays a monospace fence (the lone direct fence here).
  await expect(page.locator("#phase-2 .details-body > .fence .fence-head")).toHaveText("text");
  await expect(page.locator("#phase-2 .details-body > .fence pre")).toContainText("+--------+");
});

test("a new revision lands live over SSE, without a reload", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("liverev"));
  await submitRichPlan(request, session.id);
  await page.goto(`/s/${session.id}`);
  // The fresh new-revision banner carries the landed revision (the r0 header
  // pill is gone): r1 received on first load, then r2 when the revision lands.
  await expect(page.locator(".rev-fresh .rev-label")).toHaveText("r1 received");
  await expect(page.locator("#summary .md")).toContainText("Replace session-cookie auth");
  await plantMarker(page);

  await submitRichPlan(request, session.id, 2, (plan) =>
    plan.replace("Replace session-cookie auth", "Revised again: replace session-cookie auth"),
  );

  await expect(page.locator(".rev-fresh .rev-label")).toHaveText("r2 received");
  await expect(page.locator("#summary .md")).toContainText("Revised again");
  expect(await readMarker(page)).toBe(true); // no navigation happened
});

async function backgroundLuminance(page: Page, expression: string): Promise<number> {
  const bg = (await page.evaluate(expression)) as string;
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
  if (!match) throw new Error(`unparseable background color: ${bg}`);
  return (Number(match[1]) + Number(match[2]) + Number(match[3])) / 3;
}

test("dark scheme renders the dossier", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("darkdossier"));
  await submitRichPlan(request, session.id);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/s/${session.id}`);

  await expect(page.locator("#summary .section-title")).toBeVisible();
  expect(
    await backgroundLuminance(page, "getComputedStyle(document.body).backgroundColor"),
  ).toBeLessThan(64);

  // Code surfaces follow the scheme: expand a fence and check its background.
  await page.locator("#phase-1 .details-summary").click();
  await expect(page.locator("#phase-1 .details-body .hljs-keyword").first()).toBeVisible();
  expect(
    await backgroundLuminance(
      page,
      "getComputedStyle(document.querySelector('#phase-1 .details-body .fence')).backgroundColor",
    ),
  ).toBeLessThan(64);
});

test("phone viewport: readable, stacked pairs, no horizontal scroll", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 375, height: 720 });
  const session = await createSession(request, uniqueTitle("phone"));
  await submitRichPlan(request, session.id);
  await page.goto(`/s/${session.id}`);

  await expect(page.locator("#summary .md")).toBeVisible();
  await expect(page.locator("#phase-1 .details-size")).toBeVisible();

  // Pairs stack vertically on a phone.
  await page.locator("#phase-2 .details-summary").click();
  const beforeBox = await page.locator("#phase-2 .pair-before").boundingBox();
  const afterBox = await page.locator("#phase-2 .pair-after").boundingBox();
  expect(beforeBox).not.toBeNull();
  expect(afterBox).not.toBeNull();
  expect(afterBox!.y).toBeGreaterThanOrEqual(beforeBox!.y + beforeBox!.height);
  expect(Math.abs(afterBox!.x - beforeBox!.x)).toBeLessThan(2);

  // Long Details, wide code, ASCII art: the page itself never scrolls sideways.
  await page.locator("#phase-1 .details-summary").click();
  await expect(page.locator("#phase-1 .details-body")).toBeVisible();
  const scrollWidth = (await page.evaluate("document.documentElement.scrollWidth")) as number;
  expect(scrollWidth).toBeLessThanOrEqual(375);
});
