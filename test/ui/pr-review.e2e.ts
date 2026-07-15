// Production PR-review acceptance coverage. Every interaction drives the real
// built SPA and daemon; the strict report/quiz companions come from the same
// fixture files an agent-facing e2e flow can submit.

import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { REVIEW_REPORT_SECTIONS } from "../../src/shared/review-report.js";
import type { ReviewSession } from "./helpers.js";
import {
  createReviewSession,
  selectText,
  submitFixtureReview,
  uniqueTitle,
} from "./helpers.js";

interface QuizAnswerEvent {
  event: "quiz-answer";
  session: string;
  revision: number;
  headRevision: number;
  headSha: string;
  question: string;
  attempt: string;
  knowledge: { baseHash: string };
}

// The Storybook Full experience stories established this semantic contract.
// Production compares against labels, order, and the shared component roots so
// the test stays stable across visual polish while catching structural drift.
const STORYBOOK_MAJOR_STATE_CONTRACT = {
  sections: ["Background", "Intuition", "Code", "Quiz"],
  codeLayers: ["Interface changes", "Integration path", "Implementation walkthrough"],
  sharedComponents: [".pr-quiz-experience", ".pr-thread-rail", ".pr-review-finish"],
} as const;

test("the shared activity log is visible before report authoring and persists after submit", async ({
  page,
  request,
}) => {
  const session = await createReviewSession(request, uniqueTitle("authoring-activity"));
  await page.goto(`/s/${session.id}`);

  const bar = page.getByRole("button", { name: "agent activity: toggle the live console" });
  await expect(page.getByText("// report authoring in progress")).toBeVisible();
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("working…");
  await bar.click();
  await expect(page.getByRole("region", { name: "live activity console" })).toContainText(
    "// nothing captured yet",
  );

  const progress = await request.post(`/api/sessions/${session.id}/progress`, {
    data: { note: "mapping the PR integration path" },
  });
  expect(progress.ok()).toBeTruthy();
  await expect(bar).toContainText("mapping the PR integration path");

  await submitFixtureReview(request, session);
  await expect(page.locator(".pr-report #background")).toBeVisible();
  const submittedBar = page.getByRole("button", { name: "agent activity: toggle the live console" });
  await expect(submittedBar).toContainText("mapping the PR integration path");
  await submittedBar.click();
  await expect(page.getByRole("region", { name: "live activity console" })).toContainText(
    "mapping the PR integration path",
  );
});

async function createSubmittedReview(
  request: APIRequestContext,
  label: string,
): Promise<ReviewSession> {
  const session = await createReviewSession(request, uniqueTitle(label));
  await submitFixtureReview(request, session);
  return session;
}

async function openReview(
  page: Page,
  request: APIRequestContext,
  label: string,
): Promise<ReviewSession> {
  const session = await createSubmittedReview(request, label);
  await page.goto(`/s/${session.id}`);
  await expect(page.locator(".pr-report #background")).toBeVisible();
  return session;
}

async function gradeNextOpenAnswer(
  request: APIRequestContext,
  session: ReviewSession,
  verdict: "retry" | "pass",
  feedback: string,
): Promise<void> {
  const delivered = await request.get(`/api/sessions/${session.id}/events?wait=0`);
  expect(delivered.ok()).toBeTruthy();
  const event = (await delivered.json()) as QuizAnswerEvent;
  expect(event).toMatchObject({
    event: "quiz-answer",
    session: session.id,
    revision: 1,
    headRevision: 1,
    headSha: session.headSha,
    question: "q-open",
  });
  const graded = await request.post(
    `/api/reviews/${session.id}/quiz/${event.question}/grade`,
    {
      data: {
        version: 1,
        session: event.session,
        revision: event.revision,
        headRevision: event.headRevision,
        headSha: event.headSha,
        question: event.question,
        attempt: event.attempt,
        verdict,
        feedback,
        knowledgeBaseHash: event.knowledge.baseHash,
      },
    },
  );
  expect(graded.ok()).toBeTruthy();
}

async function passBothQuizQuestions(
  request: APIRequestContext,
  session: ReviewSession,
): Promise<void> {
  const open = await request.post(`/api/reviews/${session.id}/quiz/q-open/answer`, {
    data: {
      revision: 1,
      answer: "The immutable snapshot keeps the authoring input reproducible for this revision.",
      idempotencyKey: `clean-open-${session.id}`,
    },
  });
  expect(open.status()).toBe(201);
  await gradeNextOpenAnswer(
    request,
    session,
    "pass",
    "Correct: the answer connects the frozen input to a reproducible revision.",
  );
  const choice = await request.post(`/api/reviews/${session.id}/quiz/q-choice/answer`, {
    data: {
      revision: 1,
      answer: "Frozen snapshot",
      idempotencyKey: `clean-choice-${session.id}`,
    },
  });
  expect(choice.status()).toBe(201);
}

