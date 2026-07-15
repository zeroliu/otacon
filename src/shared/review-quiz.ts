import { parseKnowledgeHash } from "./knowledge.js";
import type { KnowledgeHash, KnowledgeScope } from "./knowledge.js";

export const REVIEW_QUIZ_MAX_QUESTIONS = 20;

export interface ReviewQuizConcept {
  id: string;
  label: string;
  scope: KnowledgeScope;
}

interface ReviewQuizQuestionBase {
  id: string;
  concept: ReviewQuizConcept;
  prompt: string;
  rubric: { criteria: string[] };
}

export type ReviewQuizQuestion =
  | (ReviewQuizQuestionBase & { mode: "open"; options?: never; answerKey?: never })
  | (ReviewQuizQuestionBase & { mode: "choice"; options: string[]; answerKey: string });

/** Immutable, daemon-private companion submitted beside one report revision. */
export interface ReviewQuizCompanion {
  version: 1;
  session: string;
  revision: number;
  headRevision: number;
  headSha: string;
  questions: ReviewQuizQuestion[];
}

export type ReviewQuizAttemptStatus = "pending" | "retry" | "pass";
export type ReviewQuizVerdict = "retry" | "pass";

export interface ReviewQuizAttempt {
  id: string;
  questionId: string;
  ordinal: number;
  idempotencyKey: string;
  answer: string;
  submittedAt: string;
  status: ReviewQuizAttemptStatus;
  /** Frozen at open-answer submission; daemon-private and omitted from public projections. */
  knowledgeBaseHash?: KnowledgeHash;
  /** Stable private transaction time persisted before knowledge mutation. */
  gradeStartedAt?: string;
  feedback?: string;
  gradedAt?: string;
  knowledge?: { scope: KnowledgeScope; receipt: string };
}

/** Exact browser-safe attempt projection; transport/CAS fields stay daemon-private. */
export interface ReviewQuizPublicAttempt {
  id: string;
  questionId: string;
  ordinal: number;
  answer: string;
  submittedAt: string;
  status: ReviewQuizAttemptStatus;
  feedback?: string;
  gradedAt?: string;
  knowledge?: { scope: KnowledgeScope; receipt: string };
}

export interface ReviewQuizPublicQuestion {
  id: string;
  concept: ReviewQuizConcept;
  prompt: string;
  mode: "open" | "choice";
  options?: string[];
  status: "unanswered" | "grading" | "retry" | "passed";
  attempts: number;
  latest?: ReviewQuizPublicAttempt;
}

/** Browser-safe projection. Rubrics and choice keys are deliberately absent. */
export interface ReviewQuizPublicState {
  version: 1;
  session: string;
  revision: number;
  headRevision: number;
  headSha: string;
  questions: ReviewQuizPublicQuestion[];
  progress: { passed: number; total: number; pending: number };
  /** The definition belongs to a prior PR head and is preserved read-only. */
  stale?: true;
}

export interface ReviewQuizAnswerEvent {
  event: "quiz-answer";
  session: string;
  revision: number;
  headRevision: number;
  headSha: string;
  question: string;
  attempt: string;
  answer: string;
  concept: ReviewQuizConcept;
  rubric: { criteria: string[] };
  knowledge: { scope: KnowledgeScope; baseHash: KnowledgeHash };
}

export interface ReviewQuizGradeInput {
  version: 1;
  session: string;
  revision: number;
  headRevision: number;
  headSha: string;
  question: string;
  attempt: string;
  verdict: ReviewQuizVerdict;
  feedback: string;
  knowledgeBaseHash: KnowledgeHash;
}

export interface ReviewQuizParseResult<T> {
  value?: T;
  errors: string[];
}

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const SESSION = /^otc_[a-z0-9]+$/;
const SHA = /^[a-f0-9]{6,64}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function nonEmpty(value: unknown, maximum = 4_000): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maximum;
}

function nonEmptyLine(value: unknown, maximum: number): value is string {
  return nonEmpty(value, maximum) && !/[\r\n]/.test(value);
}

