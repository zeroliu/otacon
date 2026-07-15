// `otacon review` owns PR resolution plus report/quiz authoring commands and
// the conservative checkout/head-refresh bridge used by explicit code-change
// handoffs. Checkout never commits or pushes; it only returns that metadata.
//
// Resolve GitHub metadata while still entirely client-side, reject a different
// base repository before touching the daemon, then cross the one atomic start
// endpoint. Report/quiz paths are advertised but remain uncreated until the
// report persistence phase.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  checkoutReviewWorktree,
  freshReviewMetadata,
} from "../review-worktree.js";
import type { ReviewWorktreeDeps } from "../review-worktree.js";
import {
  projectKnowledgePath,
  reviewDraftPath,
  reviewQuizDraftPath,
  reviewRevisionProjectKnowledgePath,
  reviewRevisionUserKnowledgePath,
  userKnowledgePath,
} from "../../shared/paths.js";
import { parseReviewReport } from "../../shared/review-report.js";
import type { ReviewReportRevisionPayload } from "../../shared/review-report.js";
import type { ReviewRegistrySession } from "../../shared/types.js";
import { parseReviewQuizGrade } from "../../shared/review-quiz.js";
import { api, baseUrl, ensureDaemon } from "../client.js";
import type { ApiResponse } from "../client.js";
import {
  GitHubResolutionError,
  localGitHubRepository,
  resolvePullRequest,
} from "../github.js";
import type { GitHubDeps } from "../github.js";
import { fail, printJson, usageError } from "../output.js";
import { currentBranch, findRepoRoot, realpathOr } from "../session.js";

export interface ReviewCommandDeps {
  cwd(): string;
  ensureDaemon(): Promise<unknown>;
  api(method: string, path: string, body?: unknown): Promise<ApiResponse>;
  github?: GitHubDeps;
  worktree?: ReviewWorktreeDeps;
  readFile?(path: string): string;
}

const DEFAULT_DEPS: ReviewCommandDeps = {
  cwd: () => process.cwd(),
  ensureDaemon,
  api,
};

function responseMessage(response: ApiResponse): string {
  return (response.body.error as { message?: string } | undefined)?.message ?? JSON.stringify(response.body);
}

export async function reviewCommand(
  argv: string[],
  deps: ReviewCommandDeps | undefined = undefined,
): Promise<number> {
  if (argv[0] === "start") return startReview(argv.slice(1), deps);
  if (argv[0] === "submit") return submitReview(argv.slice(1), deps);
  if (argv[0] === "grade") return gradeReview(argv.slice(1), deps);
  if (argv[0] === "checkout") return checkoutReview(argv.slice(1), deps);
  if (argv[0] === "refresh-head") return refreshReviewHead(argv.slice(1), deps);
  if (argv[0] === "respond") return respondReviewThread(argv.slice(1), deps);
  if (argv[0] === "code-status") return updateReviewCodeStatus(argv.slice(1), deps);
  usageError("usage: otacon review start --pr <URL|number> [--force] | submit --report <report.md> --quiz <quiz.json> | grade <question-id> --file <grade.json> | respond <thread-id> --file <response.json> | code-status <thread-id> --file <status.json> | checkout --session <id> | refresh-head --session <id>");
}

function exactKeys(raw: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseSource(raw: unknown): { reportRevision: number; headRevision: number; headSha: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!exactKeys(value, ["reportRevision", "headRevision", "headSha"]) ||
    !Number.isSafeInteger(value.reportRevision) || (value.reportRevision as number) < 1 ||
    !Number.isSafeInteger(value.headRevision) || (value.headRevision as number) < 1 ||
    typeof value.headSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.headSha)) return undefined;
  return value as unknown as { reportRevision: number; headRevision: number; headSha: string };
}

