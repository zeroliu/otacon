// M4b e2e: the grill + approve surfaces round-trip through a real browser,
// the real daemon, AND the real built CLI — `otacon ask` raises a question
// card live (pre-plan: the grill happens before drafting), chip taps and free
// text wake a parked `otacon wait` with the answer event, decision citations
// deep-link into the Interview panel, and Approve warns on unresolved threads
// before force writes the docs/plans/ artifact and locks the session.

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

test.afterEach(reapCli);

/** POST /ask through the real API; returns the minted q<n> id. */
async function ask(
  request: APIRequestContext,
  id: string,
  body: { question: string; options?: string[]; recommend?: string; multi?: boolean },
): Promise<string> {
  const res = await request.post(`/api/sessions/${id}/ask`, { data: body });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function answer(
  request: APIRequestContext,
  id: string,
  body: { question: string; choice?: string; choices?: string[]; text?: string },
): Promise<void> {
  const res = await request.post(`/api/sessions/${id}/answers`, { data: body });
  expect(res.status()).toBe(202);
}

test("pre-plan grill: `otacon ask` raises a live card, recommended chip first, one tap answers the parked wait", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("grill-flow"));
  await page.goto(`/s/${session.id}`);
  // Zero revisions: the screen is already useful — the wait copy says so.
  await expect(page.locator(".review-wait")).toContainText("interviews before it drafts");
  await expect(page.locator(".chip")).toHaveText("agent working");
  await plantMarker(page);

  // The REAL CLI asks; the card lands over SSE, no reload.
  const asked = await runCli([
    "ask",
    "--question",
    "Token algorithm?",
    "--options",
    "RS256|HS256",
    "--recommend",
    "HS256",
    "--session",
    session.id,
  ]);
  expect(asked.code).toBe(0);
  const qid = (JSON.parse(asked.stdout) as { id: string }).id;
  expect(qid).toBe("q1");

  const card = page.locator(`.grill-card[data-q="${qid}"]`);
  await expect(card).toBeVisible();
  expect(await readMarker(page)).toBe(true); // SSE, not a navigation
  await expect(page.locator(".grill-open-count")).toHaveText("1 open");
  // The chip flips to your-move state while a question is open (§10).
  await expect(page.locator(".chip")).toHaveText("questions pending");

  // Recommended option leads the row and wears the star, despite the agent
  // listing it second (DESIGN.md §8).
  const chips = card.locator(".grill-chip");
  await expect(chips.first()).toHaveClass(/grill-chip-rec/);
  await expect(chips.first().locator(".grill-chip-label")).toHaveText("HS256");
  await expect(chips.nth(1).locator(".grill-chip-label")).toHaveText("RS256");

  // Optional note rides the chip tap.
  await card.locator(".grill-note-toggle").click();
  await card.locator(".grill-note").fill("prefer the simpler one");

  // Park the agent on wait; a single chip tap IS the answer (no confirm step).
  const parked = runCli(["wait", "--timeout", "30", "--session", session.id]);
  await chips.first().click();

  const result = await parked;
  expect(result.code).toBe(0);
  const event = JSON.parse(result.stdout) as {
    event: string;
    question: string;
    choice?: string;
    text?: string;
  };
  expect(event.event).toBe("answer");
  expect(event.question).toBe(qid);
  expect(event.choice).toBe("HS256");
  expect(event.text).toBe("prefer the simpler one");

  // The card settles in place — the flip is the confirmation.
  const settled = page.locator(`.grill-settled[data-q="${qid}"]`);
  await expect(settled).toBeVisible();
  await expect(settled.locator(".settled-choice")).toHaveText("HS256");
  await expect(page.locator(".grill-open-count")).toHaveCount(0);
  await expect(page.locator(".chip")).toHaveText("agent working");
});

