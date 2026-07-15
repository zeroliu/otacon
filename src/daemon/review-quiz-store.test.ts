import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeGitHubRepo } from "../shared/knowledge.js";
import { reviewRevisionQuizStatePath } from "../shared/paths.js";
import type { ReviewQuizGradeInput } from "../shared/review-quiz.js";
import { pullRequestIdentity } from "../shared/review.js";
import type { ReviewRegistrySession } from "../shared/types.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { ReviewQuizConflictError, ReviewQuizCorruptError, ReviewQuizStore } from "./review-quiz-store.js";
import { ReviewStore } from "./review-store.js";

let home: string;
let savedHome: string | undefined;
const repo = canonicalizeGitHubRepo("acme/app")!;
const now = "2026-07-14T20:00:00.000Z";

function session(head = "a".repeat(40), headRevision = 1): ReviewRegistrySession {
  return {
    kind: "review",
    id: "otc_review1",
    title: "Review quiz",
    repo: "/tmp/app",
    branch: "feature",
    quick: false,
    socratic: false,
    status: "reviewing",
    createdAt: now,
    updatedAt: now,
    review: {
      pullRequest: {
        identity: pullRequestIdentity(repo, 42),
        url: "https://github.com/acme/app/pull/42",
        title: "Quiz",
        author: "octo",
        baseRef: "main",
        headRef: "feature",
        headRepository: repo,
        headSha: head,
        state: "open",
        isCrossRepository: false,
        permissions: { maintainerCanModify: true, viewerPermission: "write", readOnly: false },
      },
      head: { sha: head, ref: "feature", repository: repo, capturedAt: now },
      revision: headRevision,
    },
  };
}

function report(snapshot: string, revision = 1, head = "a".repeat(40)): string {
  const group = (kind: string) => `### ${kind} — Boundary\n\n**Purpose:** Orient the causal read.\n**Changed behavior:** State is frozen.\n**Surfaces:** \`src/a.ts#run\`\n\nDetails.`;
  return `---\ntype: otacon-pr-review\nversion: 1\nsession: otc_review1\nrevision: ${revision}\npr: github.com/acme/app#42\nhead: ${head}\nknowledge-snapshot: ${snapshot}\naltitude: balanced\n---\n\n## Background\n\nEnough context to understand why this exists and what failed before.\n\n## Intuition\n\nA frozen boundary keeps the explanation stable and makes the ownership obvious.\n\n## Code\n\n${group("Interface changes")}\n\n${group("Integration path")}\n\n${group("Implementation walkthrough")}\n\n## Quiz\n\nCards.\n`;
}

function companion(revision = 1, head = "a".repeat(40), headRevision = 1): string {
  return JSON.stringify({
    version: 1,
    session: "otc_review1",
    revision,
    headRevision,
    headSha: head,
    questions: [
      {
        id: "q-open",
        concept: { id: "boundary", label: "Boundary ownership", scope: "project" },
        prompt: "Explain the boundary.",
        mode: "open",
        rubric: { criteria: ["Names the owner", "Explains the handoff"] },
      },
      {
        id: "q-choice",
        concept: { id: "mode", label: "Answer mode", scope: "user" },
        prompt: "Which mode needs the agent?",
        mode: "choice",
        rubric: { criteria: ["Chooses the open mode"] },
        options: ["choice", "open"],
        answerKey: "open",
      },
    ],
  });
}

function setup(): { knowledge: KnowledgeStore; reviews: ReviewStore; quizzes: ReviewQuizStore } {
  const knowledge = new KnowledgeStore();
  const reviews = new ReviewStore(knowledge, { now: () => now });
  const prepared = reviews.beginRevision(session());
  reviews.submit(session(), { report: report(prepared.snapshot.hash), quiz: companion() });
  return { knowledge, reviews, quizzes: new ReviewQuizStore(reviews, knowledge, { now: () => now }) };
}

beforeEach(() => {
  savedHome = process.env.OTACON_HOME;
  home = mkdtempSync(join(tmpdir(), "otacon-review-quiz-"));
  process.env.OTACON_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
});

