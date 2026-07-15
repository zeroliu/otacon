import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { canonicalizeGitHubRepo, hashKnowledge, parseKnowledgeHash } from "../shared/knowledge.js";
import type { CanonicalGitHubRepo, KnowledgeDocument } from "../shared/knowledge.js";
import {
  reviewRevisionDir,
  reviewRevisionMetadataPath,
  reviewRevisionProjectKnowledgePath,
  reviewRevisionQuizPath,
  reviewRevisionReportPath,
  reviewRevisionSnapshotPath,
  reviewRevisionSubmissionDir,
  reviewRevisionSubmissionMetadataPath,
  reviewRevisionUserKnowledgePath,
  reviewRevisionWarningsPath,
  reviewRevisionsDir,
} from "../shared/paths.js";
import { parseReviewReport } from "../shared/review-report.js";
import type {
  ReviewKnowledgeSnapshot,
  ReviewReportLintIssue,
  ReviewReportRevision,
  ReviewReportRevisionPayload,
} from "../shared/review-report.js";
import type { ReviewRegistrySession } from "../shared/types.js";
import { parseReviewQuizCompanion } from "../shared/review-quiz.js";
import type { ReviewQuizCompanion } from "../shared/review-quiz.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { lintReviewReport } from "./review-linter.js";
import { hashReviewSnapshot } from "./review-snapshot.js";
import { stringify } from "./store.js";

export class ReviewRevisionExistsError extends Error {}
export class ReviewRevisionCorruptError extends Error {}
export class ReviewReportInvalidError extends Error {
  constructor(readonly issues: ReviewReportLintIssue[]) {
    super("review report failed validation");
  }
}

export interface ReviewStoreDeps {
  now(): string;
}

const DEFAULT_DEPS: ReviewStoreDeps = { now: () => new Date().toISOString() };
let temporarySerial = 0;

interface StoredSnapshotManifest {
  version: 1;
  session: string;
  revision: number;
  headRevision: number;
  headSha: string;
  capturedAt: string;
  hash: string;
  user: { hash: string; file: "user.md" };
  project: { repo: string; hash: string; file: "project.md" };
}

interface StoredSubmissionManifest {
  version: 1;
  session: string;
  revision: number;
  reportHash: string;
  quizHash: string;
  warningsHash: string;
  submittedAtHash: string;
}

function hashStoredBytes(value: string): string {
  return hashKnowledge(value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function parseRevision(raw: unknown): ReviewReportRevision | undefined {
  const value = raw as ReviewReportRevision;
  if (
    typeof value !== "object" || value === null || value.version !== 1 ||
    typeof value.session !== "string" || !Number.isInteger(value.revision) || value.revision < 1 ||
    !Number.isInteger(value.headRevision) || value.headRevision < 1 ||
    typeof value.headSha !== "string" || value.headSha === "" ||
    parseKnowledgeHash(value.snapshotHash) === undefined ||
    typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)) ||
    value.status !== "prepared" || value.submittedAt !== undefined
  ) return undefined;
  return value;
}

