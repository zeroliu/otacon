// FINAL UI acceptance (DESIGN.md §16): the human-facing surface, end to end,
// in a real browser against the real built daemon AND the real built CLI. One
// session is driven through the entire §6 loop — grill → draft → review →
// revise → approve — and every screen a real reviewer touches is asserted:
//   • the index card surfaces the session and its live status chip;
//   • a grill question card is answerable, waking a parked `otacon wait`;
//   • the submitted plan renders as schema'd sections, a real mermaid diagram,
//     and a collapsed Details block with its size badge;
//   • a comment composed in the UI reaches a parked CLI wait;
//   • a new revision raises the changelog banner + diff + gutter markers;
//   • a resolved thread collapses, and a thread whose quote a later revision
//     deletes lands in the orphan tray;
//   • Approve from the UI flips the screen to its approved read-only state and
//     surfaces the docs/plans path.
// Three screenshots (desktop review, phone review, index) are captured to a
// temp dir whose path the run prints, for the orchestrator to surface.
//
// Reuses the shared helpers/CLI harness; runs headless under the same webServer
// (node dist/daemon/main.js, temp OTACON_HOME) as every other *.e2e.ts spec.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { reapCli, runCli } from "./cli.js";
import { createSession, plantMarker, readMarker, selectText, uniqueTitle } from "./helpers.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

test.afterEach(reapCli);