test("multi-select toggles chips and arms a send; free text answers optionless questions", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("grill-variants"));
  const multiId = await ask(request, session.id, {
    question: "Which signals matter?",
    options: ["logs", "metrics", "traces"],
    recommend: "logs",
    multi: true,
  });
  const textId = await ask(request, session.id, { question: "Name the rollout flag?" });
  await page.goto(`/s/${session.id}`);

  // Multi: chips toggle (no instant fire); send stays disabled until a pick.
  const multiCard = page.locator(`.grill-card[data-q="${multiId}"]`);
  await expect(multiCard.locator(".grill-mode")).toHaveText("pick any");
  const send = multiCard.locator(".grill-send");
  await expect(send).toBeDisabled();
  await multiCard.locator(".grill-chip", { hasText: "traces" }).click();
  await multiCard.locator(".grill-chip", { hasText: "logs" }).click();
  await expect(multiCard.locator('.grill-chip[aria-pressed="true"]')).toHaveCount(2);
  await expect(send).toBeEnabled();

  let parked = runCli(["wait", "--timeout", "30", "--session", session.id]);
  await send.click();
  let result = await parked;
  expect(result.code).toBe(0);
  const multiEvent = JSON.parse(result.stdout) as { question: string; choices?: string[] };
  expect(multiEvent.question).toBe(multiId);
  expect(multiEvent.choices).toEqual(["traces", "logs"]); // tap order preserved
  await expect(page.locator(`.grill-settled[data-q="${multiId}"] .settled-choice`)).toHaveText(
    "traces, logs",
  );

  // Free text: the textarea is the whole answer; send arms on content.
  const textCard = page.locator(`.grill-card[data-q="${textId}"]`);
  await expect(textCard.locator(".grill-mode")).toHaveText("free text");
  await expect(textCard.locator(".grill-send")).toBeDisabled();
  await textCard.locator(".grill-text").fill("jwt_rollout_q3");
  parked = runCli(["wait", "--timeout", "30", "--session", session.id]);
  await textCard.locator(".grill-send").click();
  result = await parked;
  expect(result.code).toBe(0);
  const textEvent = JSON.parse(result.stdout) as { question: string; text?: string };
  expect(textEvent.question).toBe(textId);
  expect(textEvent.text).toBe("jwt_rollout_q3");

  // Both cards stay settled on this mount; nothing is open anymore.
  await expect(page.locator(".grill-settled")).toHaveCount(2);
  await expect(page.locator(".grill-open-count")).toHaveCount(0);
});

test("option cards take a chip-less custom answer: single 'send custom', multi text-only", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("custom-answer"));
  const singleId = await ask(request, session.id, {
    question: "Which scope?",
    options: ["just the fix", "both"],
    recommend: "just the fix",
  });
  const multiId = await ask(request, session.id, {
    question: "Which signals?",
    options: ["logs", "metrics"],
    multi: true,
  });
  await page.goto(`/s/${session.id}`);

  // Single-select: the note box doubles as the custom-answer field — typed
  // text alone, no chip, is a valid answer (native-"Other" parity).
  const single = page.locator(`.grill-card[data-q="${singleId}"]`);
  await expect(single.locator(".grill-foot")).toHaveCount(0); // no foot until a custom answer opens
  await single.locator(".grill-note-toggle").click();
  const custom = single.locator(".grill-send");
  await expect(custom).toHaveText("send custom");
  await expect(custom).toBeDisabled();
  await single.locator(".grill-note").fill("none of these — ship neither yet");

  let parked = runCli(["wait", "--timeout", "30", "--session", session.id]);
  await custom.click();
  let result = await parked;
  expect(result.code).toBe(0);
  let event = JSON.parse(result.stdout) as { question: string; choice?: string; text?: string };
  expect(event.question).toBe(singleId);
  expect(event.choice).toBeUndefined(); // text-only, no chip
  expect(event.text).toBe("none of these — ship neither yet");
  await expect(page.locator(`.grill-settled[data-q="${singleId}"]`)).toBeVisible();

  // Multi-select: send arms on non-empty custom text even with no chip picked.
  const multi = page.locator(`.grill-card[data-q="${multiId}"]`);
  const send = multi.locator(".grill-send");
  await expect(send).toBeDisabled();
  await multi.locator(".grill-note-toggle").click();
  await multi.locator(".grill-note").fill("trace spans, actually");
  await expect(send).toBeEnabled();

  parked = runCli(["wait", "--timeout", "30", "--session", session.id]);
  await send.click();
  result = await parked;
  expect(result.code).toBe(0);
  event = JSON.parse(result.stdout) as { question: string; text?: string } & { choices?: string[] };
  expect(event.question).toBe(multiId);
  expect((event as { choices?: string[] }).choices).toBeUndefined();
  expect(event.text).toBe("trace spans, actually");
});