function writeExclusiveDirectory(target: string, populate: (directory: string) => void): void {
  const parent = join(target, "..");
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.tmp-${basename(target)}-${process.pid}-${temporarySerial++}`);
  mkdirSync(temporary);
  try {
    populate(temporary);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export class ReviewStore {
  constructor(
    private readonly knowledge: KnowledgeStore = new KnowledgeStore(),
    private readonly deps: ReviewStoreDeps = DEFAULT_DEPS,
  ) {}

  private recoverTemporaryDirectories(id: string): void {
    try {
      for (const name of readdirSync(reviewRevisionsDir(id))) {
        if (name.startsWith(".tmp-")) {
          rmSync(join(reviewRevisionsDir(id), name), { recursive: true, force: true });
          continue;
        }
        if (!/^r\d+$/.test(name)) continue;
        const revisionDirectory = join(reviewRevisionsDir(id), name);
        for (const child of readdirSync(revisionDirectory)) {
          if (child.startsWith(".tmp-")) {
            rmSync(join(revisionDirectory, child), { recursive: true, force: true });
          }
        }
      }
    } catch {
      // Missing review history is the normal first-run state.
    }
  }

  listRevisions(id: string): number[] {
    this.recoverTemporaryDirectories(id);
    try {
      return readdirSync(reviewRevisionsDir(id)).flatMap((name) => {
        const match = /^r(\d+)$/.exec(name);
        return match === null ? [] : [Number(match[1])];
      }).sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  latestRevision(id: string): number {
    return this.listRevisions(id).at(-1) ?? 0;
  }

  latestSubmittedRevision(id: string): number {
    return this.listRevisions(id).filter((revision) => existsSync(reviewRevisionSubmissionDir(id, revision))).at(-1) ?? 0;
  }

  latestForHead(session: ReviewRegistrySession): ReviewReportRevisionPayload | undefined {
    const revisions = this.listRevisions(session.id).reverse();
    for (const revision of revisions) {
      const payload = this.readRevision(session.id, revision);
      if (
        payload.revision.headSha === session.review.head.sha &&
        payload.revision.headRevision === session.review.revision
      ) return payload;
    }
    return undefined;
  }

  /** Capture both current knowledge scopes in one atomically-published revision directory. */
  beginRevision(session: ReviewRegistrySession): ReviewReportRevisionPayload {
    this.recoverTemporaryDirectories(session.id);
    const revision = this.latestRevision(session.id) + 1;
    const user = this.knowledge.read({ scope: "user" });
    const project = this.knowledge.read({ scope: "project", repo: session.review.pullRequest.identity.repository });
    const hash = hashReviewSnapshot(user.hash, project.repo!, project.hash);
    const capturedAt = this.deps.now();
    const record: ReviewReportRevision = {
      version: 1,
      session: session.id,
      revision,
      headRevision: session.review.revision,
      headSha: session.review.head.sha,
      snapshotHash: hash,
      createdAt: capturedAt,
      status: "prepared",
    };
    const manifest: StoredSnapshotManifest = {
      version: 1,
      session: session.id,
      revision,
      headRevision: session.review.revision,
      headSha: session.review.head.sha,
      capturedAt,
      hash,
      user: { hash: user.hash, file: "user.md" },
      project: { repo: project.repo!, hash: project.hash, file: "project.md" },
    };
    const target = reviewRevisionDir(session.id, revision);
    if (existsSync(target)) throw new ReviewRevisionExistsError(`review revision ${revision} already exists`);
    writeExclusiveDirectory(target, (directory) => {
      writeFileSync(join(directory, "revision.json"), stringify(record));
      writeFileSync(join(directory, "knowledge-snapshot.json"), stringify(manifest));
      writeFileSync(join(directory, "user.md"), user.markdown);
      writeFileSync(join(directory, "project.md"), project.markdown);
    });
    return this.readRevision(session.id, revision);
  }

  /** Reopen returns the same frozen input; a new head gets a fresh report revision. */
  prepareForSession(session: ReviewRegistrySession): ReviewReportRevisionPayload {
    return this.latestForHead(session) ?? this.beginRevision(session);
  }

  submit(
    session: ReviewRegistrySession,
    input: { report: string; quiz: string },
  ): ReviewReportRevisionPayload {
    this.recoverTemporaryDirectories(session.id);
    const parsed = parseReviewReport(input.report);
    const revision = parsed.frontmatter?.revision;
    if (revision === undefined) throw new ReviewReportInvalidError(lintReviewReport(input.report).errors);
    const current = this.readRevision(session.id, revision);
    if (current.revision.status === "submitted") {
      throw new ReviewRevisionExistsError(`review revision ${revision} is already submitted`);
    }
    const lint = lintReviewReport(input.report);
    const expectedPr = `${session.review.pullRequest.identity.key}`;
    const contractIssues: ReviewReportLintIssue[] = [];
    const contractError = (code: string, message: string): void => {
      contractIssues.push({ code, severity: "error", message });
    };
    if (current.revision.headSha !== session.review.head.sha) {
      contractError("E_REPORT_HEAD_STALE", "prepared report revision belongs to an older PR head; begin a new revision");
    }
    if (parsed.frontmatter?.session !== session.id) contractError("E_REPORT_SESSION", "report session does not match the target session");
    if (parsed.frontmatter?.pr !== expectedPr) contractError("E_REPORT_PR", "report PR identity does not match the review session");
    if (parsed.frontmatter?.head !== current.revision.headSha) contractError("E_REPORT_HEAD", "report head does not match its prepared revision");
    if (parsed.frontmatter?.knowledgeSnapshot !== current.snapshot.hash) {
      contractError("E_REPORT_SNAPSHOT", "report knowledge-snapshot does not own this prepared revision");
    }
    let quiz: unknown;
    try {
      quiz = JSON.parse(input.quiz) as unknown;
    } catch {
      contractError("E_REPORT_QUIZ_JSON", "quiz companion must be valid JSON");
    }
    const parsedQuiz = parseReviewQuizCompanion(quiz);
    if (parsedQuiz.value === undefined) {
      for (const message of parsedQuiz.errors) contractError("E_REPORT_QUIZ_SHAPE", message);
    } else {
      if (parsedQuiz.value.session !== session.id) contractError("E_REPORT_QUIZ_SESSION", "quiz session does not match the report");
      if (parsedQuiz.value.revision !== revision) contractError("E_REPORT_QUIZ_REVISION", "quiz revision does not match the report");
      if (parsedQuiz.value.headRevision !== current.revision.headRevision || parsedQuiz.value.headSha !== current.revision.headSha) {
        contractError("E_REPORT_QUIZ_HEAD", "quiz head identity does not match the prepared report revision");
      }
    }
    const errors = [...lint.errors, ...contractIssues];
    if (errors.length > 0) throw new ReviewReportInvalidError(errors);

    const target = reviewRevisionSubmissionDir(session.id, revision);
    if (existsSync(target)) throw new ReviewRevisionExistsError(`review revision ${revision} is already submitted`);
    const normalizedReport = input.report.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
    const quizJson = stringify(quiz);
    const warningsJson = stringify(lint.warnings);
    const submittedAt = `${this.deps.now()}\n`;
    const submission: StoredSubmissionManifest = {
      version: 1,
      session: session.id,
      revision,
      reportHash: hashStoredBytes(normalizedReport),
      quizHash: hashStoredBytes(quizJson),
      warningsHash: hashStoredBytes(warningsJson),
      submittedAtHash: hashStoredBytes(submittedAt),
    };
    writeExclusiveDirectory(target, (directory) => {
      writeFileSync(join(directory, "submission.json"), stringify(submission));
      writeFileSync(join(directory, "report.md"), normalizedReport);
      writeFileSync(join(directory, "quiz.json"), quizJson);
      writeFileSync(join(directory, "warnings.json"), warningsJson);
      writeFileSync(join(directory, "submitted-at"), submittedAt);
    });
    return this.readRevision(session.id, revision);
  }

  /** Daemon-private raw companion; never return this object on a browser route. */
  readQuizCompanion(id: string, revision: number): ReviewQuizCompanion {
    const payload = this.readRevision(id, revision);
    if (payload.revision.status !== "submitted") {
      throw new ReviewRevisionCorruptError(`review revision ${revision} has no submitted quiz companion`);
    }
    const parsed = parseReviewQuizCompanion(payload.quiz);
    if (parsed.value === undefined) {
      throw new ReviewRevisionCorruptError(`review revision ${revision} quiz companion is invalid: ${parsed.errors.join("; ")}`);
    }
    return parsed.value;
  }

  readRevision(id: string, revision: number): ReviewReportRevisionPayload {
    try {
      const record = parseRevision(readJson(reviewRevisionMetadataPath(id, revision)));
      const manifest = readJson(reviewRevisionSnapshotPath(id, revision)) as StoredSnapshotManifest;
      const userMarkdown = readFileSync(reviewRevisionUserKnowledgePath(id, revision), "utf8");
      const projectMarkdown = readFileSync(reviewRevisionProjectKnowledgePath(id, revision), "utf8");
      const userHash = parseKnowledgeHash(manifest?.user?.hash);
      const projectHash = parseKnowledgeHash(manifest?.project?.hash);
      const snapshotHash = parseKnowledgeHash(manifest?.hash);
      const projectRepo = typeof manifest?.project?.repo === "string"
        ? canonicalizeGitHubRepo(manifest.project.repo)
        : undefined;
      if (
        record === undefined || record.session !== id || record.revision !== revision ||
        manifest?.version !== 1 || manifest.session !== id || manifest.revision !== revision ||
        manifest.headRevision !== record.headRevision || manifest.headSha !== record.headSha ||
        manifest.capturedAt !== record.createdAt || Number.isNaN(Date.parse(manifest.capturedAt)) ||
        manifest.user.file !== "user.md" || manifest.project.file !== "project.md" ||
        projectRepo === undefined || projectRepo !== manifest.project.repo ||
        userHash === undefined || projectHash === undefined || snapshotHash === undefined ||
        hashKnowledge(userMarkdown) !== userHash || hashKnowledge(projectMarkdown) !== projectHash ||
        hashReviewSnapshot(userHash, projectRepo, projectHash) !== snapshotHash ||
        record.snapshotHash !== snapshotHash
      ) throw new Error("snapshot manifest mismatch");
      const submitted = existsSync(reviewRevisionSubmissionDir(id, revision));
      let submittedAt: string | undefined;
      let report: string | undefined;
      let quiz: unknown;
      let warnings: unknown = [];
      if (submitted) {
        const submission = readJson(reviewRevisionSubmissionMetadataPath(id, revision)) as StoredSubmissionManifest;
        const submittedAtBytes = readFileSync(join(reviewRevisionSubmissionDir(id, revision), "submitted-at"), "utf8");
        const reportBytes = readFileSync(reviewRevisionReportPath(id, revision), "utf8");
        const quizBytes = readFileSync(reviewRevisionQuizPath(id, revision), "utf8");
        const warningBytes = readFileSync(reviewRevisionWarningsPath(id, revision), "utf8");
        if (
          submission?.version !== 1 || submission.session !== id || submission.revision !== revision ||
          hashStoredBytes(reportBytes) !== submission.reportHash ||
          hashStoredBytes(quizBytes) !== submission.quizHash ||
          hashStoredBytes(warningBytes) !== submission.warningsHash ||
          hashStoredBytes(submittedAtBytes) !== submission.submittedAtHash
        ) throw new Error("submission manifest mismatch");
        submittedAt = submittedAtBytes.trim();
        if (submittedAt === "" || Number.isNaN(Date.parse(submittedAt))) throw new Error("submitted-at is invalid");
        report = reportBytes;
        quiz = JSON.parse(quizBytes) as unknown;
        warnings = JSON.parse(warningBytes) as unknown;
      }
      const resolvedRecord: ReviewReportRevision = {
        ...record,
        status: submitted ? "submitted" : "prepared",
        ...(submittedAt ? { submittedAt } : {}),
      };
      const snapshot: ReviewKnowledgeSnapshot = {
        version: 1,
        session: id,
        revision,
        headRevision: manifest.headRevision,
        headSha: manifest.headSha,
        capturedAt: manifest.capturedAt,
        hash: snapshotHash,
        user: { hash: userHash, markdown: userMarkdown },
        project: { repo: projectRepo, hash: projectHash, markdown: projectMarkdown },
      };
      if (!Array.isArray(warnings)) throw new Error("warnings must be an array");
      return {
        revision: resolvedRecord,
        snapshot,
        ...(submitted ? {
          report,
          quiz,
          warnings: warnings as ReviewReportLintIssue[],
        } : { warnings: [] }),
      };
    } catch (error) {
      if (error instanceof ReviewRevisionCorruptError) throw error;
      throw new ReviewRevisionCorruptError(
        `review revision ${revision} is incomplete or corrupt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
