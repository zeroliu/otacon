// FINAL UI acceptance (install/update): the human-facing surface, end to end,
// in a real browser against the real built daemon AND the real built CLI. One
// session is driven through the entire agent/reviewer loop — grill → draft → review →
// revise → approve — and every screen a real reviewer touches is asserted:
//   • the sidebar surfaces the session and its live status glyph;
//   • a grill question card is answerable, waking a parked `otacon wait`;
//   • the submitted plan renders as schema'd sections, a real mermaid diagram,
//     and a collapsed Details block with its size badge;
//   • a comment composed in the UI reaches a parked CLI wait;
//   • a new revision raises the changelog banner + diff + gutter markers;
//   • an agent reply lands inline on the open thread, and a thread whose quote a
//     later revision deletes detaches inline (muted quote, no orphan tray);
//   • Approve from the UI flips the screen to its approved read-only state and
//     surfaces the saved project copy under .otacon/plans (plus the home copy).
// Three screenshots (desktop review, phone review, index) are captured to a
// temp dir whose path the run prints, for the orchestrator to surface.
//
// Reuses the shared helpers/CLI harness; runs headless under the same webServer
// (node dist/daemon/main.js, temp OTACON_HOME) as every other *.e2e.ts spec.

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("UI acceptance: the whole agent/reviewer loop renders and round-trips in the browser", async ({
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

  // ── 1. Index surfaces the new session ────────────────────────────────────
  // The app-shell sidebar (≥960px) is the live index: the session shows as a
  // row the moment it registers. Freshly created over the API with no agent on
  // the line yet (no `otacon wait`/`ask` has parked it), its status derivation
  // reads stalled — the brighter "drafting" spinner lights once contact lands.
  await page.goto("/");
  const card = page.locator(".sl-row", { hasText: session.title });
  await expect(card).toBeVisible();
  await expect(card.locator(".sl-glyph")).toHaveAttribute("aria-label", "stalled");

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
  const gcard = page.locator(`.grill-card[data-iv="${qid}"]`);
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
  await expect(page.locator(`.grill-settled[data-iv="${qid}"]`)).toBeVisible();

  // ── 3. Draft: r1 rendered as schema + mermaid + collapsed Details badge ───
  // The decision cites the REAL transcript id — exactly what lint L3 enforces.
  await cliSubmit(
    session.id,
    dir,
    richBase.replace("- D1: RS256 over HS256 [assumed]", `- D1: RS256 over HS256 ← ${qid}`),
  );
  // r1 is a first review, not a re-review: it raises no new-revision banner (the
  // banner renders only from r2 — DECISIONS "banner from r2"). The plan itself
  // lands live over SSE, replacing the grill placeholder — the schema assertions
  // below are the proof it rendered without a reload.
  await expect(page.locator(".rev-fresh")).toHaveCount(0);
  // Schema-aware structure, not markdown soup.
  await expect(page.locator("#summary .section-title")).toHaveText("Summary");
  await expect(page.locator("#phase-1 .phase-name")).toHaveText("Token issuance");
  // Files renders last and labelless, so only Goal + Verification carry a label.
  await expect(page.locator("#phase-1 .field-label")).toHaveText(["Goal", "Verification"]);
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
  // Scroll the section into view first so its text is selectable (the rich-plan
  // dossier is tall); the selection bar itself docks at the bottom edge.
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

  // ── 5. Revise: r2 raises the banner; the agent replies on the open thread ──
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
  // The comment batch in step 4 implicitly marked r1 reviewed (a comment moves
  // the diff baseline — app.ts), so r2's gutter markers + diff baseline off r1:
  // the reworded summary is flagged changed in the clean view.
  await expect(page.locator("#summary.unit-changed")).toHaveCount(1);
  // A revision reply is a *response*, not a close (DECISIONS "a landed reply is a
  // response, not a close" — the reviewer resolves separately): the agent's reply
  // lands inline on the still-open comment card, never collapsing it to a ✓.
  const thread = page.locator(".thread-comment");
  await expect(thread.locator(".thread-answer-body")).toContainText("verifiers hold only");
  await expect(thread.locator(".thread-answer-label")).toContainText("r2");
  await expect(page.locator(".thread-resolved")).toHaveCount(0);
  // The banner's diff shows hunks only where the plan changed (r1 → r2).
  await banner.locator(".btn-ghost", { hasText: "view diff" }).click();
  await expect(page.locator(".plan-diff")).toBeVisible();
  await expect(page.locator(".diff-legend")).toContainText("r1 → r2");
  await expect(page.locator("#summary .dline-add")).toContainText("Replace legacy session-cookie");
  await page.locator(".seg-btn", { hasText: "clean" }).click();
  // Dismiss marks r2 reviewed (lastReviewedRevision → 2), so the NEXT revision's
  // diff and gutter markers baseline off r2.
  await banner.locator(".btn-primary", { hasText: "dismiss" }).click();
  await expect(banner).toHaveCount(0);

  // ── 6. Detach: r3 deletes the quoted text → the thread detaches inline ──────
  await plantMarker(page);
  await cliSubmit(
    session.id,
    dir,
    richBase
      .replace("revision: 1", "revision: 3")
      .replace("- D1: RS256 over HS256 [assumed]\n", "") // deletes the anchored quote
      .replace("Replace session-cookie auth", "Replace the legacy session-cookie auth flow"),
    { changelog: "Dropped the RS256 decision line; retitled the summary." },
  );
  const banner3 = page.locator(".rev-banner");
  await expect(banner3.locator(".rev-label")).toHaveText("r3 received");
  await expect(banner3.locator(".rev-changelog")).toContainText("Dropped the RS256 decision line");
  expect(await readMarker(page)).toBe(true); // banner arrived over SSE
  // Gutter marker on the reworded summary, clean view — the baseline is r2 now.
  await expect(page.locator("#summary.unit-changed")).toHaveCount(1);
  // No orphan tray (DECISIONS "no UI tray, inline & muted"): the detached
  // thread stays inline in the rail with its quote muted (no live text to jump
  // to) beside the ⌀ glyph; the word "orphan" appears nowhere.
  await expect(thread.locator(".thread-quote-muted")).toContainText("RS256 over HS256");
  await expect(thread.locator(".thread-quote-detached")).toBeVisible();
  await expect(page.locator(".rail")).not.toContainText("orphan");
  // The banner's diff baselines off r2 now.
  await banner3.locator(".btn-ghost", { hasText: "view diff" }).click();
  await expect(page.locator(".diff-legend")).toContainText("r2 → r3");
  await page.locator(".seg-btn", { hasText: "clean" }).click();
  await banner3.locator(".btn-primary", { hasText: "dismiss" }).click();

  // ── 7. Approve from the UI → approved read-only state + project-copy path ──
  await page.locator(".ctrl-approve").click();
  const sheet = page.locator(".approve-sheet");
  await expect(sheet).toContainText(".otacon/plans");
  await sheet.locator(".btn-approve").click();
  // The replied-but-unresolved comment still counts as unresolved at approve (a
  // reply is a response, not a close — app.ts), so the sheet flips to its amber
  // warning. Wait for that stage, then force through it ("Save anyway") — the
  // human's path. (No "Send to agent": the thread already has a reply, so there
  // are no open comments to fold in.)
  await expect(sheet).toHaveClass(/approve-warning/);
  await sheet.locator(".btn-force").click();
  // A Save-approve of the viewed session redirects it home on the live
  // approved crossing (DECISIONS "Approving the viewed session redirects home"):
  // the screen leaves /s/:id for the index rather than lingering on a session
  // whose switcher chip is gone.
  await expect(page).toHaveURL(/\/$/);
  // otacon never commits the plan, but it writes a project copy under the repo's
  // .otacon/plans. Poll for it (the write completes before the redirect frame),
  // then assert the rewritten frontmatter + the folded-in interview.
  const plansDir = join(session.repo, ".otacon", "plans");
  let planFiles: string[] = [];
  await expect
    .poll(() => {
      planFiles = existsSync(plansDir)
        ? readdirSync(plansDir).filter((f) => f.endsWith(".md"))
        : [];
      return planFiles.length;
    })
    .toBeGreaterThan(0);
  const artifact = readFileSync(join(plansDir, planFiles[0]!), "utf8");
  expect(artifact).toContain("status: approved");
  expect(artifact).toContain("## Interview");
  expect(artifact).toContain(`### ${qid}`);
  // The daemon refuses mutations on the over (approved) session.
  const refused = await request.post(`/api/sessions/${session.id}/comments`, {
    data: { items: [{ anchor: null, body: "too late" }] },
  });
  expect(refused.status()).toBe(409);

  // 📸 the index after the loop, and the phone review screen of the same plan.
  // Approved (over) sessions fall to the sidebar's collapsed `approved (n)`
  // disclosure; expand it and confirm the session now reads approved.
  await page.goto("/");
  await page.locator(".sl-approved-toggle").click();
  const approvedRow = page.locator(".sl-approved-rows .sl-row", { hasText: session.title });
  await expect(approvedRow).toBeVisible();
  await expect(approvedRow.locator(".sl-glyph")).toHaveAttribute("aria-label", "approved");
  await page.screenshot({ path: join(shotsDir, "03-index.png"), fullPage: true });

  await page.setViewportSize({ width: 375, height: 720 });
  // Opening an already-approved session does NOT redirect (the crossing guard is
  // live-transition only): it renders read-only behind the approved notice, with
  // the mutation surfaces (Approve) gone.
  await page.goto(`/s/${session.id}`);
  await expect(page.locator("#summary .md")).toBeVisible();
  await expect(page.locator(".approved-note")).toBeVisible();
  await expect(page.locator(".ctrl-approve")).toHaveCount(0);
  await page.screenshot({ path: join(shotsDir, "02-phone-review.png"), fullPage: true });

  // Print the screenshot dir so the orchestrator can surface the images.
  console.log(`\n[acceptance] screenshots written to: ${shotsDir}`);
});