test("the Interview archive renders a chip-less custom answer: no option highlighted, custom text echoed", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("custom-archive"));
  const qid = await ask(request, session.id, {
    question: "Which store?",
    options: ["sqlite", "json"],
    recommend: "sqlite",
  });
  // "Other" parity (DESIGN.md §8): answer an option question with text alone.
  await answer(request, session.id, { question: qid, text: "postgres, actually" });
  await page.goto(`/s/${session.id}`);

  await page.locator(".interview-toggle").click();
  const entry = page.locator(`.iv-entry[data-iv="${qid}"]`);
  await expect(entry).toBeVisible();
  // The offered options still show, but none is marked chosen — the answer was
  // custom — and the typed text is echoed as what the user actually said.
  await expect(entry.locator(".iv-opt")).toHaveCount(2);
  await expect(entry.locator(".iv-opt-chosen")).toHaveCount(0);
  await expect(entry.locator(".iv-answer-body")).toHaveText("postgres, actually");
});

test("decision citations deep-link into the Interview panel; [assumed] wears the veto tag", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("deep-link"));
  const qid = await ask(request, session.id, {
    question: "Which signing algorithm?",
    options: ["RS256", "HS256"],
    recommend: "RS256",
  });
  await answer(request, session.id, {
    question: qid,
    choice: "RS256",
    text: "keys rotate quarterly",
  });
  // The plan cites the REAL transcript id — exactly what lint L3 enforces.
  await submitFixturePlan(request, session.id, "valid-plan.md", (plan) =>
    plan.replace("- D1: RS256 over HS256 [assumed]", `- D1: RS256 over HS256 ← ${qid}`),
  );
  await page.goto(`/s/${session.id}`);

  // The citation renders as a deep-link; D2's [assumed] becomes the quiet tag.
  const cite = page.locator(`#decisions a.q-cite[data-q="${qid}"]`);
  await expect(cite).toHaveText(qid);
  const assumed = page.locator("#decisions .assumed-tag");
  await expect(assumed).toHaveCount(1);
  await expect(assumed).toHaveAttribute("title", /veto me/);

  // Collapsed panel announces the tally; the citation opens it at the entry.
  const toggle = page.locator(".interview-toggle");
  await expect(toggle).toContainText("1/1 answered");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await cite.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const entry = page.locator(`.iv-entry[data-iv="${qid}"]`);
  await expect(entry).toBeVisible();
  await expect(entry).toHaveClass(/iv-hit/); // the deep-link wash landed
  await expect(entry.locator(".iv-opt-chosen")).toContainText("RS256");
  await expect(entry.locator(".iv-answer-body")).toHaveText("RS256 — keys rotate quarterly");

  // Still a collapsible panel: the toggle closes it again.
  await toggle.click();
  await expect(entry).toHaveCount(0);
});

test("approve warns on unresolved threads, forces on confirm, locks the session, writes the artifact", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("approve-flow"));
  const qid = await ask(request, session.id, {
    question: "Ship behind a flag?",
    options: ["yes", "no"],
    recommend: "yes",
  });
  await answer(request, session.id, { question: qid, choice: "yes" });
  await submitFixturePlan(request, session.id, "valid-plan.md");
  // One unanswered user question = one unresolved thread at approve time.
  const posted = await request.post(`/api/sessions/${session.id}/questions`, {
    data: { anchor: { section: "summary" }, body: "left open on purpose" },
  });
  expect(posted.status()).toBe(202);

  await page.goto(`/s/${session.id}`);
  await page.locator(".ctrl-approve").click();

  // The confirm sheet is honest about what happens (§10): finalize → folder
  // (the daemon picks the filename), session over.
  const sheet = page.locator(".approve-sheet");
  await expect(sheet).toContainText("Finalize r1");
  await expect(sheet).toContainText("docs/plans/");
  await expect(sheet).toContainText("the session is over");
  await sheet.locator(".btn-approve").click();

  // 409 E_UNRESOLVED_THREADS flips the sheet to its amber warning.
  await expect(sheet).toHaveClass(/approve-warning/);
  await expect(sheet).toContainText("1 unresolved thread");
  await sheet.locator(".btn-force").click();

  // Approved: the quiet notice names the artifact; the chip flips over SSE.
  const note = page.locator(".approved-note");
  await expect(note).toBeVisible();
  await expect(page.locator(".chip")).toHaveText("approved");
  const noted = await note.locator(".approved-path").textContent();
  const relPath = /docs\/plans\/\S+\.md/.exec(noted ?? "")?.[0];
  expect(relPath).toBeTruthy();

  // The artifact is on disk in the session's repo: daemon-rewritten
  // frontmatter plus the appended interview (DESIGN.md §6 step 6).
  const artifact = readFileSync(join(session.repo, relPath!), "utf8");
  expect(artifact).toContain("status: approved");
  expect(artifact).toContain("## Interview");
  expect(artifact).toContain(`### ${qid}`);
  expect(artifact).toContain("Ship behind a flag?");

  // Read-only: every mutation surface is gone…
  await expect(page.locator(".ctrl-approve")).toHaveCount(0);
  await expect(page.locator(".grill-queue")).toHaveCount(0);
  await expect(page.locator(".drawer-bar")).toHaveCount(0);
  await selectText(page, "#summary .md", "token issuance");
  await expect(page.locator(".sel-toolbar")).toHaveCount(0);
  await page.keyboard.press("c");
  await expect(page.locator(".composer")).toHaveCount(0);
  // …and the daemon refuses mutations outright: the session is over.
  const refused = await request.post(`/api/sessions/${session.id}/comments`, {
    data: { items: [{ anchor: null, body: "too late" }] },
  });
  expect(refused.status()).toBe(409);
});