describe("ReviewQuizStore", () => {
  test("grades bounded choices immediately without creating an agent event", () => {
    const { knowledge, quizzes } = setup();
    const result = quizzes.answer(session(), { revision: 1, question: "q-choice", answer: "open", idempotencyKey: "pick-1" });
    expect(result.event).toBeUndefined();
    expect(result.attempt.status).toBe("pass");
    expect(result.quiz.progress).toEqual({ passed: 1, total: 2, pending: 0 });
    expect(knowledge.read({ scope: "user" }).markdown).toContain("Answer mode");
    expect(knowledge.readEvidence({ scope: "user" })).toHaveLength(1);
  });

  test("keeps open attempts pending after delivery and supports retry then pass evidence", () => {
    const { knowledge, quizzes } = setup();
    const first = quizzes.answer(session(), { revision: 1, question: "q-open", answer: "It stores data.", idempotencyKey: "open-1" });
    expect(first.event).toMatchObject({ event: "quiz-answer", rubric: { criteria: ["Names the owner", "Explains the handoff"] } });
    expect(quizzes.pendingCount(session())).toBe(1);
    const firstGrade: ReviewQuizGradeInput = {
      version: 1, session: session().id, revision: 1, headRevision: 1, headSha: "a".repeat(40),
      question: "q-open", attempt: first.attempt.id, verdict: "retry", feedback: "Name both sides.",
      knowledgeBaseHash: first.event!.knowledge.baseHash,
    };
    const retry = quizzes.grade(session(), firstGrade);
    expect(retry.attempt.status).toBe("retry");
    expect(knowledge.read({ scope: "project", repo }).markdown).not.toContain("## Demonstrated concepts\n\n- <!--");
    const second = quizzes.answer(session(), { revision: 1, question: "q-open", answer: "The daemon owns persistence and the UI consumes its projection.", idempotencyKey: "open-2" });
    quizzes.grade(session(), {
      version: 1, session: session().id, revision: 1, headRevision: 1, headSha: "a".repeat(40),
      question: "q-open", attempt: second.attempt.id, verdict: "pass", feedback: "Both sides and their handoff are clear.",
      knowledgeBaseHash: second.event!.knowledge.baseHash,
    });
    const markdown = knowledge.read({ scope: "project", repo }).markdown;
    expect(markdown).toContain("## Demonstrated concepts\n\n- <!-- otacon:quiz:boundary:otc_review1:r1:qa2 --> Boundary ownership");
    expect(markdown).not.toContain("Name both sides.");
    expect(knowledge.readEvidence({ scope: "project", repo }).map((item) => item.verdict)).toEqual(["retry", "pass"]);
    // A late duplicate for the older attempt is read-only and cannot regress
    // the later demonstrated state.
    expect(quizzes.grade(session(), firstGrade).repeated).toBe(true);
    expect(knowledge.read({ scope: "project", repo }).markdown).toContain("otacon:quiz:boundary:otc_review1:r1:qa2");
  });

  test("rebases a repeated deterministic choice after its first knowledge CAS loses", () => {
    const { knowledge, quizzes } = setup();
    const originalReplace = knowledge.replace.bind(knowledge);
    let conflictOnce = true;
    knowledge.replace = ((target, markdown, baseHash) => {
      if (!conflictOnce) return originalReplace(target, markdown, baseHash);
      conflictOnce = false;
      const current = knowledge.read(target);
      const manual = originalReplace(
        target,
        current.markdown.replace("No preferences recorded yet", "Keep explanations concise"),
        current.hash,
      );
      if (!manual.ok) throw new Error("fixture manual edit should win");
      return { ok: false as const, current: manual.document };
    }) as KnowledgeStore["replace"];

    expect(() => quizzes.answer(session(), {
      revision: 1, question: "q-choice", answer: "open", idempotencyKey: "choice-cas",
    })).toThrow(ReviewQuizConflictError);

    const replay = quizzes.answer(session(), {
      revision: 1, question: "q-choice", answer: "open", idempotencyKey: "choice-cas",
    });
    expect(replay).toMatchObject({ repeated: true, attempt: { status: "pass" } });
    const markdown = knowledge.read({ scope: "user" }).markdown;
    expect(markdown).toContain("Keep explanations concise");
    expect(markdown).toContain("Answer mode");
  });

  test("is idempotent for repeated answers and grades without duplicate evidence", () => {
    const { knowledge, quizzes } = setup();
    const answer = quizzes.answer(session(), { revision: 1, question: "q-open", answer: "owner then consumer", idempotencyKey: "same" });
    expect(quizzes.answer(session(), { revision: 1, question: "q-open", answer: "owner then consumer", idempotencyKey: "same" }).repeated).toBe(true);
    const grade: ReviewQuizGradeInput = {
      version: 1, session: session().id, revision: 1, headRevision: 1, headSha: "a".repeat(40),
      question: "q-open", attempt: answer.attempt.id, verdict: "pass", feedback: "Clear.",
      knowledgeBaseHash: answer.event!.knowledge.baseHash,
    };
    expect(quizzes.grade(session(), grade).repeated).toBe(false);
    expect(quizzes.grade(session(), grade).repeated).toBe(true);
    expect(knowledge.readEvidence({ scope: "project", repo })).toHaveLength(1);
  });

  test("re-emits a repeated pending answer and refuses a second answer until grading finishes", () => {
    const { quizzes } = setup();
    const first = quizzes.answer(session(), { revision: 1, question: "q-open", answer: "first", idempotencyKey: "pending-1" });
    const replay = quizzes.answer(session(), { revision: 1, question: "q-open", answer: "first", idempotencyKey: "pending-1" });
    expect(replay).toMatchObject({ repeated: true, event: { attempt: first.attempt.id, knowledge: first.event!.knowledge } });
    expect(() => quizzes.answer(session(), { revision: 1, question: "q-open", answer: "second", idempotencyKey: "pending-2" }))
      .toThrow(ReviewQuizConflictError);
  });

  test("crash replay after knowledge mutation preserves one byte-identical evidence row", () => {
    const { knowledge, quizzes } = setup();
    const answer = quizzes.answer(session(), { revision: 1, question: "q-open", answer: "owner and consumer", idempotencyKey: "crash-grade" });
    const grade: ReviewQuizGradeInput = {
      version: 1, session: session().id, revision: 1, headRevision: 1, headSha: "a".repeat(40),
      question: "q-open", attempt: answer.attempt.id, verdict: "pass", feedback: "Stable verdict.",
      knowledgeBaseHash: answer.event!.knowledge.baseHash,
    };
    quizzes.grade(session(), grade);
    const path = reviewRevisionQuizStatePath(session().id, 1);
    const state = JSON.parse(readFileSync(path, "utf8")) as { attempts: Array<Record<string, unknown>> };
    state.attempts[0] = {
      ...state.attempts[0],
      status: "pending",
      feedback: undefined,
      gradedAt: undefined,
      knowledge: undefined,
    };
    const pending = `${JSON.stringify(state, null, 2)}\n`;
    writeFileSync(path, pending);
    writeFileSync(`${path}.backup`, pending);
    expect(quizzes.grade(session(), grade).attempt.status).toBe("pass");
    expect(knowledge.readEvidence({ scope: "project", repo })).toHaveLength(1);
  });

  test("leaves an attempt pending on knowledge CAS conflict", () => {
    const { knowledge, quizzes } = setup();
    const answer = quizzes.answer(session(), { revision: 1, question: "q-open", answer: "owner then consumer", idempotencyKey: "conflict" });
    const current = knowledge.read({ scope: "project", repo });
    expect(knowledge.replace({ scope: "project", repo }, current.markdown.replace("No preferences", "Concise preferences"), current.hash).ok).toBe(true);
    expect(() => quizzes.grade(session(), {
      version: 1, session: session().id, revision: 1, headRevision: 1, headSha: "a".repeat(40),
      question: "q-open", attempt: answer.attempt.id, verdict: "pass", feedback: "Clear.",
      knowledgeBaseHash: answer.event!.knowledge.baseHash,
    })).toThrow(ReviewQuizConflictError);
    expect(quizzes.publicState(session(), 1).questions[0]?.status).toBe("grading");
    expect(knowledge.readEvidence({ scope: "project", repo })).toEqual([]);
  });

  test("does not treat a marker-shaped user prose mention as this grade's committed patch", () => {
    const { knowledge, quizzes } = setup();
    const answer = quizzes.answer(session(), { revision: 1, question: "q-open", answer: "owner then consumer", idempotencyKey: "marker-spoof" });
    const current = knowledge.read({ scope: "project", repo });
    const spoof = "<!-- otacon:quiz:boundary:otc_review1:r1:qa1 -->";
    const edited = current.markdown.replace("No preferences recorded yet.", `No preferences recorded yet. Mentioned as prose: ${spoof}`);
    expect(knowledge.replace({ scope: "project", repo }, edited, current.hash).ok).toBe(true);
    expect(() => quizzes.grade(session(), {
      version: 1, session: session().id, revision: 1, headRevision: 1, headSha: "a".repeat(40),
      question: "q-open", attempt: answer.attempt.id, verdict: "pass", feedback: "Clear.",
      knowledgeBaseHash: answer.event!.knowledge.baseHash,
    })).toThrow(ReviewQuizConflictError);
    expect(quizzes.publicState(session(), 1).questions[0]?.status).toBe("grading");
    expect(knowledge.readEvidence({ scope: "project", repo })).toEqual([]);
  });

  test("repairs pending choices and exposes only pending open events after restart", () => {
    const { knowledge, quizzes } = setup();
    const open = quizzes.answer(session(), { revision: 1, question: "q-open", answer: "owner then consumer", idempotencyKey: "recover-open" });
    const originalReplace = knowledge.replace.bind(knowledge);
    let conflictOnce = true;
    knowledge.replace = ((target, markdown, baseHash) => {
      if (conflictOnce) {
        conflictOnce = false;
        const current = knowledge.read(target);
        return { ok: false as const, current };
      }
      return originalReplace(target, markdown, baseHash);
    }) as KnowledgeStore["replace"];
    expect(() => quizzes.answer(session(), {
      revision: 1, question: "q-choice", answer: "open", idempotencyKey: "recover-choice",
    })).toThrow(ReviewQuizConflictError);
    conflictOnce = true;

    const repaired = quizzes.recoverPending(session());
    knowledge.replace = originalReplace;
    expect(repaired.events).toEqual([open.event!]);
    expect(repaired.quiz.questions.find((question) => question.id === "q-choice")?.status).toBe("passed");
    expect(repaired.quiz.questions.find((question) => question.id === "q-open")?.status).toBe("grading");
  });

  test("recovers the latest atomic state from its backup", () => {
    const { quizzes } = setup();
    quizzes.answer(session(), { revision: 1, question: "q-open", answer: "pending", idempotencyKey: "recover" });
    writeFileSync(reviewRevisionQuizStatePath(session().id, 1), "{broken");
    expect(quizzes.publicState(session(), 1).questions[0]?.status).toBe("grading");
    expect(JSON.parse(readFileSync(reviewRevisionQuizStatePath(session().id, 1), "utf8"))).toMatchObject({ nextAttempt: 2 });
  });

  test("rejects malformed attempt dates, receipts, ordinals, counters, and unknown fields", () => {
    const { quizzes } = setup();
    quizzes.answer(session(), { revision: 1, question: "q-choice", answer: "open", idempotencyKey: "strict-state" });
    const path = reviewRevisionQuizStatePath(session().id, 1);
    const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    const malformed = [
      { ...structuredClone(original), nextAttempt: 99 },
      { ...structuredClone(original), attempts: [{ ...original.attempts[0], ordinal: 2 }] },
      { ...structuredClone(original), attempts: [{ ...original.attempts[0], gradedAt: "yesterday" }] },
      { ...structuredClone(original), attempts: [{ ...original.attempts[0], knowledge: { scope: "project", receipt: "User knowledge" } }] },
      { ...structuredClone(original), attempts: [{ ...original.attempts[0], surprise: true }] },
    ];
    for (const invalid of malformed) {
      writeFileSync(path, `${JSON.stringify(invalid, null, 2)}\n`);
      expect(quizzes.publicState(session(), 1).questions[1]?.status).toBe("passed");
    }

    writeFileSync(path, `${JSON.stringify(malformed[0], null, 2)}\n`);
    writeFileSync(`${path}.backup`, `${JSON.stringify(malformed[1], null, 2)}\n`);
    expect(() => quizzes.publicState(session(), 1)).toThrow(ReviewQuizCorruptError);
  });

  test("rejects a project receipt that names a different repository", () => {
    const { quizzes } = setup();
    const answer = quizzes.answer(session(), { revision: 1, question: "q-open", answer: "owner then consumer", idempotencyKey: "receipt-repo" });
    quizzes.grade(session(), {
      version: 1, session: session().id, revision: 1, headRevision: 1, headSha: "a".repeat(40),
      question: "q-open", attempt: answer.attempt.id, verdict: "pass", feedback: "Clear.",
      knowledgeBaseHash: answer.event!.knowledge.baseHash,
    });
    const path = reviewRevisionQuizStatePath(session().id, 1);
    const state = JSON.parse(readFileSync(path, "utf8")) as { attempts: Array<{ knowledge: { receipt: string } }> };
    state.attempts[0]!.knowledge.receipt = "Project knowledge (evil/repo)";
    const corrupt = `${JSON.stringify(state, null, 2)}\n`;
    writeFileSync(path, corrupt);
    writeFileSync(`${path}.backup`, corrupt);
    expect(() => quizzes.publicState(session(), 1)).toThrow(ReviewQuizCorruptError);
  });

  test("refuses stale report and head identities", () => {
    const { reviews, quizzes } = setup();
    const second = reviews.beginRevision(session());
    reviews.submit(session(), { report: report(second.snapshot.hash, 2), quiz: companion(2) });
    expect(() => quizzes.answer(session(), { revision: 1, question: "q-open", answer: "stale", idempotencyKey: "old" })).toThrow(ReviewQuizConflictError);
    expect(() => quizzes.publicState(session("b".repeat(40), 2), 2)).not.toThrow();
    expect(() => quizzes.answer(session("b".repeat(40), 2), { revision: 2, question: "q-open", answer: "stale head", idempotencyKey: "head" })).toThrow(ReviewQuizConflictError);
  });

  test("keeps deterministic evidence ids distinct across report revisions", () => {
    const { knowledge, reviews, quizzes } = setup();
    const first = quizzes.answer(session(), { revision: 1, question: "q-open", answer: "r1", idempotencyKey: "r1" });
    quizzes.grade(session(), {
      version: 1, session: session().id, revision: 1, headRevision: 1, headSha: "a".repeat(40),
      question: "q-open", attempt: first.attempt.id, verdict: "pass", feedback: "R1 pass.", knowledgeBaseHash: first.event!.knowledge.baseHash,
    });
    const prepared = reviews.beginRevision(session());
    reviews.submit(session(), { report: report(prepared.snapshot.hash, 2), quiz: companion(2) });
    const second = quizzes.answer(session(), { revision: 2, question: "q-open", answer: "r2", idempotencyKey: "r2" });
    quizzes.grade(session(), {
      version: 1, session: session().id, revision: 2, headRevision: 1, headSha: "a".repeat(40),
      question: "q-open", attempt: second.attempt.id, verdict: "pass", feedback: "R2 pass.", knowledgeBaseHash: second.event!.knowledge.baseHash,
    });
    const ids = knowledge.readEvidence({ scope: "project", repo }).map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toContain(":r1:");
    expect(ids[1]).toContain(":r2:");
  });
});
