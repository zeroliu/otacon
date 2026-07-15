import { execFileSync } from "node:child_process";
import { canonicalizeGitHubRepo } from "../shared/knowledge.js";
import type { CanonicalGitHubRepo } from "../shared/knowledge.js";
import {
  pullRequestIdentityFromUrl,
  reviewIsReadOnly,
} from "../shared/review.js";
import type {
  GitHubRepositoryPermission,
  PullRequestMetadata,
  PullRequestState,
} from "../shared/review.js";

const PR_FIELDS = [
  "author",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "headRepository",
  "headRepositoryOwner",
  "isCrossRepository",
  "maintainerCanModify",
  "number",
  "state",
  "title",
  "url",
].join(",");

export class GitHubResolutionError extends Error {
  constructor(
    readonly code: "E_PR" | "E_GITHUB_REPO" | "E_REPO_MISMATCH" | "E_GH",
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubDeps {
  run(command: string, args: string[], cwd: string): string;
}

const DEFAULT_DEPS: GitHubDeps = {
  run: (command, args, cwd) => execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim(),
};

export function localGitHubRepository(
  repoRoot: string,
  deps: GitHubDeps = DEFAULT_DEPS,
): CanonicalGitHubRepo {
  let remote: string;
  try {
    remote = deps.run("git", ["remote", "get-url", "origin"], repoRoot).trim();
  } catch {
    throw new GitHubResolutionError(
      "E_GITHUB_REPO",
      `review start requires ${repoRoot} to have a GitHub origin remote`,
    );
  }
  const repository = canonicalizeGitHubRepo(remote);
  if (repository === undefined) {
    throw new GitHubResolutionError(
      "E_GITHUB_REPO",
      `origin for ${repoRoot} is not a canonical github.com owner/repo remote`,
    );
  }
  return repository;
}

function parseTarget(target: string): string {
  const trimmed = target.trim();
  if (/^[1-9]\d*$/.test(trimmed)) return trimmed;
  if (pullRequestIdentityFromUrl(trimmed) !== undefined) return trimmed;
  throw new GitHubResolutionError("E_PR", "--pr must be a positive PR number or GitHub PR URL");
}

function stringField(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new GitHubResolutionError("E_GH", `gh pr view returned invalid ${field}`);
  }
  return value;
}

function boolField(raw: Record<string, unknown>, field: string): boolean {
  const value = raw[field];
  if (typeof value !== "boolean") {
    throw new GitHubResolutionError("E_GH", `gh pr view returned invalid ${field}`);
  }
  return value;
}

function stateField(raw: Record<string, unknown>): PullRequestState {
  switch (raw.state) {
    case "OPEN": return "open";
    case "CLOSED": return "closed";
    case "MERGED": return "merged";
    default: throw new GitHubResolutionError("E_GH", "gh pr view returned invalid state");
  }
}

function loginField(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null) {
    throw new GitHubResolutionError("E_GH", `gh pr view returned invalid ${field}`);
  }
  return stringField(value as Record<string, unknown>, "login");
}

function headRepositoryField(raw: Record<string, unknown>): CanonicalGitHubRepo {
  const direct = raw.headRepository;
  if (typeof direct !== "object" || direct === null) {
    throw new GitHubResolutionError("E_GH", "gh pr view returned invalid headRepository");
  }
  const repo = direct as Record<string, unknown>;
  const nameWithOwner = repo.nameWithOwner;
  if (typeof nameWithOwner === "string") {
    const canonical = canonicalizeGitHubRepo(`https://github.com/${nameWithOwner}`);
    if (canonical !== undefined) return canonical;
  }
  const owner = loginField(raw.headRepositoryOwner, "headRepositoryOwner");
  const name = stringField(repo, "name");
  const canonical = canonicalizeGitHubRepo(`https://github.com/${owner}/${name}`);
  if (canonical === undefined) {
    throw new GitHubResolutionError("E_GH", "gh pr view returned invalid head repository identity");
  }
  return canonical;
}

function viewerPermissionField(raw: Record<string, unknown>): GitHubRepositoryPermission {
  switch (raw.viewerPermission) {
    case "ADMIN": return "admin";
    case "MAINTAIN": return "maintain";
    case "WRITE": return "write";
    case "TRIAGE": return "triage";
    case "READ": return "read";
    default: throw new GitHubResolutionError("E_GH", "gh repo view returned invalid viewerPermission");
  }
}

/** Resolve a URL/number with one injectable, shell-free `gh pr view` call. */
export function resolvePullRequest(
  target: string,
  repoRoot: string,
  repository: CanonicalGitHubRepo,
  deps: GitHubDeps = DEFAULT_DEPS,
): PullRequestMetadata {
  const pr = parseTarget(target);
  let stdout: string;
  try {
    stdout = deps.run("gh", ["pr", "view", pr, "--repo", repository, "--json", PR_FIELDS], repoRoot);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitHubResolutionError("E_GH", `gh pr view failed: ${detail}`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new GitHubResolutionError("E_GH", "gh pr view returned malformed JSON");
  }
  const url = stringField(raw, "url");
  const identity = pullRequestIdentityFromUrl(url);
  if (identity === undefined || raw.number !== identity.number) {
    throw new GitHubResolutionError("E_GH", "gh pr view returned inconsistent PR identity");
  }
  if (identity.repository !== repository) {
    throw new GitHubResolutionError(
      "E_REPO_MISMATCH",
      `PR ${url} belongs to ${identity.repository}, but the current repository is ${repository}`,
    );
  }
  const isCrossRepository = boolField(raw, "isCrossRepository");
  const maintainerCanModify = boolField(raw, "maintainerCanModify");
  let permissionRaw: Record<string, unknown>;
  try {
    permissionRaw = JSON.parse(deps.run(
      "gh",
      ["repo", "view", repository, "--json", "viewerPermission"],
      repoRoot,
    )) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitHubResolutionError("E_GH", `gh repo view failed: ${detail}`);
  }
  const viewerPermission = viewerPermissionField(permissionRaw);
  return {
    identity,
    url,
    title: stringField(raw, "title"),
    author: loginField(raw.author, "author"),
    baseRef: stringField(raw, "baseRefName"),
    headRef: stringField(raw, "headRefName"),
    headRepository: headRepositoryField(raw),
    headSha: stringField(raw, "headRefOid"),
    state: stateField(raw),
    isCrossRepository,
    permissions: {
      maintainerCanModify,
      viewerPermission,
      readOnly: reviewIsReadOnly(isCrossRepository, viewerPermission),
    },
  };
}
