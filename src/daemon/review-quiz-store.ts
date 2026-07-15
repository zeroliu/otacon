import { existsSync, readFileSync } from "node:fs";
import type { CanonicalGitHubRepo, KnowledgeHash, KnowledgeTarget, KnowledgeScope } from "../shared/knowledge.js";
import { reviewRevisionQuizStatePath } from "../shared/paths.js";
import type {
  ReviewQuizAnswerEvent,
  ReviewQuizAttempt,
  ReviewQuizCompanion,
  ReviewQuizGradeInput,
  ReviewQuizPublicState,
  ReviewQuizQuestion,
  ReviewQuizVerdict,
} from "../shared/review-quiz.js";
import { publicQuizState } from "../shared/review-quiz.js";
import type { ReviewRegistrySession } from "../shared/types.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { ReviewStore } from "./review-store.js";
import { quarantineCorruptFile, stringify, writeFileAtomic } from "./store.js";

interface ReviewQuizStateFile {
  version: 1;
  session: string;
  revision: number;
  headRevision: number;
  headSha: string;
  nextAttempt: number;
  attempts: ReviewQuizAttempt[];
}

export class ReviewQuizConflictError extends Error {
  constructor(readonly code: string, message: string, readonly currentHash?: KnowledgeHash) {
    super(message);
  }
}
export class ReviewQuizCorruptError extends Error {}

export interface ReviewQuizStoreDeps { now(): string }
const DEFAULT_DEPS: ReviewQuizStoreDeps = { now: () => new Date().toISOString() };

function statePath(id: string, revision: number): string {
  return reviewRevisionQuizStatePath(id, revision);
}

function backupPath(id: string, revision: number): string {
  return `${statePath(id, revision)}.backup`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validKnowledgeReceipt(
  value: unknown,
  scope: KnowledgeScope,
  projectRepo: CanonicalGitHubRepo,
): boolean {
  const receipt = record(value);
  if (receipt === undefined || !exactKeys(receipt, ["scope", "receipt"]) || receipt.scope !== scope) return false;
  if (scope === "user") return receipt.receipt === "User knowledge";
  if (typeof receipt.receipt !== "string") return false;
  const match = /^Project knowledge \(([^)]+)\)$/.exec(receipt.receipt);
  return match?.[1] === projectRepo;
}

