// otacon review start --pr <URL|number> [--force]
// otacon review submit --report <report.md> --quiz <quiz.json>
//
// Resolve GitHub metadata while still entirely client-side, reject a different
// base repository before touching the daemon, then cross the one atomic start
// endpoint. Report/quiz paths are advertised but remain uncreated until the
// report persistence phase.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
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
  usageError("usage: otacon review start --pr <URL|number> [--force] | otacon review submit --report <report.md> --quiz <quiz.json> | otacon review grade <question-id> --file <grade.json>");
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