function readReviewOperation(
  argv: string[],
  verb: "respond" | "code-status",
  deps: ReviewCommandDeps | undefined,
): { thread: string; raw: Record<string, unknown>; commandDeps: ReviewCommandDeps } {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { file: { type: "string" } },
  });
  const thread = positionals[0];
  if (positionals.length !== 1 || thread === undefined || !/^[qt][1-9]\d{0,8}$/.test(thread) || values.file === undefined) {
    usageError(`otacon review ${verb} requires <thread-id> --file <json>`);
  }
  const readFile = deps?.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(values.file)) as unknown;
  } catch (error) {
    fail("E_REVIEW_THREAD_INPUT", `could not read ${verb} file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("E_REVIEW_THREAD_INPUT", `${verb} file must be an object`);
  return { thread, raw: raw as Record<string, unknown>, commandDeps: deps ?? DEFAULT_DEPS };
}

async function respondReviewThread(argv: string[], deps: ReviewCommandDeps | undefined): Promise<number> {
  const { thread, raw, commandDeps } = readReviewOperation(argv, "respond", deps);
  const optional = ["responseReportRevision", "saved"].filter((key) => raw[key] !== undefined);
  if (!exactKeys(raw, ["version", "session", "thread", "source", "body", ...optional]) || raw.version !== 1 ||
    typeof raw.session !== "string" || !/^otc_[0-9a-z]{6,64}$/.test(raw.session) || raw.thread !== thread ||
    parseSource(raw.source) === undefined || typeof raw.body !== "string" || raw.body.trim() === "" || raw.body.length > 20_000 ||
    (raw.responseReportRevision !== undefined && (!Number.isSafeInteger(raw.responseReportRevision) || (raw.responseReportRevision as number) < 1))) {
    fail("E_REVIEW_THREAD_INPUT", "response file has an invalid or mismatched shape");
  }
  if (raw.saved !== undefined) {
    if (typeof raw.saved !== "object" || raw.saved === null || Array.isArray(raw.saved) ||
      !exactKeys(raw.saved as Record<string, unknown>, ["scope", "updated"]) ||
      !["user", "project"].includes(String((raw.saved as Record<string, unknown>).scope)) ||
      (raw.saved as Record<string, unknown>).updated !== true) {
      fail("E_REVIEW_MEMORY_ACK", "saved acknowledgement must be {scope:user|project,updated:true}");
    }
  }
  await commandDeps.ensureDaemon();
  const response = await commandDeps.api("POST", `/api/reviews/${raw.session}/threads/${thread}/respond`, {
    source: raw.source,
    body: raw.body,
    ...(raw.responseReportRevision === undefined ? {} : { responseReportRevision: raw.responseReportRevision }),
    ...(raw.saved === undefined ? {} : { saved: raw.saved }),
  });
  if (response.status === 400 || response.status === 404 || response.status === 409) {
    const error = response.body.error as { code?: string; message?: string } | undefined;
    fail(error?.code ?? "E_REVIEW_THREAD_RESPONSE", error?.message ?? "review response was rejected", response.body);
  }
  if (response.status !== 200) fail("E_INTERNAL", `review respond failed: ${JSON.stringify(response.body)}`, undefined, 2);
  printJson({ ok: true, session: raw.session, thread, ...response.body });
  return 0;
}

async function updateReviewCodeStatus(argv: string[], deps: ReviewCommandDeps | undefined): Promise<number> {
  const { thread, raw, commandDeps } = readReviewOperation(argv, "code-status", deps);
  const optional = raw.message === undefined ? [] : ["message"];
  if (!exactKeys(raw, ["version", "session", "thread", "source", "status", ...optional]) || raw.version !== 1 ||
    typeof raw.session !== "string" || !/^otc_[0-9a-z]{6,64}$/.test(raw.session) || raw.thread !== thread || !thread.startsWith("t") ||
    parseSource(raw.source) === undefined || !["working", "completed", "failed"].includes(String(raw.status)) ||
    (raw.message !== undefined && (typeof raw.message !== "string" || raw.message.trim() === "" || raw.message.length > 20_000))) {
    fail("E_REVIEW_CODE_ACTION", "code-status file has an invalid or mismatched shape");
  }
  await commandDeps.ensureDaemon();
  const response = await commandDeps.api("POST", `/api/reviews/${raw.session}/threads/${thread}/code-action/status`, {
    source: raw.source,
    status: raw.status,
    ...(raw.message === undefined ? {} : { message: raw.message }),
  });
  if (response.status === 400 || response.status === 404 || response.status === 409) {
    const error = response.body.error as { code?: string; message?: string } | undefined;
    fail(error?.code ?? "E_REVIEW_CODE_ACTION", error?.message ?? "code status was rejected", response.body);
  }
  if (response.status !== 200) fail("E_INTERNAL", `review code-status failed: ${JSON.stringify(response.body)}`, undefined, 2);
  printJson({ ok: true, session: raw.session, thread, ...response.body });
  return 0;
}

async function requireReviewSession(
  argv: string[],
  command: "checkout" | "refresh-head",
  deps: ReviewCommandDeps | undefined,
): Promise<{ session: ReviewRegistrySession; deps: ReviewCommandDeps }> {
  const { values } = parseArgs({
    args: argv,
    options: { session: { type: "string" } },
  });
  if (values.session === undefined || values.session.trim() === "") {
    usageError(`otacon review ${command} requires --session <id>`);
  }
  const commandDeps = deps ?? DEFAULT_DEPS;
  await commandDeps.ensureDaemon();
  const response = await commandDeps.api("GET", `/api/sessions/${values.session}`);
  if (response.status === 404) fail("E_UNKNOWN_SESSION", `unknown review session: ${values.session}`);
  if (response.status !== 200) {
    fail("E_INTERNAL", `review ${command} could not read the session: ${JSON.stringify(response.body)}`, undefined, 2);
  }
  if (response.body.kind !== "review" || response.body.id !== values.session) {
    if (response.body.kind !== "review") {
      fail("E_SESSION_KIND", `--session ${values.session} is not a PR review`);
    }
    fail("E_INTERNAL", `review ${command} received inconsistent session identity`, undefined, 2);
  }
  return { session: response.body as unknown as ReviewRegistrySession, deps: commandDeps };
}

async function checkoutReview(argv: string[], deps: ReviewCommandDeps | undefined): Promise<number> {
  const resolved = await requireReviewSession(argv, "checkout", deps);
  const fresh = freshReviewMetadata(resolved.session, resolved.deps.github);
  const frozen = resolved.session.review.head;
  if (
    fresh.headSha !== frozen.sha ||
    fresh.headRef !== frozen.ref ||
    fresh.headRepository !== frozen.repository
  ) {
    fail(
      "E_REVIEW_HEAD_STALE",
      `PR head changed since this review was prepared; run otacon review refresh-head --session ${resolved.session.id}`,
    );
  }
  const checkoutSession: ReviewRegistrySession = {
    ...resolved.session,
    review: { ...resolved.session.review, pullRequest: fresh },
  };
  const result = resolved.deps.worktree === undefined
    ? checkoutReviewWorktree(checkoutSession)
    : checkoutReviewWorktree(checkoutSession, resolved.deps.worktree);
  printJson({
    ok: true,
    session: resolved.session.id,
    repository: fresh.identity.repository,
    pr: fresh.url,
    headRevision: resolved.session.review.revision,
    head: frozen.sha,
    branch: frozen.ref,
    ...result,
  });
  return 0;
}

async function refreshReviewHead(argv: string[], deps: ReviewCommandDeps | undefined): Promise<number> {
  const resolved = await requireReviewSession(argv, "refresh-head", deps);
  const pullRequest = freshReviewMetadata(resolved.session, resolved.deps.github);
  const response = await resolved.deps.api(
    "POST",
    `/api/reviews/${resolved.session.id}/head`,
    { pullRequest },
  );
  if (response.status === 400 || response.status === 404 || response.status === 409) {
    const fallback = response.status === 404 ? "E_UNKNOWN_SESSION" : response.status === 409 ? "E_REVIEW_CONFLICT" : "E_BAD_REQUEST";
    const code = (response.body.error as { code?: string } | undefined)?.code ?? fallback;
    fail(code, responseMessage(response));
  }
  if (response.status !== 200) {
    fail("E_INTERNAL", `review refresh-head failed: ${JSON.stringify(response.body)}`, undefined, 2);
  }
  const session = response.body.session as unknown as ReviewRegistrySession;
  const preparation = response.body.preparation as unknown as ReviewReportRevisionPayload | undefined;
  if (session?.kind !== "review" || session.id !== resolved.session.id || preparation === undefined) {
    fail("E_INTERNAL", "review refresh-head did not return a review session and frozen preparation", undefined, 2);
  }
  const action = response.body.action;
  const readOnly = action === "reused-complete";
  printJson({
    ok: true,
    action,
    session: session.id,
    revision: preparation.revision.revision,
    headRevision: session.review.revision,
    head: session.review.head.sha,
    ...(readOnly ? {
      readOnly: true,
      completion: session.review.completions?.at(-1),
    } : {
      report: reviewDraftPath(session.id),
      quiz: reviewQuizDraftPath(session.id),
      knowledge: {
        snapshot: {
          hash: preparation.snapshot.hash,
          user: {
            hash: preparation.snapshot.user.hash,
            path: reviewRevisionUserKnowledgePath(session.id, preparation.revision.revision),
          },
          project: {
            hash: preparation.snapshot.project.hash,
            path: reviewRevisionProjectKnowledgePath(session.id, preparation.revision.revision),
          },
        },
      },
    }),
    url: `${baseUrl()}/s/${session.id}`,
  });
  return 0;
}

async function gradeReview(argv: string[], deps: ReviewCommandDeps | undefined): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { file: { type: "string" } },
  });
  const question = positionals[0];
  if (positionals.length !== 1 || question === undefined || values.file === undefined) {
    usageError("otacon review grade requires <question-id> --file <grade.json>");
  }
  const readFile = deps?.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(values.file)) as unknown;
  } catch (error) {
    fail("E_QUIZ_GRADE", `could not read grade file: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseReviewQuizGrade(raw);
  if (parsed.value === undefined) fail("E_QUIZ_GRADE", parsed.errors.join("; "), { issues: parsed.errors });
  if (parsed.value.question !== question) fail("E_QUIZ_STALE_GRADE", `grade file names ${parsed.value.question}, not ${question}`);
  const commandDeps = deps ?? DEFAULT_DEPS;
  await commandDeps.ensureDaemon();
  const response = await commandDeps.api(
    "POST",
    `/api/reviews/${parsed.value.session}/quiz/${question}/grade`,
    parsed.value,
  );
  if (response.status === 409) {
    const error = response.body.error as { code?: string; message?: string } | undefined;
    fail(error?.code ?? "E_QUIZ_CONFLICT", error?.message ?? "quiz grade conflicted", response.body);
  }
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    const error = response.body.error as { code?: string; message?: string } | undefined;
    fail(error?.code ?? "E_QUIZ_GRADE", error?.message ?? "quiz grade was rejected", response.body);
  }
  if (response.status !== 200) fail("E_INTERNAL", `review grade failed: ${JSON.stringify(response.body)}`, undefined, 2);
  printJson({ ok: true, session: parsed.value.session, question, ...response.body });
  return 0;
}