function parseState(
  raw: unknown,
  companion: ReviewQuizCompanion,
  projectRepo: CanonicalGitHubRepo,
): ReviewQuizStateFile | undefined {
  const item = record(raw);
  if (item === undefined || !exactKeys(item, ["version", "session", "revision", "headRevision", "headSha", "nextAttempt", "attempts"]) ||
      item.version !== 1 ||
      item.session !== companion.session || item.revision !== companion.revision ||
      item.headRevision !== companion.headRevision || item.headSha !== companion.headSha ||
      !Number.isInteger(item.nextAttempt) || (item.nextAttempt as number) < 1 || !Array.isArray(item.attempts)) return undefined;
  const ids = new Set<string>();
  const keys = new Set<string>();
  const questionCounts = new Map<string, number>();
  const terminalQuestions = new Set<string>();
  for (const [index, rawAttempt] of item.attempts.entries()) {
    const attempt = record(rawAttempt);
    if (attempt === undefined || (attempt.status !== "pending" && attempt.status !== "retry" && attempt.status !== "pass")) return undefined;
    const baseFields = ["id", "questionId", "ordinal", "idempotencyKey", "answer", "submittedAt", "status", "knowledgeBaseHash"];
    const fieldsValid = attempt.status === "pending"
      ? exactKeys(attempt, baseFields, ["gradeStartedAt"])
      : exactKeys(attempt, [...baseFields, "gradeStartedAt", "feedback", "gradedAt", "knowledge"]);
    const question = companion.questions.find((candidate) => candidate.id === attempt.questionId);
    const expectedOrdinal = (questionCounts.get(String(attempt.questionId)) ?? 0) + 1;
    if (!fieldsValid || attempt.id !== `qa${index + 1}` || ids.has(attempt.id as string) || question === undefined ||
        terminalQuestions.has(question.id) || !Number.isInteger(attempt.ordinal) || attempt.ordinal !== expectedOrdinal ||
        typeof attempt.idempotencyKey !== "string" || attempt.idempotencyKey === "" || attempt.idempotencyKey.length > 128 ||
        keys.has(attempt.idempotencyKey) || typeof attempt.answer !== "string" || attempt.answer.trim() === "" ||
        attempt.answer.length > 20_000 || !isIsoTimestamp(attempt.submittedAt) ||
        typeof attempt.knowledgeBaseHash !== "string" || !/^[a-f0-9]{64}$/.test(attempt.knowledgeBaseHash)) return undefined;
    if (attempt.gradeStartedAt !== undefined && (!isIsoTimestamp(attempt.gradeStartedAt) ||
        Date.parse(attempt.gradeStartedAt) < Date.parse(attempt.submittedAt))) return undefined;
    if (attempt.status === "pending") {
      // One pending attempt is the terminal history item for its question until
      // a grade commits. No later attempt may be hidden behind it.
      terminalQuestions.add(question.id);
    } else {
      if (typeof attempt.feedback !== "string" || attempt.feedback.trim() === "" || attempt.feedback.length > 1_000 ||
          !isIsoTimestamp(attempt.gradedAt) || attempt.gradeStartedAt === undefined ||
          Date.parse(attempt.gradedAt) < Date.parse(attempt.gradeStartedAt) ||
          !validKnowledgeReceipt(attempt.knowledge, question.concept.scope, projectRepo)) return undefined;
      if (attempt.status === "pass") terminalQuestions.add(question.id);
    }
    ids.add(attempt.id as string);
    keys.add(attempt.idempotencyKey);
    questionCounts.set(question.id, expectedOrdinal);
  }
  if ((item.nextAttempt as number) !== item.attempts.length + 1) return undefined;
  return item as unknown as ReviewQuizStateFile;
}

function readStateFile(
  path: string,
  companion: ReviewQuizCompanion,
  projectRepo: CanonicalGitHubRepo,
): ReviewQuizStateFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseState(JSON.parse(readFileSync(path, "utf8")) as unknown, companion, projectRepo);
  } catch {
    return undefined;
  }
}

function emptyState(companion: ReviewQuizCompanion): ReviewQuizStateFile {
  return {
    version: 1,
    session: companion.session,
    revision: companion.revision,
    headRevision: companion.headRevision,
    headSha: companion.headSha,
    nextAttempt: 1,
    attempts: [],
  };
}

