// M3b e2e: the full revision loop through a real browser, the real daemon,
// AND the real built CLI — r1 submitted by the CLI, a comment anchored
// through the UI, r2 resubmitted with resolutions + changelog, and the
// re-review layer asserted live over SSE: the changelog banner, dismiss
// moving the daemon's last-reviewed baseline, gutter markers, the [clean|diff]
// toggle with its baseline picker, j/k jumps, the resolved thread's reply,
// and a thread orphaned by r4 landing in the tray. Dark + 375px smokes ride
// the HTTP fixtures for speed; the loop itself is CLI-driven end to end.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { reapCli, runCli } from "./cli.js";
import type { Session } from "./helpers.js";
import {
  createSession,
  plantMarker,
  readMarker,
  selectText,
  submitFixturePlan,
  uniqueTitle,
} from "./helpers.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

test.afterEach(reapCli);

/** Submit the current plan text through the REAL CLI (otacon submit). */
async function cliSubmit(
  session: Session,
  dir: string,
  plan: string,
  resolutions?: { changelog: string; threads?: Record<string, string> },
): Promise<void> {
  const planPath = join(dir, "plan.md");
  writeFileSync(planPath, plan);
  const args = ["submit", planPath, "--session", session.id];
  if (resolutions) {
    const resPath = join(dir, "res.json");
    writeFileSync(resPath, JSON.stringify(resolutions));
    args.push("--resolutions", resPath);
  }
  const result = await runCli(args);
  expect(result.code, `otacon submit failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
}

/** Mean channel 0–255; reads rgb() and the color(srgb …) color-mix produces. */
async function luminance(page: Page, expression: string): Promise<number> {
  const color = (await page.evaluate(expression)) as string;
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (rgb) return (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 3;
  const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(color);
  if (srgb) return ((Number(srgb[1]) + Number(srgb[2]) + Number(srgb[3])) / 3) * 255;
  throw new Error(`unparseable color: ${color}`);
}

test("the revision loop: banner, dismiss, diff + j/k, resolution, orphan tray", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("revloop"));
  const dir = mkdtempSync(join(tmpdir(), "otacon-ui-e2e-rev-"));
  let plan = readFileSync(join(fixturesDir, "valid-plan.md"), "utf8").replace(
    "otc_test01",
    session.id,
  );

  // r1 through the real CLI; first review has no re-review layer to show.
  await cliSubmit(session, dir, plan);
  await page.goto(`/s/${session.id}`);
  await expect(page.locator("#summary .md")).toBeVisible();
  await expect(page.locator(".rev-banner")).toHaveCount(0);
  await expect(page.locator(".unit-changed")).toHaveCount(0);

  // Comment through the UI (send now flushes immediately — and commenting IS
  // reviewing, so the daemon marks r1 as the baseline, threaded review and revision).
  await selectText(page, "#decisions .md", "RS256 over HS256");
  await page.locator(".sel-btn", { hasText: "comment" }).click();
  await page.locator(".composer-input").fill("justify the choice in the decision");
  await page.locator(".composer .btn-ghost", { hasText: "send now" }).click();
  await expect(page.locator(".thread-comment")).toHaveCount(1);
  await plantMarker(page);

  // r2 (real CLI): one summary edit, the resolution for t1, and a changelog.
  plan = plan.replace("Replace session-cookie auth", "Replace legacy session-cookie auth");
  await cliSubmit(session, dir, plan, {
    changelog: "Reworded the summary; kept RS256 with the rationale inline.",
    threads: { t1: "Added the rationale — verifiers hold only the public key." },
  });

  // The banner lands live with the agent's changelog — no reload.
  const banner = page.locator(".rev-banner");
  await expect(banner).toBeVisible();
  await expect(banner.locator(".rev-label")).toHaveText("r2 received");
  await expect(banner.locator(".rev-changelog")).toHaveText(
    "Reworded the summary; kept RS256 with the rationale inline.",
  );
  expect(await readMarker(page)).toBe(true);

  // Gutter marker ▌ on the changed section — clean view, only that section.
  await expect(page.locator(".unit-changed")).toHaveCount(1);
  await expect(page.locator("#summary.unit-changed")).toHaveCount(1);

  // The resolved thread collapses to its ✓ line; expanding shows the reply.
  const resolved = page.locator(".thread-resolved");
  await expect(resolved).toHaveCount(1);
  await expect(resolved.locator(".resolved-rev")).toHaveText("r2");
  await expect(resolved.locator(".thread-answer-body")).not.toBeVisible();
  await resolved.locator(".resolved-summary").click();
  await expect(resolved.locator(".thread-answer-body")).toHaveText(
    "Added the rationale — verifiers hold only the public key.",
  );

  // The banner's "view diff": hunks only where the plan changed.
  await banner.locator(".btn-ghost", { hasText: "view diff" }).click();
  await expect(page.locator(".plan-diff")).toBeVisible();
  await expect(page.locator(".diff-legend")).toContainText("r1 → r2");
  await expect(page.locator(".diff-body")).toHaveCount(1);
  await expect(page.locator("#summary .diff-status")).toHaveText("changed");
  await expect(page.locator("#summary .dline-del")).toContainText("Replace session-cookie auth");
  await expect(page.locator("#summary .dline-add")).toContainText(
    "Replace legacy session-cookie auth",
  );
  await expect(page.locator("#decisions .diff-body")).toHaveCount(0); // collapsed-calm

  // Dismiss moves the baseline on the daemon; the markers clear.
  await page.locator(".seg-btn", { hasText: "clean" }).click();
  await banner.locator(".btn-primary", { hasText: "dismiss" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator(".unit-changed")).toHaveCount(0);
  const detail = await request.get(`/api/sessions/${session.id}`);
  expect(((await detail.json()) as { lastReviewedRevision: number }).lastReviewedRevision).toBe(2);

  // r3 changes exactly one other section (unprompted — no comment asked).
  plan = plan.replace(
    "Clock skew between issuer and verifiers may reject fresh tokens.",
    "Clock skew between issuer and verifiers may reject fresh tokens; allow 30s leeway.",
  );
  await cliSubmit(session, dir, plan, { changelog: "Risks now allow 30s clock-skew leeway." });
  await expect(page.locator(".rev-banner .rev-label")).toHaveText("r3 received");
  await expect(page.locator(".unit-changed")).toHaveCount(1);
  await expect(page.locator("#risks.unit-changed")).toHaveCount(1);

  // Diff vs last-reviewed (r2) flags risks alone; the baseline picker widens
  // the comparison to r1 and the gutter markers follow the same baseline.
  await page.locator(".seg-btn", { hasText: "diff" }).click();
  await expect(page.locator(".diff-legend")).toContainText("r2 → r3");
  await expect(page.locator(".diff-body")).toHaveCount(1);
  await expect(page.locator("#risks .dline-add")).toContainText("allow 30s leeway");
  await page.locator(".baseline select").selectOption("1");
  await expect(page.locator(".diff-legend")).toContainText("r1 → r3");
  await expect(page.locator(".diff-body")).toHaveCount(2); // summary + risks
  await page.locator(".seg-btn", { hasText: "clean" }).click();
  await expect(page.locator(".unit-changed")).toHaveCount(2);

  // j/k walk the changed sections in plan order.
  await page.keyboard.press("j");
  await expect(page.locator("#summary.anchor-hit")).toHaveCount(1);
  await page.keyboard.press("j");
  await expect(page.locator("#risks.anchor-hit")).toHaveCount(1);
  await expect(page.locator("#summary.anchor-hit")).toHaveCount(0);
  await page.keyboard.press("k");
  await expect(page.locator("#summary.anchor-hit")).toHaveCount(1);

  // r4 deletes the quoted decision text: the thread orphans into the tray,
  // live over the SSE thread frame — never silently dropped (plan structure, lint, and anchoring).
  plan = plan.replace("- D1: RS256 over HS256 [assumed]\n", "");
  await cliSubmit(session, dir, plan, { changelog: "Dropped the RS256 decision line." });
  const tray = page.locator(".orphan-toggle");
  await expect(tray).toBeVisible();
  await expect(tray.locator(".orphan-count")).toHaveText("1");
  await expect(page.locator(".thread-resolved")).toHaveCount(0); // moved out of the rail list
  await tray.click();
  const orphan = page.locator(".orphan");
  await expect(orphan).toHaveCount(1);
  await expect(orphan.locator(".thread-quote")).toContainText("RS256 over HS256");
  await expect(orphan.locator(".orphan-where")).toHaveText("#decisions");
  await orphan.click(); // the full original anchor text + the old resolution
  await expect(orphan).toHaveClass(/orphan-open/);
  await expect(orphan.locator(".thread-answer-body")).toContainText(
    "verifiers hold only the public key",
  );
});

async function seedRevisedSession(
  request: APIRequestContext,
  label: string,
): Promise<Session> {
  const session = await createSession(request, uniqueTitle(label));
  await submitFixturePlan(request, session.id, "valid-plan.md");
  // A comment whose quoted text r2 deletes: marks r1 reviewed AND orphans.
  const res = await request.post(`/api/sessions/${session.id}/comments`, {
    data: {
      items: [
        {
          anchor: { section: "risks", exact: "Key rotation downtime" },
          body: "what's the mitigation?",
        },
      ],
    },
  });
  expect(res.status()).toBe(202);
  // One section (risks) changes: a deleted line (orphaning t1's quote) plus
  // an edited one, so the diff carries both del and add inks to assert on.
  await submitFixturePlan(
    request,
    session.id,
    "valid-plan.md",
    (plan) =>
      plan
        .replace("revision: 1", "revision: 2")
        .replace("- Key rotation downtime if the keychain is unavailable at boot.\n", "")
        .replace("may reject fresh tokens.", "may reject fresh tokens; allow 30s leeway."),
    {
      changelog: "Dropped the keychain risk — rotation is scheduled re-issue now.",
      threads: { t1: "Removed entirely; rotation became scheduled re-issue." },
    },
  );
  return session;
}

test("dark scheme: banner and diff inks stay legible", async ({ page, request }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const session = await seedRevisedSession(request, "revdark");
  await page.goto(`/s/${session.id}`);

  // On-load path: lastReviewedRevision < revision shows the banner.
  await expect(page.locator(".rev-banner")).toBeVisible();
  await expect(page.locator(".rev-changelog")).toContainText("scheduled re-issue");
  expect(await luminance(page, "getComputedStyle(document.body).backgroundColor")).toBeLessThan(64);

  await page.locator(".rev-banner .btn-ghost", { hasText: "view diff" }).click();
  await expect(page.locator(".dline-del").first()).toBeVisible();
  await expect(page.locator(".dline-add").first()).toBeVisible();
  // The add/del inks resolve to the dark palette and stay distinct…
  const addInk = (await page.evaluate(
    "getComputedStyle(document.querySelector('.dline-add .dline-op')).color",
  )) as string;
  const delInk = (await page.evaluate(
    "getComputedStyle(document.querySelector('.dline-del .dline-op')).color",
  )) as string;
  expect(addInk).not.toBe(delInk);
  // …and the text on a washed del line keeps light-on-dark contrast.
  expect(
    await luminance(page, "getComputedStyle(document.querySelector('.dline-del .dline-text')).color"),
  ).toBeGreaterThan(110);
});

test("375px: banner, markers, diff, and the orphan tray hold the column", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 375, height: 720 });
  const session = await seedRevisedSession(request, "revphone");
  await page.goto(`/s/${session.id}`);

  await expect(page.locator(".rev-banner")).toBeVisible();
  await expect(page.locator("#risks.unit-changed")).toHaveCount(1);
  await page.locator(".orphan-toggle").click();
  await expect(page.locator(".orphan")).toHaveCount(1);
  expect((await page.evaluate("document.documentElement.scrollWidth")) as number).toBeLessThanOrEqual(
    375,
  );

  await page.locator(".seg-btn", { hasText: "diff" }).click();
  await expect(page.locator(".diff-body")).toHaveCount(1);
  await expect(page.locator(".baseline select")).toBeVisible();
  expect((await page.evaluate("document.documentElement.scrollWidth")) as number).toBeLessThanOrEqual(
    375,
  );
});