test("production report keeps the Storybook reading grammar and navigates its authored groups", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReview(page, request, "report-navigation");

  // The prototype and production surfaces intentionally share these major
  // states. Compare semantic labels/order, not screenshots or pixel positions.
  const prototypeSections = [...STORYBOOK_MAJOR_STATE_CONTRACT.sections];
  expect(prototypeSections).toEqual([...REVIEW_REPORT_SECTIONS]);
  await expect(page.locator(".pr-report > .pr-report-section > h2")).toHaveText(
    prototypeSections,
  );

  const prototypeCodeLayers = [...STORYBOOK_MAJOR_STATE_CONTRACT.codeLayers];
  await expect(page.locator(".pr-report #code > .pr-code-layer > h3")).toHaveText(
    prototypeCodeLayers,
  );
  for (const selector of STORYBOOK_MAJOR_STATE_CONTRACT.sharedComponents) {
    await expect(page.locator(selector)).toHaveCount(1);
  }

  const contents = page.locator(".pr-toc");
  await expect(contents.getByRole("link", { name: "01 Background", exact: true })).toBeVisible();
  await contents.getByRole("link", { name: "Atomic revision storage", exact: true }).click();
  await expect(page).toHaveURL(/#code-implementation-atomic-revision-storage$/);

  // AppShell remains the only vertical sidebar around the production report.
  await expect(page.locator(".app-shell > .app-sidebar")).toHaveCount(1);
  await expect(page.locator(".app-sidebar").getByRole("group", { name: "session kind" }).getByRole("button")).toHaveText([
    "Plans",
    "Reviews",
  ]);

  // Folding preserves the current app-shell behavior: the sidebar becomes
  // hidden and a single explicit control remains to bring it back.
  const shell = page.locator(".app-shell");
  await page.getByRole("button", { name: "collapse sidebar" }).click();
  await expect(shell).toHaveClass(/\bcollapsed\b/);
  const reopen = page.getByRole("button", { name: "show sessions" });
  await expect(reopen).toBeVisible();
  await reopen.click();
  await expect(shell).not.toHaveClass(/\bcollapsed\b/);
  await expect(page.locator(".app-shell > .app-sidebar")).toBeVisible();
});

test("an open quiz answer retries, preserves the draft, then passes over the live session stream", async ({
  page,
  request,
}) => {
  const session = await openReview(page, request, "quiz-retry-pass");
  const card = page.locator('[data-quiz-id="q-open"]');
  const answer = card.getByRole("textbox", { name: "Answer quiz 1" });
  const firstDraft = "It stores the Markdown so the reader can inspect it later.";
  await answer.fill(firstDraft);
  const firstSubmission = page.waitForResponse((response) =>
    response.url().endsWith(`/api/reviews/${session.id}/quiz/q-open/answer`) &&
    response.request().method() === "POST"
  );
  await card.getByRole("button", { name: "Check answer" }).click();
  await firstSubmission;
  await expect(card.locator(".pr-quiz-state")).toHaveText("agent grading…");

  await gradeNextOpenAnswer(
    request,
    session,
    "retry",
    "You named storage, but not why an immutable authoring input makes this revision reproducible.",
  );
  await expect(card.locator(".pr-quiz-state")).toHaveText("try again");
  await expect(card.getByRole("alert")).toContainText("Not quite.");
  await expect(answer).toHaveValue(firstDraft);

  await answer.fill(
    "The immutable snapshot freezes the authoring input, so this report revision remains reproducible after later learning.",
  );
  const retrySubmission = page.waitForResponse((response) =>
    response.url().endsWith(`/api/reviews/${session.id}/quiz/q-open/answer`) &&
    response.request().method() === "POST"
  );
  await card.getByRole("button", { name: "Retry answer" }).click();
  await retrySubmission;
  await expect(card.locator(".pr-quiz-state")).toHaveText("agent grading…");
  await gradeNextOpenAnswer(
    request,
    session,
    "pass",
    "Correct: you connected the frozen authoring input to the stable report revision.",
  );

  await expect(card.locator(".pr-quiz-state")).toHaveText("understood");
  await expect(card.locator(".pr-quiz-verdict")).toContainText("Correct.");
  await expect(card.locator(".pr-memory-receipt")).toHaveText(
    "✓ added to Project knowledge",
  );
});