test("index chips: questions pending lights live on an open question, approved settles the card", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("chip-light"));
  await page.goto("/");
  const card = page.locator(".card", { hasText: session.title });
  await expect(card.locator(".chip")).toHaveText("agent working");
  await plantMarker(page);

  // An open agent question outranks the stored status (derived, §10)…
  const qid = await ask(request, session.id, { question: "One thing to verify?" });
  await expect(card.locator(".chip")).toHaveText("questions pending");
  // …and answering hands the turn back.
  await answer(request, session.id, { question: qid, text: "the staging deploy" });
  await expect(card.locator(".chip")).toHaveText("agent working");

  await submitFixturePlan(request, session.id, "valid-plan.md");
  await expect(card.locator(".chip")).toHaveText("awaiting your review");
  const approved = await request.post(`/api/sessions/${session.id}/approve`, {
    data: { force: true },
  });
  expect(approved.ok()).toBeTruthy();
  await expect(card.locator(".chip")).toHaveText("approved");
  expect(await readMarker(page)).toBe(true); // every flip rode SSE
});

test("375px: cards are one-thumb — ≥44px targets, no horizontal scroll, approve sheet at the bottom", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 375, height: 720 });
  const session = await createSession(request, uniqueTitle("phone-grill"));
  await ask(request, session.id, {
    question: "Where should the long-lived refresh token live on mobile clients?",
    options: ["secure enclave keychain", "encrypted sqlite", "memory only"],
    recommend: "secure enclave keychain",
    multi: true,
  });
  await submitFixturePlan(request, session.id, "valid-plan.md");
  await page.goto(`/s/${session.id}`);
  await expect(page.locator(".grill-card")).toBeVisible();

  // Every chip and the send button meet the 44px thumb target (§8); rounded
  // because Chrome renders the 1.5px chip border at subpixel widths.
  for (const target of await page.locator(".grill-chip, .grill-send").all()) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
  }
  const scrollWidth = (await page.evaluate("document.documentElement.scrollWidth")) as number;
  expect(scrollWidth).toBeLessThanOrEqual(375);

  // The confirm sheet docks to the bottom edge — thumb range, not screen
  // center. On a phone approve lives on the sticky bar (M5b), not the header.
  await page.locator(".bar-approve").click();
  const sheet = await page.locator(".approve-sheet").boundingBox();
  expect(sheet).not.toBeNull();
  expect(sheet!.y + sheet!.height).toBeGreaterThan(720 * 0.8);
  for (const action of await page.locator(".approve-actions .btn").all()) {
    const box = await action.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test("dark scheme renders the grill, interview, and approve surfaces", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const session = await createSession(request, uniqueTitle("dark-grill"));
  const qid = await ask(request, session.id, {
    question: "Algorithm?",
    options: ["RS256", "HS256"],
    recommend: "RS256",
  });
  await answer(request, session.id, { question: qid, choice: "RS256" });
  await submitFixturePlan(request, session.id, "valid-plan.md", (plan) =>
    plan.replace("- D1: RS256 over HS256 [assumed]", `- D1: RS256 over HS256 ← ${qid}`),
  );
  await page.goto(`/s/${session.id}`);

  await expect(page.locator("#decisions a.q-cite")).toBeVisible();
  await expect(page.locator("#decisions .assumed-tag")).toBeVisible();
  await page.locator(".interview-toggle").click();
  await expect(page.locator(`.iv-entry[data-iv="${qid}"]`)).toBeVisible();
  await page.locator(".ctrl-approve").click();
  await expect(page.locator(".approve-sheet")).toBeVisible();
});