function sectionRange(markdown: string, title: string): { start: number; end: number; lines: string[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const heading = `## ${title}`;
  const start = lines.findIndex((line) => line === heading);
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  if (start < 0) throw new Error(`knowledge summary is missing ${heading}`);
  return { start, end: end < 0 ? lines.length : end, lines };
}

function marker(conceptId: string, sessionId: string, revision: number, attemptId: string): string {
  return `<!-- otacon:quiz:${conceptId}:${sessionId}:r${revision}:${attemptId} -->`;
}

function hasManagedMarker(markdown: string, ownedMarker: string): boolean {
  for (const title of ["Demonstrated concepts", "Needs reinforcement"]) {
    const range = sectionRange(markdown, title);
    if (range.lines.slice(range.start + 1, range.end).some((line) => line.startsWith(`- ${ownedMarker} `))) {
      return true;
    }
  }
  return false;
}

/** Patch only deterministic managed list items; all user-authored prose survives byte-for-byte. */
export function patchQuizKnowledge(
  markdown: string,
  question: ReviewQuizQuestion,
  sessionId: string,
  revision: number,
  attemptId: string,
  verdict: ReviewQuizVerdict,
  feedback: string,
): string {
  let value = markdown;
  const conceptPrefix = `- <!-- otacon:quiz:${question.concept.id}:`;
  for (const title of ["Demonstrated concepts", "Needs reinforcement"]) {
    const range = sectionRange(value, title);
    const body = range.lines.slice(range.start + 1, range.end).filter((line) => !line.startsWith(conceptPrefix));
    const normalized = body.some((line) => line.trim() !== "" && line !== "- None yet.")
      ? body.filter((line) => line !== "- None yet.")
      : ["", "- None yet.", ""];
    value = [...range.lines.slice(0, range.start + 1), ...normalized, ...range.lines.slice(range.end)].join("\n");
  }
  const targetTitle = verdict === "pass" ? "Demonstrated concepts" : "Needs reinforcement";
  const range = sectionRange(value, targetTitle);
  const line = verdict === "pass"
    ? `- ${marker(question.concept.id, sessionId, revision, attemptId)} ${question.concept.label}`
    : `- ${marker(question.concept.id, sessionId, revision, attemptId)} ${question.concept.label} — ${feedback.replace(/\s+/g, " ").trim()}`;
  const body = range.lines.slice(range.start + 1, range.end).filter((entry) => entry !== "- None yet.");
  while (body.length > 0 && body[0] === "") body.shift();
  while (body.length > 0 && body.at(-1) === "") body.pop();
  return [...range.lines.slice(0, range.start + 1), "", ...body, line, "", ...range.lines.slice(range.end)]
    .join("\n").replace(/\n*$/, "\n");
}

export class ReviewQuizStore {
  constructor(
    private readonly reviews: ReviewStore,
    private readonly knowledge: KnowledgeStore,
    private readonly deps: ReviewQuizStoreDeps = DEFAULT_DEPS,
  ) {}

  private companion(session: ReviewRegistrySession, revision: number): ReviewQuizCompanion {
    const companion = this.reviews.readQuizCompanion(session.id, revision);
    if (companion.headRevision !== session.review.revision || companion.headSha !== session.review.head.sha) {
      throw new ReviewQuizConflictError("E_QUIZ_STALE_HEAD", "quiz belongs to an older PR head");
    }
    if (this.reviews.latestSubmittedRevision(session.id) !== revision) {
      throw new ReviewQuizConflictError("E_QUIZ_STALE_REPORT", "quiz belongs to an older report revision");
    }
    return companion;
  }

  private readState(
    companion: ReviewQuizCompanion,
    session: ReviewRegistrySession,
  ): ReviewQuizStateFile {
    const path = statePath(companion.session, companion.revision);
    if (!existsSync(path)) return emptyState(companion);
    const projectRepo = session.review.pullRequest.identity.repository as CanonicalGitHubRepo;
    const primary = readStateFile(path, companion, projectRepo);
    if (primary !== undefined) return primary;
    const backup = readStateFile(backupPath(companion.session, companion.revision), companion, projectRepo);
    if (backup === undefined) throw new ReviewQuizCorruptError(`quiz state for revision ${companion.revision} is corrupt`);
    quarantineCorruptFile(path, "review quiz state");
    writeFileAtomic(path, stringify(backup));
    return backup;
  }

  private writeState(state: ReviewQuizStateFile): void {
    const content = stringify(state);
    writeFileAtomic(statePath(state.session, state.revision), content);
    writeFileAtomic(backupPath(state.session, state.revision), content);
  }

  publicState(session: ReviewRegistrySession, revision: number): ReviewQuizPublicState {
    const companion = this.reviews.readQuizCompanion(session.id, revision);
    return publicQuizState(companion, this.readState(companion, session).attempts);
  }

  pendingCount(session: ReviewRegistrySession): number {
    const revision = this.reviews.latestSubmittedRevision(session.id);
    if (revision < 1) return 0;
    return this.publicState(session, revision).progress.pending;
  }

  /**
   * Rebuild work from the durable attempt source after a daemon restart.
   * Choices finish locally; only still-pending open attempts produce private
   * agent events for the caller to deduplicate against the durable queue.
   */
  recoverPending(session: ReviewRegistrySession): {
    quiz: ReviewQuizPublicState;
    events: ReviewQuizAnswerEvent[];
  } {
    const revision = this.reviews.latestSubmittedRevision(session.id);
    if (revision < 1) {
      throw new ReviewQuizConflictError("E_QUIZ_UNAVAILABLE", "review has no submitted quiz");
    }
    const companion = this.companion(session, revision);
    const state = this.readState(companion, session);
    for (const attempt of state.attempts.filter((candidate) => candidate.status === "pending")) {
      const question = companion.questions.find((candidate) => candidate.id === attempt.questionId);
      if (question === undefined) throw new ReviewQuizCorruptError(`quiz attempt ${attempt.id} names an unknown question`);
      if (question.mode !== "choice") continue;
      // All operations are synchronous in one daemon, so one retry covers the
      // only meaningful race: a competing writer winning the first CAS seam.
      // Persistent failures remain pending and are still safely replayable.
      for (let tryNumber = 0; tryNumber < 2 && attempt.status === "pending"; tryNumber += 1) {
        const current = this.knowledge.read(this.target(session, question));
        if (attempt.knowledgeBaseHash !== current.hash) {
          attempt.knowledgeBaseHash = current.hash;
          this.writeState(state);
        }
        try {
          this.completeChoice(session, companion, state, question, attempt);
        } catch (error) {
          if (!(error instanceof ReviewQuizConflictError)) throw error;
        }
      }
    }
    const events = state.attempts.flatMap((attempt) => {
      if (attempt.status !== "pending") return [];
      const question = companion.questions.find((candidate) => candidate.id === attempt.questionId);
      return question?.mode === "open" ? [this.openEvent(session, companion, question, attempt)] : [];
    });
    return { quiz: publicQuizState(companion, state.attempts), events };
  }

  private target(session: ReviewRegistrySession, question: ReviewQuizQuestion): KnowledgeTarget {
    return question.concept.scope === "user"
      ? { scope: "user" }
      : { scope: "project", repo: session.review.pullRequest.identity.repository as CanonicalGitHubRepo };
  }

  private openEvent(
    session: ReviewRegistrySession,
    companion: ReviewQuizCompanion,
    question: Extract<ReviewQuizQuestion, { mode: "open" }>,
    attempt: ReviewQuizAttempt,
  ): ReviewQuizAnswerEvent {
    if (attempt.knowledgeBaseHash === undefined) {
      throw new ReviewQuizCorruptError(`open attempt ${attempt.id} is missing its knowledge hash`);
    }
    return {
      event: "quiz-answer",
      session: session.id,
      revision: companion.revision,
      headRevision: companion.headRevision,
      headSha: companion.headSha,
      question: question.id,
      attempt: attempt.id,
      answer: attempt.answer,
      concept: question.concept,
      rubric: question.rubric,
      knowledge: { scope: question.concept.scope, baseHash: attempt.knowledgeBaseHash },
    };
  }

  private applyKnowledge(
    session: ReviewRegistrySession,
    question: ReviewQuizQuestion,
    revision: number,
    attempt: ReviewQuizAttempt,
    verdict: ReviewQuizVerdict,
    feedback: string,
    baseHash: KnowledgeHash,
  ): { scope: "user" | "project"; receipt: string } {
    const target = this.target(session, question);
    const current = this.knowledge.read(target);
    const desired = patchQuizKnowledge(
      current.markdown,
      question,
      session.id,
      revision,
      attempt.id,
      verdict,
      feedback,
    );
    const ownMarker = marker(question.concept.id, session.id, revision, attempt.id);
    if (current.hash !== baseHash && !hasManagedMarker(current.markdown, ownMarker)) {
      throw new ReviewQuizConflictError("E_KNOWLEDGE_CONFLICT", "knowledge changed after the answer was submitted; grade again with the current hash", current.hash);
    }
    if (desired !== current.markdown) {
      const result = this.knowledge.replace(target, desired, current.hash);
      if (!result.ok) throw new ReviewQuizConflictError("E_KNOWLEDGE_CONFLICT", "knowledge changed while applying the grade", result.current.hash);
    }
    this.knowledge.appendEvidenceOnce(target, {
      id: `quiz:${session.id}:r${revision}:${question.id}:${attempt.id}:${verdict}`,
      scope: target.scope,
      ...(target.scope === "project" ? { repo: target.repo } : {}),
      sessionId: session.id,
      pr: { number: session.review.pullRequest.identity.number, headSha: session.review.head.sha },
      conceptId: question.concept.id,
      verdict,
      rationale: feedback,
      // Persisted before knowledge mutation, so crash replay has identical bytes.
      at: attempt.gradeStartedAt ?? attempt.submittedAt,
    });
    return {
      scope: target.scope,
      receipt: target.scope === "user" ? "User knowledge" : `Project knowledge (${target.repo})`,
    };
  }

  private completeChoice(
    session: ReviewRegistrySession,
    companion: ReviewQuizCompanion,
    state: ReviewQuizStateFile,
    question: Extract<ReviewQuizQuestion, { mode: "choice" }>,
    attempt: ReviewQuizAttempt,
  ): { quiz: ReviewQuizPublicState; attempt: ReviewQuizAttempt } {
    if (!question.options.includes(attempt.answer)) throw new ReviewQuizConflictError("E_QUIZ_CHOICE", "answer must name one offered choice");
    if (attempt.knowledgeBaseHash === undefined) throw new ReviewQuizCorruptError("choice attempt is missing its knowledge hash");
    if (attempt.gradeStartedAt === undefined) {
      attempt.gradeStartedAt = this.deps.now();
      this.writeState(state);
    }
    const verdict: ReviewQuizVerdict = attempt.answer === question.answerKey ? "pass" : "retry";
    const feedback = verdict === "pass" ? "Correct — the bounded contract is understood." : "That choice does not match the changed behavior. Try again.";
    const receipt = this.applyKnowledge(session, question, companion.revision, attempt, verdict, feedback, attempt.knowledgeBaseHash);
    Object.assign(attempt, { status: verdict, feedback, gradedAt: this.deps.now(), knowledge: receipt });
    this.writeState(state);
    return { quiz: publicQuizState(companion, state.attempts), attempt };
  }

  answer(
    session: ReviewRegistrySession,
    input: { revision: number; question: string; answer: string; idempotencyKey: string },
  ): { quiz: ReviewQuizPublicState; attempt: ReviewQuizAttempt; event?: ReviewQuizAnswerEvent; repeated: boolean } {
    const companion = this.companion(session, input.revision);
    const question = companion.questions.find((item) => item.id === input.question);
    if (question === undefined) throw new ReviewQuizConflictError("E_QUIZ_QUESTION", `unknown quiz question ${input.question}`);
    if (input.answer.trim() === "" || input.answer.length > 20_000) throw new ReviewQuizConflictError("E_QUIZ_ANSWER", "answer must be non-empty and at most 20000 characters");
    if (input.idempotencyKey.trim() === "" || input.idempotencyKey.length > 128) throw new ReviewQuizConflictError("E_QUIZ_IDEMPOTENCY", "idempotencyKey must be 1..128 characters");
    const state = this.readState(companion, session);
    const repeated = state.attempts.find((attempt) => attempt.idempotencyKey === input.idempotencyKey);
    if (repeated !== undefined) {
      if (repeated.questionId !== question.id || repeated.answer !== input.answer.trim()) {
        throw new ReviewQuizConflictError("E_QUIZ_IDEMPOTENCY", "idempotencyKey already names a different answer");
      }
      if (repeated.status === "pending" && question.mode === "choice") {
        // A choice has a daemon-known deterministic verdict. If its first
        // immediate grade lost a knowledge CAS, replay the same durable answer
        // against the latest profile rather than trapping the browser on an
        // ungradeable stale hash. applyKnowledge still CASes the actual write.
        const current = this.knowledge.read(this.target(session, question));
        if (repeated.knowledgeBaseHash !== current.hash) {
          repeated.knowledgeBaseHash = current.hash;
          this.writeState(state);
        }
        return { ...this.completeChoice(session, companion, state, question, repeated), repeated: true };
      }
      const repeatedEvent = repeated.status === "pending" && question.mode === "open"
        ? this.openEvent(session, companion, question, repeated)
        : undefined;
      return { quiz: publicQuizState(companion, state.attempts), attempt: repeated, ...(repeatedEvent ? { event: repeatedEvent } : {}), repeated: true };
    }
    if (state.attempts.some((attempt) => attempt.questionId === question.id && attempt.status === "pass")) {
      throw new ReviewQuizConflictError("E_QUIZ_PASSED", "question is already passed");
    }
    if (state.attempts.some((attempt) => attempt.questionId === question.id && attempt.status === "pending")) {
      throw new ReviewQuizConflictError("E_QUIZ_GRADING", "the latest answer is still being graded");
    }
    if (question.mode === "choice" && !question.options.includes(input.answer.trim())) {
      throw new ReviewQuizConflictError("E_QUIZ_CHOICE", "answer must name one offered choice");
    }
    const ordinal = state.attempts.filter((attempt) => attempt.questionId === question.id).length + 1;
    const document = this.knowledge.read(this.target(session, question));
    const attempt: ReviewQuizAttempt = {
      id: `qa${state.nextAttempt}`,
      questionId: question.id,
      ordinal,
      idempotencyKey: input.idempotencyKey,
      answer: input.answer.trim(),
      submittedAt: this.deps.now(),
      status: "pending",
      knowledgeBaseHash: document.hash,
    };
    state.nextAttempt += 1;
    state.attempts.push(attempt);
    this.writeState(state);
    if (question.mode === "choice") {
      return { ...this.completeChoice(session, companion, state, question, attempt), repeated: false };
    }
    return {
      quiz: publicQuizState(companion, state.attempts),
      attempt,
      repeated: false,
      event: this.openEvent(session, companion, question, attempt),
    };
  }

  grade(session: ReviewRegistrySession, input: ReviewQuizGradeInput): { quiz: ReviewQuizPublicState; attempt: ReviewQuizAttempt; repeated: boolean } {
    const companion = this.companion(session, input.revision);
    if (input.session !== session.id || input.headRevision !== companion.headRevision || input.headSha !== companion.headSha) {
      throw new ReviewQuizConflictError("E_QUIZ_STALE_GRADE", "grade identity does not match the current quiz");
    }
    const question = companion.questions.find((item) => item.id === input.question);
    if (question === undefined || question.mode !== "open") throw new ReviewQuizConflictError("E_QUIZ_QUESTION", "only open questions accept agent grades");
    const state = this.readState(companion, session);
    const attempt = state.attempts.find((item) => item.id === input.attempt && item.questionId === question.id);
    if (attempt === undefined) throw new ReviewQuizConflictError("E_QUIZ_ATTEMPT", "unknown quiz attempt");
    if (attempt.status !== "pending") {
      if (attempt.status !== input.verdict || attempt.feedback !== input.feedback) {
        throw new ReviewQuizConflictError("E_QUIZ_GRADE_CONFLICT", "attempt already has a different grade");
      }
      return { quiz: publicQuizState(companion, state.attempts), attempt, repeated: true };
    }
    if (attempt.gradeStartedAt === undefined) {
      attempt.gradeStartedAt = this.deps.now();
      this.writeState(state);
    }
    const receipt = this.applyKnowledge(session, question, companion.revision, attempt, input.verdict, input.feedback, input.knowledgeBaseHash);
    Object.assign(attempt, {
      status: input.verdict,
      feedback: input.feedback,
      gradedAt: this.deps.now(),
      knowledge: receipt,
    });
    this.writeState(state);
    return { quiz: publicQuizState(companion, state.attempts), attempt, repeated: false };
  }
}