test("selection offers only Ask or Comment; Conduct code change belongs only to the Comment thread", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openReview(page, request, "thread-actions");

  await selectText(
    page,
    ".pr-report #background",
    "mutable profile knowledge",
  );
  const selectionBar = page.getByRole("toolbar", { name: "selection actions" });
  await expect(selectionBar.getByRole("button", { name: /^ask/ })).toBeVisible();
  await expect(selectionBar.getByRole("button", { name: /^comment/ })).toBeVisible();
  await expect(selectionBar.getByText("Conduct code change")).toHaveCount(0);

  await selectionBar.getByRole("button", { name: /^ask/ }).click();
  const askInput = page.locator(".composer-input");
  await askInput.fill("What changes the next report after this snapshot is frozen?");
  await askInput.press("Control+Enter");
  const rail = page.locator(".pr-thread-rail");
  const question = rail.locator(".pr-thread", {
    hasText: "What changes the next report after this snapshot is frozen?",
  });
  await expect(question).toBeVisible();
  await expect(question.getByRole("button", { name: "Conduct code change" })).toHaveCount(0);

  // Code fences use the same anchored Comment affordance as report prose.
  await page.locator(".pr-report #code .fence code", { hasText: "snapshotHash" })
    .scrollIntoViewIfNeeded();
  await selectText(page, ".pr-report #code", "snapshotHash");
  await expect(selectionBar).toBeVisible();
  await expect(selectionBar.getByText("Conduct code change")).toHaveCount(0);
  await selectionBar.getByRole("button", { name: /^comment/ }).click();
  const commentInput = page.locator(".composer-input");
  await commentInput.fill("Rename this field so its revision ownership is explicit.");
  await commentInput.press("Control+Enter");

  const comment = rail.locator(".pr-thread", {
    hasText: "Rename this field so its revision ownership is explicit.",
  });
  const conduct = comment.getByRole("button", { name: "Conduct code change" });
  await expect(conduct).toBeVisible();
  await expect(question.getByRole("button", { name: "Conduct code change" })).toHaveCount(0);
  await conduct.click();
  await expect(comment.locator(".pr-change-receipt")).toContainText(
    "Worktree handoff requested",
  );
  await expect(conduct).toHaveCount(0);
});

test("the production Knowledge route exposes the same User and Project Markdown model", async ({
  page,
  request,
}) => {
  const session = await openReview(page, request, "knowledge-route");
  await page.locator('.app-sidebar a[aria-label="knowledge"]').click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(page.getByRole("heading", { name: "Knowledge" })).toBeVisible();

  const userTab = page.getByRole("tab", { name: "User" });
  const projectTab = page.getByRole("tab", { name: "Project" });
  await expect(userTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".pr-markdown-editor textarea")).toHaveValue(/# User knowledge/);

  await projectTab.click();
  await page.getByLabel("GitHub project").fill("acme/app");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(projectTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".pr-knowledge-target")).toContainText("acme/app");
  await expect(page.locator(".pr-markdown-editor textarea")).toHaveValue(
    /# Project knowledge — github\.com\/acme\/app/,
  );

  // The review still exists; navigating to profile management does not end it.
  const detail = await request.get(`/api/sessions/${session.id}`);
  expect(detail.ok()).toBeTruthy();
  expect((await detail.json()) as object).toMatchObject({ status: "reviewing" });
});

test("Done closes a review immediately when every quiz is complete", async ({
  page,
  request,
}) => {
  const session = await createSubmittedReview(request, "done-clean");
  await passBothQuizQuestions(request, session);
  await page.goto(`/s/${session.id}`);
  await expect(page.locator(".pr-quiz-progress")).toContainText("2/2 demonstrated");

  await page.locator(".pr-review-finish").getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog", { name: /Finish this review/ })).toHaveCount(0);
  await expect(page.locator(".pr-closed-banner")).toHaveText(
    "Review closed · report preserved as read-only",
  );
});

test("Done names unfinished work and requires an explicit Close anyway", async ({
  page,
  request,
}) => {
  const session = await openReview(page, request, "done-force");
  await page.locator(".pr-review-finish").getByRole("button", { name: "Done" }).click();

  const dialog = page.getByRole("dialog", { name: "This review still has loose ends" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("0 unresolved conversations");
  await expect(dialog).toContainText("2 unfinished quizzes");
  await dialog.getByRole("button", { name: "Close anyway" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".pr-closed-banner")).toHaveText(
    "Review closed · report preserved as read-only",
  );

  const detail = await request.get(`/api/sessions/${session.id}`);
  expect((await detail.json()) as object).toMatchObject({ status: "done" });
});