async function startReview(
  argv: string[],
  deps: ReviewCommandDeps | undefined,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      pr: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  if (values.pr === undefined || values.pr.trim() === "") {
    usageError("otacon review start requires --pr <URL|number>");
  }

  const cwd = realpathOr((deps ?? DEFAULT_DEPS).cwd());
  const repo = findRepoRoot(cwd);
  if (repo === undefined) {
    fail("E_GIT_REPO", "otacon review start must run inside the target git repository");
  }

  let repository;
  let pullRequest;
  try {
    repository = localGitHubRepository(repo, deps?.github);
    pullRequest = resolvePullRequest(values.pr, repo, repository, deps?.github);
  } catch (error) {
    if (error instanceof GitHubResolutionError) fail(error.code, error.message);
    throw error;
  }
  if (pullRequest.identity.repository !== repository) {
    fail(
      "E_REPO_MISMATCH",
      `PR ${pullRequest.url} belongs to ${pullRequest.identity.repository}, but the current repository is ${repository}`,
      { current: repository, requested: pullRequest.identity.repository },
    );
  }

  const commandDeps = deps ?? DEFAULT_DEPS;
  await commandDeps.ensureDaemon();
  const response = await commandDeps.api("POST", "/api/reviews", {
    repo,
    repository,
    branch: currentBranch(repo),
    pullRequest,
    force: values.force === true,
  });
  if (response.status !== 200 && response.status !== 201) {
    const code = (response.body.error as { code?: string } | undefined)?.code;
    if (response.status === 400 || response.status === 409) {
      fail(code ?? "E_BAD_REQUEST", responseMessage(response));
    }
    fail("E_INTERNAL", `review start failed: ${JSON.stringify(response.body)}`, undefined, 2);
  }
  const session = response.body.session as unknown as ReviewRegistrySession;
  const preparation = response.body.preparation as unknown as ReviewReportRevisionPayload | undefined;
  if (preparation === undefined) {
    fail("E_INTERNAL", "review start did not return a frozen report preparation", undefined, 2);
  }
  const action = response.body.action;
  const readOnly = action === "reused-complete";
  printJson({
    ok: true,
    action,
    session: session.id,
    title: session.title,
    repo,
    branch: session.branch,
    pr: session.review.pullRequest,
    revision: preparation.revision.revision,
    headRevision: session.review.revision,
    url: `${baseUrl()}/s/${session.id}`,
    ...(readOnly ? {
      readOnly: true,
      completion: session.review.completions?.at(-1),
    } : {
      report: reviewDraftPath(session.id),
      quiz: reviewQuizDraftPath(session.id),
      knowledge: {
        current: {
          user: userKnowledgePath(),
          project: projectKnowledgePath(repository),
        },
        snapshot: {
          hash: preparation.snapshot.hash,
          user: {
            hash: preparation.snapshot.user.hash,
            path: reviewRevisionUserKnowledgePath(session.id, preparation.revision.revision),
          },
          project: {
            hash: preparation.snapshot.project.hash,
            path: reviewRevisionProjectKnowledgePath(session.id, preparation.revision.revision),
          },
        },
      },
    }),
  });
  return 0;
}

