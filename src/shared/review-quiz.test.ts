import { describe, expect, test } from "bun:test";
import { hashKnowledge } from "./knowledge.js";
import {
  parseReviewQuizCompanion,
  parseReviewQuizGrade,
  publicQuizState,
  REVIEW_QUIZ_MAX_QUESTIONS,
} from "./review-quiz.js";

function question(index = 1, mode: "open" | "choice" = "open") {
  const base = {
    id: `q${index}`,
    concept: { id: `concept-${index}`, label: `Concept ${index}`, scope: "project" },
    prompt: "Explain the boundary.",
    mode,
    rubric: { criteria: ["Names the producer", "Explains the consumer"] },
  };
  return mode === "choice" ? { ...base, options: ["old", "new"], answerKey: "new" } : base;
}

function companion(questions: unknown[] = [question()]) {
  return {
    version: 1,
    session: "otc_review1",
    revision: 2,
    headRevision: 3,
    headSha: "a".repeat(40),
    questions,
  };
}

describe("review quiz wire contract", () => {
  test("validates private open and bounded-choice definitions", () => {
    expect(parseReviewQuizCompanion(companion([question(1), question(2, "choice")])).value?.questions).toHaveLength(2);
    expect(parseReviewQuizCompanion(companion([{ ...question(), surprise: true }])).errors[0]).toContain("invalid fields");
    expect(parseReviewQuizCompanion(companion([{ ...question(1, "choice"), answerKey: "missing" }])).errors[0]).toContain("answerKey");
    expect(parseReviewQuizCompanion(companion([{
      ...question(),
      concept: { ...question().concept, label: "Injected\n## Needs reinforcement" },
    }])).errors[0]).toContain("label");
  });

  test("normalizes bounded choices before validating and serving them", () => {
    const parsed = parseReviewQuizCompanion(companion([{
      ...question(1, "choice"),
      options: [" old ", " new "],
      answerKey: " new ",
    }]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.value?.questions[0]).toMatchObject({ options: ["old", "new"], answerKey: "new" });
    expect(parseReviewQuizCompanion(companion([{
      ...question(1, "choice"),
      options: ["same", " same "],
      answerKey: "same",
    }])).errors[0]).toContain("unique");
  });

  test("caps complexity-sized quizzes at twenty and rejects duplicate concepts", () => {
    expect(parseReviewQuizCompanion(companion(Array.from({ length: REVIEW_QUIZ_MAX_QUESTIONS }, (_, index) => question(index + 1)))).errors).toEqual([]);
    expect(parseReviewQuizCompanion(companion([])).errors[0]).toContain("between 1 and 20");
    expect(parseReviewQuizCompanion(companion(Array.from({ length: 21 }, (_, index) => question(index + 1)))).errors[0]).toContain("between 1 and 20");
    expect(parseReviewQuizCompanion(companion([question(1), { ...question(2), concept: question(1).concept }])).errors[0]).toContain("concept.id");
  });

  test("public projection cannot expose rubric or choice answer key", () => {
    const parsed = parseReviewQuizCompanion(companion([question(1, "choice")])).value!;
    const projected = publicQuizState(parsed, [{
      id: "qa1",
      questionId: "q1",
      ordinal: 1,
      idempotencyKey: "PRIVATE_REQUEST_ID",
      answer: "new",
      submittedAt: "2026-07-14T20:00:00.000Z",
      status: "pending",
      knowledgeBaseHash: hashKnowledge("PRIVATE_BASE_HASH"),
      gradeStartedAt: "2026-07-14T20:00:01.000Z",
    }]);
    expect(projected.questions[0]).toMatchObject({ mode: "choice", options: ["old", "new"], status: "grading" });
    const wire = JSON.stringify(projected);
    expect(wire).not.toContain("criteria");
    expect(wire).not.toContain("answerKey");
    expect(wire).not.toContain("producer");
    expect(wire).not.toContain("PRIVATE_REQUEST_ID");
    expect(wire).not.toContain(hashKnowledge("PRIVATE_BASE_HASH"));
    expect(wire).not.toContain("gradeStartedAt");
  });

  test("validates grade identity, verdict, feedback, and CAS hash", () => {
    const valid = {
      version: 1,
      session: "otc_review1",
      revision: 2,
      headRevision: 3,
      headSha: "a".repeat(40),
      question: "q1",
      attempt: "qa1",
      verdict: "pass",
      feedback: "You connected both sides.",
      knowledgeBaseHash: hashKnowledge("base"),
    };
    expect(parseReviewQuizGrade(valid).value).toMatchObject({ verdict: "pass", attempt: "qa1" });
    expect(parseReviewQuizGrade({ ...valid, verdict: "maybe" }).errors).toContain("verdict must be pass or retry");
    expect(parseReviewQuizGrade({ ...valid, answerKey: "secret" }).errors).toContain("grade file has unknown or missing fields");
  });
});