function parseConcept(value: unknown, path: string, errors: string[]): ReviewQuizConcept | undefined {
  const item = record(value);
  if (item === undefined || !exactKeys(item, ["id", "label", "scope"])) {
    errors.push(`${path} must contain exactly id, label, and scope`);
    return undefined;
  }
  if (!nonEmpty(item.id, 64) || !ID.test(item.id) || !nonEmptyLine(item.label, 160) ||
      (item.scope !== "user" && item.scope !== "project")) {
    errors.push(`${path} has an invalid id, label, or scope`);
    return undefined;
  }
  return { id: item.id, label: item.label.trim(), scope: item.scope };
}

export function parseReviewQuizCompanion(value: unknown): ReviewQuizParseResult<ReviewQuizCompanion> {
  const errors: string[] = [];
  const item = record(value);
  if (item === undefined || !exactKeys(item, ["version", "session", "revision", "headRevision", "headSha", "questions"])) {
    return { errors: ["quiz companion must contain exactly version, session, revision, headRevision, headSha, and questions"] };
  }
  if (item.version !== 1) errors.push("version must be 1");
  if (typeof item.session !== "string" || !SESSION.test(item.session)) errors.push("session must be an otc_ id");
  if (!Number.isInteger(item.revision) || (item.revision as number) < 1) errors.push("revision must be a positive integer");
  if (!Number.isInteger(item.headRevision) || (item.headRevision as number) < 1) errors.push("headRevision must be a positive integer");
  if (typeof item.headSha !== "string" || !SHA.test(item.headSha)) errors.push("headSha must be a git SHA");
  if (!Array.isArray(item.questions) || item.questions.length < 1 || item.questions.length > REVIEW_QUIZ_MAX_QUESTIONS) {
    errors.push(`questions must contain between 1 and ${REVIEW_QUIZ_MAX_QUESTIONS} entries`);
  }
  const questions: ReviewQuizQuestion[] = [];
  const ids = new Set<string>();
  const concepts = new Set<string>();
  if (Array.isArray(item.questions) && item.questions.length >= 1 && item.questions.length <= REVIEW_QUIZ_MAX_QUESTIONS) {
    item.questions.forEach((raw, index) => {
      const path = `questions[${index}]`;
      const question = record(raw);
      if (question === undefined) {
        errors.push(`${path} must be an object`);
        return;
      }
      const mode = question.mode;
      const required = mode === "choice"
        ? ["id", "concept", "prompt", "mode", "rubric", "options", "answerKey"]
        : ["id", "concept", "prompt", "mode", "rubric"];
      if ((mode !== "open" && mode !== "choice") || !exactKeys(question, required)) {
        errors.push(`${path} has invalid fields for an open or choice question`);
        return;
      }
      const concept = parseConcept(question.concept, `${path}.concept`, errors);
      const rubric = record(question.rubric);
      const criteria = rubric?.criteria;
      if (!nonEmpty(question.id, 64) || !ID.test(question.id) || !nonEmpty(question.prompt) || concept === undefined ||
          rubric === undefined || !exactKeys(rubric, ["criteria"]) || !Array.isArray(criteria) ||
          criteria.length === 0 || criteria.length > 10 || !criteria.every((criterion) => nonEmpty(criterion, 500))) {
        errors.push(`${path} has an invalid id, prompt, or rubric`);
        return;
      }
      if (ids.has(question.id)) errors.push(`${path}.id must be unique`);
      if (concepts.has(concept.id)) errors.push(`${path}.concept.id must be unique`);
      ids.add(question.id);
      concepts.add(concept.id);
      if (mode === "choice") {
        const options = Array.isArray(question.options) && question.options.every((option) => nonEmptyLine(option, 300))
          ? question.options.map((option) => option.trim())
          : undefined;
        const answerKey = typeof question.answerKey === "string" ? question.answerKey.trim() : undefined;
        if (options === undefined || options.length < 2 || options.length > 10 ||
            new Set(options).size !== options.length || answerKey === undefined || !options.includes(answerKey)) {
          errors.push(`${path} choice options must be unique and include answerKey`);
          return;
        }
        questions.push({
          id: question.id,
          concept,
          prompt: question.prompt.trim(),
          mode,
          rubric: { criteria: criteria.map((criterion) => (criterion as string).trim()) },
          options,
          answerKey,
        });
      } else {
        questions.push({
          id: question.id,
          concept,
          prompt: question.prompt.trim(),
          mode,
          rubric: { criteria: criteria.map((criterion) => (criterion as string).trim()) },
        });
      }
    });
  }
  if (errors.length > 0) return { errors };
  return { value: {
    version: 1,
    session: item.session as string,
    revision: item.revision as number,
    headRevision: item.headRevision as number,
    headSha: item.headSha as string,
    questions,
  }, errors: [] };
}

