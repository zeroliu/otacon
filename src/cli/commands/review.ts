// otacon review start --pr <URL|number> [--force]
//
// Resolve GitHub metadata while still entirely client-side, reject a different
// base repository before touching the daemon, then cross the one atomic start
// endpoint. Report/quiz paths are advertised but remain uncreated until the
// report persistence phase.

import { parseArgs } from "node:util";
import {
  projectKnowledgePath,
  reviewDraftPath,
  reviewQuizDraftPath,
  userKnowledgePath,
} from "../../shared/paths.js";
import type { ReviewRegistrySession } from "../../shared/types.js";
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
  if (argv[0] !== "start") {
    usageError("usage: otacon review start --pr <URL|number> [--force]");
  }
  const { values } = parseArgs({
    args: argv.slice(1),
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
  const action = response.body.action;
  printJson({
    ok: true,
    action,
    session: session.id,
    title: session.title,
    repo,
    branch: session.branch,
    pr: session.review.pullRequest,
    revision: session.review.revision,
    url: `${baseUrl()}/s/${session.id}`,
    report: reviewDraftPath(session.id),
    quiz: reviewQuizDraftPath(session.id),
    knowledge: {
      user: userKnowledgePath(),
      project: projectKnowledgePath(repository),
    },
  });
  return 0;
}