async function submitReview(
  argv: string[],
  deps: ReviewCommandDeps | undefined,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: "string" },
      quiz: { type: "string" },
    },
  });
  if (values.report === undefined || values.quiz === undefined) {
    usageError("otacon review submit requires --report <report.md> and --quiz <quiz.json>");
  }
  const readFile = deps?.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let report: string;
  let quiz: string;
  try {
    report = readFile(values.report);
    quiz = readFile(values.quiz);
  } catch (error) {
    fail("E_REVIEW_INPUT", `could not read review input: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseReviewReport(report);
  const session = parsed.frontmatter?.session;
  if (session === undefined) {
    fail("E_REVIEW_REPORT_INVALID", "report frontmatter must identify its otacon session", { issues: parsed.errors });
  }
  const commandDeps = deps ?? DEFAULT_DEPS;
  await commandDeps.ensureDaemon();
  const response = await commandDeps.api("POST", `/api/reviews/${session}/submit`, { report, quiz });
  if (response.status === 422) {
    const issues = Array.isArray(response.body.issues) ? response.body.issues : [];
    const summary = issues.slice(0, 8).map((issue) => {
      const item = issue as { line?: number; code?: string; message?: string };
      return `${item.line === undefined ? "" : `line ${item.line}: `}${item.code ?? "E_REPORT"} ${item.message ?? ""}`.trim();
    }).join("; ");
    fail("E_REVIEW_REPORT_INVALID", `review report rejected${summary === "" ? "" : `: ${summary}`}`, { issues });
  }
  if (response.status === 400 || response.status === 404 || response.status === 409) {
    const fallback = response.status === 400 ? "E_BAD_REQUEST" : response.status === 404 ? "E_NOT_FOUND" : "E_REVIEW_CONFLICT";
    const code = (response.body.error as { code?: string } | undefined)?.code ?? fallback;
    fail(code, responseMessage(response));
  }
  if (response.status !== 201) {
    fail("E_INTERNAL", `review submit failed: ${JSON.stringify(response.body)}`, undefined, 2);
  }
  const submitted = response.body.revision as unknown as ReviewReportRevisionPayload;
  printJson({
    ok: true,
    session,
    revision: submitted.revision.revision,
    headRevision: submitted.revision.headRevision,
    head: submitted.revision.headSha,
    snapshot: submitted.snapshot.hash,
    warnings: submitted.warnings,
    url: `${baseUrl()}/s/${session}`,
  });
  return 0;
}