/** Submit `plan` through the REAL CLI (otacon submit), as the agent does. */
async function cliSubmit(
  sessionId: string,
  dir: string,
  plan: string,
  resolutions?: { changelog: string; threads?: Record<string, string> },
): Promise<void> {
  const planPath = join(dir, "plan.md");
  writeFileSync(planPath, plan);
  const args = ["submit", planPath, "--session", sessionId];
  if (resolutions) {
    const resPath = join(dir, "res.json");
    writeFileSync(resPath, JSON.stringify(resolutions));
    args.push("--resolutions", resPath);
  }
  const result = await runCli(args);
  expect(result.code, `otacon submit failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
}

test("UI acceptance: the whole §6 loop renders and round-trips in the browser", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("ui-acceptance"));
  const dir = mkdtempSync(join(tmpdir(), "otacon-ui-accept-"));
  // A discoverable home for the acceptance screenshots; the path is printed at
  // the end so the orchestrator can surface the images.
  const shotsDir = mkdtempSync(join(tmpdir(), "otacon-acceptance-shots-"));
  const richBase = readFileSync(join(fixturesDir, "rich-plan.md"), "utf8").replace(
    "otc_test01",
    session.id,
  );

  // ── 1. Index surfaces the new session, drafting ──────────────────────────
  await page.goto("/");
  const card = page.locator(".card", { hasText: session.title });
  await expect(card).toBeVisible();
  await expect(card.locator(".chip")).toHaveText("agent working");

  // ── 2. Grill: an `otacon ask` card is answerable; it wakes a parked wait ──
  await page.goto(`/s/${session.id}`);
  await expect(page.locator(".review-wait")).toContainText("interviews before it drafts");
  await plantMarker(page);
  const asked = await runCli([
    "ask",
    "--question",
    "Which signing algorithm?",
    "--options",
    "RS256|HS256",
    "--recommend",
    "RS256",
    "--session",
    session.id,
  ]);
  expect(asked.code).toBe(0);
  const qid = (JSON.parse(asked.stdout) as { id: string }).id;
  const gcard = page.locator(`.grill-card[data-q="${qid}"]`);
  await expect(gcard).toBeVisible();
  expect(await readMarker(page)).toBe(true); // arrived over SSE, no reload
  await expect(page.locator(".chip")).toHaveText("questions pending");

  // One chip tap IS the answer; a parked CLI wait receives it.
  const parkedAnswer = runCli(["wait", "--timeout", "30", "--session", session.id]);
  await gcard.locator(".grill-chip").first().click();
  const answerEvent = await parkedAnswer;
  expect(answerEvent.code).toBe(0);
  const ans = JSON.parse(answerEvent.stdout) as { event: string; question: string; choice?: string };
  expect(ans.event).toBe("answer");
  expect(ans.question).toBe(qid);
  expect(ans.choice).toBe("RS256");
  await expect(page.locator(`.grill-settled[data-q="${qid}"]`)).toBeVisible();

  // ── 3. Draft: r1 rendered as schema + mermaid + collapsed Details badge ───
  // The decision cites the REAL transcript id — exactly what lint L3 enforces.
  await cliSubmit(
    session.id,
    dir,
    richBase.replace("- D1: RS256 over HS256 [assumed]", `- D1: RS256 over HS256 ← ${qid}`),
  );
  await expect(page.locator(".session-rev")).toHaveText("r1");
  // Schema-aware structure, not markdown soup.
  await expect(page.locator("#summary .section-title")).toHaveText("Summary");
  await expect(page.locator("#phase-1 .phase-name")).toHaveText("Token issuance");
  await expect(page.locator("#phase-1 .field-label")).toHaveText(["Goal", "Files", "Verification"]);
  // The citation deep-links into the Interview panel; [assumed] wears the veto tag.
  await expect(page.locator(`#decisions a.q-cite[data-q="${qid}"]`)).toHaveText(qid);
  await expect(page.locator("#decisions .assumed-tag")).toHaveCount(1);
  // Details collapsed with an accurate size badge (the linter measured 86 lines).
  await expect(page.locator("#phase-1 .details")).toHaveJSProperty("open", false);
  await expect(page.locator("#phase-1 .details-size")).toHaveText(
    "86 lines · 1 diagram · 2 code blocks",
  );
  await expect(page.locator("#phase-1 .l6-badge")).toHaveText(/over soft cap 80/);
  // The read-path mermaid fence rendered as a real SVG diagram with its labels.
  await expect(page.locator("#summary .diagram-body svg")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#summary .diagram-body svg")).toContainText("issuer");

  // 📸 desktop review screen.
  await page.screenshot({ path: join(shotsDir, "01-desktop-review.png"), fullPage: true });

  // ── 4. Review: a comment composed in the UI reaches a parked CLI wait ─────
  // Scroll the section into view first so the floating selection toolbar lands
  // inside the viewport (the rich-plan dossier is tall).
  await page.locator("#decisions").scrollIntoViewIfNeeded();
  await selectText(page, "#decisions .md", "RS256 over HS256");
  await page.locator(".sel-btn", { hasText: "comment" }).click();
  await page.locator(".composer-input").fill("spell out the rotation story in the decision");
  await page.locator(".composer .btn-ghost", { hasText: "send now" }).click();
  await expect(page.locator(".thread-comment")).toHaveCount(1);
  const parkedComment = runCli(["wait", "--timeout", "30", "--session", session.id]);
  // The send-now above already flushed; the wait drains the queued batch.
  const commentEvent = await parkedComment;
  expect(commentEvent.code).toBe(0);
  const cev = JSON.parse(commentEvent.stdout) as {
    event: string;
    items: { thread: string; anchor: { section: string; exact: string }; body: string }[];
  };
  expect(cev.event).toBe("comments");
  expect(cev.items[0]!.anchor.section).toBe("decisions");
  expect(cev.items[0]!.anchor.exact).toBe("RS256 over HS256");
  const threadId = cev.items[0]!.thread;

  // ── 5. Revise: r2 raises the banner + gutter marker; the thread resolves ──
  await plantMarker(page);
  await cliSubmit(
    session.id,
    dir,
    richBase
      .replace("revision: 1", "revision: 2")
      .replace("- D1: RS256 over HS256 [assumed]", `- D1: RS256 over HS256 ← ${qid}`)
      .replace("Replace session-cookie auth", "Replace legacy session-cookie auth"),
    {
      changelog: "Reworded the summary; documented the key-rotation story inline.",
      threads: { [threadId]: "Added the rotation story — verifiers hold only the public key." },
    },
  );
  const banner = page.locator(".rev-banner");
  await expect(banner).toBeVisible();
  await expect(banner.locator(".rev-label")).toHaveText("r2 received");
  await expect(banner.locator(".rev-changelog")).toContainText("Reworded the summary");
  expect(await readMarker(page)).toBe(true); // banner arrived over SSE
  // Gutter marker on the changed section, clean view.
  await expect(page.locator("#summary.unit-changed")).toHaveCount(1);
  // The resolved thread collapses to its ✓ line; expanding shows the reply.
  const resolved = page.locator(".thread-resolved");
  await expect(resolved).toHaveCount(1);
  await expect(resolved.locator(".resolved-rev")).toHaveText("r2");
  await resolved.locator(".resolved-summary").click();
  await expect(resolved.locator(".thread-answer-body")).toContainText("verifiers hold only");
  // The banner's diff shows hunks only where the plan changed.
  await banner.locator(".btn-ghost", { hasText: "view diff" }).click();
  await expect(page.locator(".plan-diff")).toBeVisible();
  await expect(page.locator(".diff-legend")).toContainText("r1 → r2");
  await expect(page.locator("#summary .dline-add")).toContainText("Replace legacy session-cookie");
  await page.locator(".seg-btn", { hasText: "clean" }).click();
  await banner.locator(".btn-primary", { hasText: "dismiss" }).click();
  await expect(banner).toHaveCount(0);

  // ── 6. Orphan tray: r3 deletes the quoted text → the thread orphans live ──
  await plantMarker(page);
  await cliSubmit(
    session.id,
    dir,
    richBase
      .replace("revision: 1", "revision: 3")
      .replace("- D1: RS256 over HS256 [assumed]\n", "") // deletes the anchored quote
      .replace("Replace session-cookie auth", "Replace legacy session-cookie auth"),
    { changelog: "Dropped the RS256 decision line." },
  );
  const tray = page.locator(".orphan-toggle");
  await expect(tray).toBeVisible();
  await expect(tray.locator(".orphan-count")).toHaveText("1");
  await tray.click();
  const orphan = page.locator(".orphan");
  await expect(orphan).toHaveCount(1);
  await expect(orphan.locator(".thread-quote")).toContainText("RS256 over HS256");
  await expect(orphan.locator(".orphan-where")).toHaveText("#decisions");

  // ── 7. Approve from the UI → approved read-only state + docs/plans path ───
  await page.locator(".ctrl-approve").click();
  const sheet = page.locator(".approve-sheet");
  await expect(sheet).toContainText("docs/plans/");
  await sheet.locator(".btn-approve").click();
  // The lone orphaned (resolved) thread is not an open thread, but the orphan
  // tray keeps it; if approve warns, force through it — the human's path.
  if (await sheet.locator(".btn-force").isVisible().catch(() => false)) {
    await sheet.locator(".btn-force").click();
  }
  const note = page.locator(".approved-note");
  await expect(note).toBeVisible();
  await expect(page.locator(".chip")).toHaveText("approved");
  const noted = await note.locator(".approved-path").textContent();
  const relPath = /docs\/plans\/\S+\.md/.exec(noted ?? "")?.[0];
  expect(relPath, "approved note surfaces the docs/plans path").toBeTruthy();
  // The artifact is on disk in the session's repo with the rewritten frontmatter.
  const artifact = readFileSync(join(session.repo, relPath!), "utf8");
  expect(artifact).toContain("status: approved");
  expect(artifact).toContain("## Interview");
  expect(artifact).toContain(`### ${qid}`);
  // Read-only: the mutation surfaces are gone, and the daemon refuses mutations.
  await expect(page.locator(".ctrl-approve")).toHaveCount(0);
  const refused = await request.post(`/api/sessions/${session.id}/comments`, {
    data: { items: [{ anchor: null, body: "too late" }] },
  });
  expect(refused.status()).toBe(409);

  // 📸 the index after the loop, and the phone review screen of the same plan.
  await page.goto("/");
  await expect(page.locator(".card", { hasText: session.title }).locator(".chip")).toHaveText(
    "approved",
  );
  await page.screenshot({ path: join(shotsDir, "03-index.png"), fullPage: true });

  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto(`/s/${session.id}`);
  await expect(page.locator("#summary .md")).toBeVisible();
  await page.screenshot({ path: join(shotsDir, "02-phone-review.png"), fullPage: true });

  // Print the screenshot dir so the orchestrator can surface the images.
  console.log(`\n[acceptance] screenshots written to: ${shotsDir}`);
});