export function parseReviewQuizGrade(value: unknown): ReviewQuizParseResult<ReviewQuizGradeInput> {
  const item = record(value);
  const required = ["version", "session", "revision", "headRevision", "headSha", "question", "attempt", "verdict", "feedback", "knowledgeBaseHash"];
  if (item === undefined || !exactKeys(item, required)) return { errors: ["grade file has unknown or missing fields"] };
  const errors: string[] = [];
  if (item.version !== 1) errors.push("version must be 1");
  if (typeof item.session !== "string" || !SESSION.test(item.session)) errors.push("session must be an otc_ id");
  if (!Number.isInteger(item.revision) || (item.revision as number) < 1) errors.push("revision must be positive");
  if (!Number.isInteger(item.headRevision) || (item.headRevision as number) < 1) errors.push("headRevision must be positive");
  if (typeof item.headSha !== "string" || !SHA.test(item.headSha)) errors.push("headSha is invalid");
  if (typeof item.question !== "string" || !ID.test(item.question)) errors.push("question is invalid");
  if (typeof item.attempt !== "string" || !/^qa\d+$/.test(item.attempt)) errors.push("attempt is invalid");
  if (item.verdict !== "pass" && item.verdict !== "retry") errors.push("verdict must be pass or retry");
  if (!nonEmpty(item.feedback, 1_000)) errors.push("feedback must be non-empty");
  const hash = typeof item.knowledgeBaseHash === "string" ? parseKnowledgeHash(item.knowledgeBaseHash) : undefined;
  if (hash === undefined) errors.push("knowledgeBaseHash must be a SHA-256 hash");
  return errors.length > 0 ? { errors } : { value: { ...item, knowledgeBaseHash: hash } as ReviewQuizGradeInput, errors: [] };
}

export function publicQuizState(
  companion: ReviewQuizCompanion,
  attempts: ReviewQuizAttempt[],
): ReviewQuizPublicState {
  const questions = companion.questions.map((question): ReviewQuizPublicQuestion => {
    const history = attempts.filter((attempt) => attempt.questionId === question.id);
    const latest = history.at(-1);
    const status = latest === undefined ? "unanswered"
      : latest.status === "pending" ? "grading"
        : latest.status === "pass" ? "passed" : "retry";
    return {
      id: question.id,
      concept: question.concept,
      prompt: question.prompt,
      mode: question.mode,
      ...(question.mode === "choice" ? { options: question.options } : {}),
      status,
      attempts: history.length,
      ...(latest === undefined ? {} : {
        latest: {
          id: latest.id,
          questionId: latest.questionId,
          ordinal: latest.ordinal,
          answer: latest.answer,
          submittedAt: latest.submittedAt,
          status: latest.status,
          ...(latest.feedback === undefined ? {} : { feedback: latest.feedback }),
          ...(latest.gradedAt === undefined ? {} : { gradedAt: latest.gradedAt }),
          ...(latest.knowledge === undefined ? {} : { knowledge: latest.knowledge }),
        },
      }),
    };
  });
  return {
    version: 1,
    session: companion.session,
    revision: companion.revision,
    headRevision: companion.headRevision,
    headSha: companion.headSha,
    questions,
    progress: {
      passed: questions.filter((question) => question.status === "passed").length,
      total: questions.length,
      pending: questions.filter((question) => question.status === "grading").length,
    },
  };
}
