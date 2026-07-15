// Safe, exact checkout routing for writable same-repository PR reviews.
//
// This module deliberately has no commit/push/reset path. It may reuse an
// already-clean exact worktree, or fetch the reviewed branch and create one
// under worktree.dir. Every process and filesystem boundary is injectable so
// the refusals can be proven without mutating a real repository.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "../shared/config.js";
import { canonicalizeGitHubRepo } from "../shared/knowledge.js";
import { expandTilde, otaconHome } from "../shared/paths.js";
import type { PullRequestMetadata } from "../shared/review.js";
import type { ReviewRegistrySession } from "../shared/types.js";
import { GitHubResolutionError, resolvePullRequest } from "./github.js";
import type { GitHubDeps } from "./github.js";
import { fail } from "./output.js";

export interface ReviewWorktreeDeps {
  git(args: string[], cwd: string): string;
  exists(path: string): boolean;
  mkdir(path: string): void;
  realpath(path: string): string;
  worktreeDir(repo: string): string;
  /** Atomically publish one durable lease, or throw when it already exists. */
  claimLease(path: string, lease: ReviewWorktreeLease): void;
  /** Release only the expected owner; absent is an idempotent terminal retry. */
  releaseLease(path: string, reason: string): "released" | "absent" | "mismatch";
}

export interface ReviewWorktreeLease {
  version: 1;
  session: string;
  reason: string;
  worktree: string;
  branch: string;
  head: string;
  acquiredAt: string;
}

function claimLeaseFile(path: string, lease: ReviewWorktreeLease): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  // Publish by hard-link: the complete temp file exists before the atomic
  // no-overwrite link, so a crash cannot leave a partial durable owner record.
  writeFileSync(temp, `${JSON.stringify(lease, null, 2)}\n`, { flag: "wx" });
  try {
    linkSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best-effort cleanup after a failed claim */ }
    throw error;
  }
  // The durable hard link is now the owner record. A temp cleanup failure must
  // not turn that successful claim into a false checkout failure.
  try { unlinkSync(temp); } catch { /* best-effort cleanup after a successful claim */ }
}

function releaseLeaseFile(path: string, reason: string): "released" | "absent" | "mismatch" {
  let lease: unknown;
  try {
    lease = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return "mismatch";
  }
  if (typeof lease !== "object" || lease === null || (lease as { reason?: unknown }).reason !== reason) {
    return "mismatch";
  }
  try {
    unlinkSync(path);
    return "released";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "mismatch";
  }
}

const DEFAULT_DEPS: ReviewWorktreeDeps = {
  git: (args, cwd) => execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  realpath: realpathSync,
  worktreeDir: (repo) => loadConfig(repo).worktree.dir,
  claimLease: claimLeaseFile,
  releaseLease: releaseLeaseFile,
};

export interface ReviewWorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  locked: boolean;
  lockedReason?: string;
  prunable: boolean;
  prunableReason?: string;
}

export type ReviewCheckoutResult =
  | {
    mode: "read-only";
    action: "read-only";
    reason: "fork" | "permission";
    message: string;
  }
  | {
    mode: "writable";
    action: "reused" | "created";
    worktree: string;
    branch: string;
    head: string;
    push: { remote: "origin"; ref: string };
    lock: { reason: string; path: string };
  };

function detail(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? `: ${error.message}` : "";
}

function run(
  deps: ReviewWorktreeDeps,
  args: string[],
  cwd: string,
  code: string,
  message: string,
): string {
  try {
    return deps.git(args, cwd);
  } catch (error) {
    fail(code, `${message}${detail(error)}`);
  }
}

function maybeRun(deps: ReviewWorktreeDeps, args: string[], cwd: string): string | undefined {
  try {
    return deps.git(args, cwd);
  } catch {
    return undefined;
  }
}

function exactHead(session: ReviewRegistrySession): { ref: string; sha: string } {
  const pr = session.review.pullRequest;
  const head = session.review.head;
  if (
    head.repository !== pr.headRepository ||
    head.ref !== pr.headRef ||
    head.sha !== pr.headSha ||
    !/^[0-9a-f]{40}$/i.test(head.sha)
  ) {
    fail(
      "E_REVIEW_HEAD_STALE",
      "review head metadata is inconsistent; run otacon review refresh-head --session " + session.id,
    );
  }
  return { ref: head.ref, sha: head.sha.toLowerCase() };
}

function canonicalPath(path: string, deps: ReviewWorktreeDeps): string {
  try {
    return deps.realpath(path);
  } catch {
    return resolve(path);
  }
}

function valueAfter(line: string, prefix: string): string | undefined {
  if (!line.startsWith(prefix)) return undefined;
  const value = line.slice(prefix.length);
  return value === "" ? undefined : value;
}

/** Strict decoder for `git worktree list --porcelain -z`. */
export function parseReviewWorktrees(raw: string): ReviewWorktreeEntry[] {
  if (raw === "") return [];
  if (!raw.endsWith("\0\0")) {
    fail("E_REVIEW_WORKTREE_STATE", "git worktree list returned malformed porcelain (missing record terminator)");
  }
  const records = raw.slice(0, -2).split("\0\0");
  const entries: ReviewWorktreeEntry[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const fields = record.split("\0");
    const path = valueAfter(fields[0] ?? "", "worktree ");
    const head = valueAfter(fields[1] ?? "", "HEAD ");
    if (path === undefined || !isAbsolute(path) || head === undefined || !/^[0-9a-f]{40}$/i.test(head)) {
      fail("E_REVIEW_WORKTREE_STATE", "git worktree list returned malformed porcelain identity");
    }
    let branch: string | undefined;
    let detached = false;
    let locked = false;
    let lockedReason: string | undefined;
    let prunable = false;
    let prunableReason: string | undefined;
    for (const field of fields.slice(2)) {
      if (field.startsWith("branch ")) {
        if (branch !== undefined || detached) {
          fail("E_REVIEW_WORKTREE_STATE", "git worktree list returned conflicting branch state");
        }
        branch = field.slice("branch ".length);
        if (!branch.startsWith("refs/heads/") || branch.length === "refs/heads/".length) {
          fail("E_REVIEW_WORKTREE_STATE", "git worktree list returned an invalid branch ref");
        }
      } else if (field === "detached") {
        if (branch !== undefined || detached) {
          fail("E_REVIEW_WORKTREE_STATE", "git worktree list returned conflicting detached state");
        }
        detached = true;
      } else if (field === "locked" || field.startsWith("locked ")) {
        if (locked) fail("E_REVIEW_WORKTREE_STATE", "git worktree list returned duplicate locked state");
        locked = true;
        lockedReason = valueAfter(field, "locked ");
      } else if (field === "prunable" || field.startsWith("prunable ")) {
        if (prunable) fail("E_REVIEW_WORKTREE_STATE", "git worktree list returned duplicate prunable state");
        prunable = true;
        prunableReason = valueAfter(field, "prunable ");
      } else if (field !== "bare") {
        fail("E_REVIEW_WORKTREE_STATE", `git worktree list returned unknown porcelain field: ${field}`);
      }
    }
    if (branch === undefined && !detached) {
      fail("E_REVIEW_WORKTREE_STATE", "git worktree list returned no branch or detached state");
    }
    if (seen.has(path)) fail("E_REVIEW_WORKTREE_STATE", `git worktree list repeated ${path}`);
    seen.add(path);
    entries.push({
      path,
      head: head.toLowerCase(),
      branch,
      detached,
      locked,
      ...(lockedReason === undefined ? {} : { lockedReason }),
      prunable,
      ...(prunableReason === undefined ? {} : { prunableReason }),
    });
  }
  return entries;
}

function configuredWorktreeRoot(session: ReviewRegistrySession, deps: ReviewWorktreeDeps): string {
  const configured = expandTilde(deps.worktreeDir(session.repo));
  return isAbsolute(configured) ? resolve(configured) : resolve(session.repo, configured);
}

export function reviewWorktreePath(session: ReviewRegistrySession, root: string): string {
  const repository = session.review.pullRequest.identity.repository;
  const [owner = "github", repo = basename(session.repo)] = repository.split("/");
  const slug = `${owner}-${repo}-pr-${session.review.pullRequest.identity.number}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return join(root, `review-${slug}`);
}

export function reviewWorktreeLeasePath(session: ReviewRegistrySession): string {
  const key = session.review.pullRequest.identity.key;
  const digest = createHash("sha256").update(key).digest("hex");
  return join(otaconHome(), "review-worktree-leases", `${digest}.json`);
}

const reviewWorktreeLeaseReason = (session: ReviewRegistrySession): string =>
  `otacon-review:${session.id}`;

function claimReviewWorktreeLease(
  session: ReviewRegistrySession,
  worktree: string,
  branch: string,
  head: string,
  deps: ReviewWorktreeDeps,
): { reason: string; path: string } {
  const path = reviewWorktreeLeasePath(session);
  const reason = reviewWorktreeLeaseReason(session);
  const lease: ReviewWorktreeLease = {
    version: 1,
    session: session.id,
    reason,
    worktree,
    branch,
    head,
    acquiredAt: new Date().toISOString(),
  };
  try {
    deps.claimLease(path, lease);
  } catch (error) {
    fail(
      "E_REVIEW_WORKTREE_LEASED",
      `review checkout ${worktree} is already leased; finish or fail the active code action before retrying${detail(error)}`,
      { session: session.id, worktree, lock: { reason, path } },
    );
  }
  return { reason, path };
}

/**
 * Release a checkout handoff only after its code action is terminal. Repeating
 * the same terminal status is the crash-repair path when the daemon commit won
 * but the first CLI died before unlinking the lease.
 */
export function releaseReviewWorktreeLease(
  session: ReviewRegistrySession,
  deps: ReviewWorktreeDeps = DEFAULT_DEPS,
): "released" | "absent" {
  const path = reviewWorktreeLeasePath(session);
  const reason = reviewWorktreeLeaseReason(session);
  const result = deps.releaseLease(path, reason);
  if (result === "mismatch") {
    fail(
      "E_REVIEW_WORKTREE_LEASE_OWNER",
      `review worktree lease ${path} does not belong to ${session.id}; it was left untouched`,
      { session: session.id, lock: { reason, path } },
    );
  }
  return result;
}

function verifyLiveWorktree(
  session: ReviewRegistrySession,
  path: string,
  expectedRef: string,
  expectedSha: string,
  deps: ReviewWorktreeDeps,
): void {
  const branch = run(
    deps,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    path,
    "E_REVIEW_WORKTREE_STALE",
    `cannot verify the branch in ${path}`,
  ).trim();
  const sha = run(
    deps,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    path,
    "E_REVIEW_WORKTREE_STALE",
    `cannot verify HEAD in ${path}`,
  ).trim().toLowerCase();
  if (branch !== expectedRef || sha !== expectedSha) {
    fail(
      "E_REVIEW_WORKTREE_STALE",
      `${path} is on ${branch || "detached HEAD"} at ${sha || "an unknown commit"}, not ${expectedRef} at ${expectedSha}; update it explicitly or run refresh-head`,
    );
  }
  const dirty = run(
    deps,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    path,
    "E_REVIEW_WORKTREE_STATE",
    `cannot inspect ${path}`,
  );
  if (dirty !== "") {
    fail(
      "E_REVIEW_WORKTREE_DIRTY",
      `${path} has uncommitted or untracked changes; commit, stash, or remove them before conducting a code change`,
      { worktree: path, session: session.id },
    );
  }
}

/**
 * Return an exact clean checkout, or create one without resetting any existing
 * branch/worktree. Forks and insufficient permissions are successful explicit
 * read-only results and execute no mutating git command.
 */
export function checkoutReviewWorktree(
  session: ReviewRegistrySession,
  deps: ReviewWorktreeDeps = DEFAULT_DEPS,
): ReviewCheckoutResult {
  const pr = session.review.pullRequest;
  if (session.status === "done") {
    fail(
      "E_REVIEW_DONE",
      `review ${session.id} is done; refresh a changed head or start a new review before conducting a code change`,
    );
  }
  if (pr.state !== "open") {
    fail(
      "E_REVIEW_PR_STATE",
      `pull request ${pr.url} is ${pr.state}; Otacon will not create a writable checkout`,
    );
  }
  if (pr.isCrossRepository || pr.headRepository !== pr.identity.repository) {
    return {
      mode: "read-only",
      action: "read-only",
      reason: "fork",
      message: "fork pull requests are review-only; Otacon did not fetch or create a worktree",
    };
  }
  if (pr.permissions.readOnly || !["write", "maintain", "admin"].includes(pr.permissions.viewerPermission)) {
    return {
      mode: "read-only",
      action: "read-only",
      reason: "permission",
      message: `GitHub permission ${pr.permissions.viewerPermission} is read-only; Otacon did not fetch or create a worktree`,
    };
  }

  const { ref, sha } = exactHead(session);
  const localRemote = run(
    deps,
    ["remote", "get-url", "origin"],
    session.repo,
    "E_REVIEW_GIT_REMOTE",
    `cannot read origin for ${session.repo}`,
  ).trim();
  if (canonicalizeGitHubRepo(localRemote) !== pr.identity.repository) {
    fail(
      "E_REPO_MISMATCH",
      `origin for ${session.repo} is not ${pr.identity.repository}; no worktree was changed`,
    );
  }
  if (maybeRun(deps, ["check-ref-format", "--branch", ref], session.repo)?.trim() !== ref) {
    fail("E_REVIEW_HEAD_REF", `PR head ref ${JSON.stringify(ref)} is not a safe local branch name`);
  }

  const entries = parseReviewWorktrees(run(
    deps,
    ["worktree", "list", "--porcelain", "-z"],
    session.repo,
    "E_REVIEW_WORKTREE_STATE",
    "cannot inspect git worktrees",
  ));
  const expectedBranch = `refs/heads/${ref}`;
  const matching = entries.filter((entry) => entry.branch === expectedBranch);
  if (matching.length > 1) {
    fail("E_REVIEW_WORKTREE_STATE", `more than one worktree claims ${expectedBranch}`);
  }
  if (matching.length === 1) {
    const entry = matching[0]!;
    if (entry.prunable || entry.locked || entry.head !== sha) {
      fail(
        "E_REVIEW_WORKTREE_STALE",
        `${entry.path} is not an exact usable checkout of ${ref} at ${sha}; no worktree was changed`,
      );
    }
    verifyLiveWorktree(session, entry.path, ref, sha, deps);
    const lock = claimReviewWorktreeLease(session, entry.path, ref, sha, deps);
    return {
      mode: "writable",
      action: "reused",
      worktree: entry.path,
      branch: ref,
      head: sha,
      push: { remote: "origin", ref },
      lock,
    };
  }

  const root = configuredWorktreeRoot(session, deps);
  const target = reviewWorktreePath(session, root);
  const canonicalTarget = canonicalPath(target, deps);
  const occupying = entries.find((entry) => canonicalPath(entry.path, deps) === canonicalTarget);
  if (occupying !== undefined || deps.exists(target)) {
    fail(
      "E_REVIEW_WORKTREE_COLLISION",
      `${target} already exists but is not the exact ${ref} worktree; choose a different worktree.dir or resolve the path manually`,
      { worktree: target },
    );
  }

  const localRef = `refs/heads/${ref}`;
  const localHead = maybeRun(deps, ["rev-parse", "--verify", `${localRef}^{commit}`], session.repo)?.trim().toLowerCase();
  if (localHead !== undefined && localHead !== sha) {
    fail(
      "E_REVIEW_WORKTREE_STALE",
      `local branch ${ref} is at ${localHead}, not reviewed head ${sha}; Otacon will not reset it`,
    );
  }

  const remoteRef = `refs/remotes/origin/${ref}`;
  const advertised = run(
    deps,
    ["ls-remote", "--exit-code", "origin", `refs/heads/${ref}`],
    session.repo,
    "E_REVIEW_HEAD_REF",
    `origin branch ${ref} does not exist or cannot be read; no worktree was changed`,
  ).trim();
  const advertisedMatch = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/i.exec(advertised);
  if (advertisedMatch === null || advertisedMatch[2] !== ref) {
    fail("E_REVIEW_HEAD_REF", `origin returned malformed identity for branch ${ref}; no worktree was changed`);
  }
  const advertisedSha = advertisedMatch[1]!.toLowerCase();
  if (advertisedSha !== sha) {
    fail(
      "E_REVIEW_HEAD_STALE",
      `GitHub now reports origin/${ref} at ${advertisedSha}, but this review is frozen at ${sha}; run otacon review refresh-head --session ${session.id}`,
    );
  }
  run(
    deps,
    ["fetch", "--no-tags", "origin", `+refs/heads/${ref}:${remoteRef}`],
    session.repo,
    "E_REVIEW_FETCH",
    `cannot fetch origin branch ${ref}; verify that the remote and ref still exist`,
  );
  const fetched = maybeRun(deps, ["rev-parse", "--verify", `${remoteRef}^{commit}`], session.repo)?.trim().toLowerCase();
  if (fetched === undefined || !/^[0-9a-f]{40}$/.test(fetched)) {
    fail("E_REVIEW_HEAD_REF", `origin/${ref} did not resolve to a commit; no worktree was created`);
  }
  if (fetched !== sha) {
    fail(
      "E_REVIEW_HEAD_STALE",
      `fetched origin/${ref} resolved to ${fetched}, not the advertised reviewed head ${sha}; no worktree was created`,
    );
  }

  deps.mkdir(root);
  const addArgs = localHead === undefined
    ? ["worktree", "add", "--track", "-b", ref, target, remoteRef]
    : ["worktree", "add", target, ref];
  run(
    deps,
    addArgs,
    session.repo,
    "E_REVIEW_WORKTREE_CREATE",
    `could not create ${target}; no branch was reset`,
  );
  verifyLiveWorktree(session, target, ref, sha, deps);
  const lock = claimReviewWorktreeLease(session, target, ref, sha, deps);
  return {
    mode: "writable",
    action: "created",
    worktree: target,
    branch: ref,
    head: sha,
    push: { remote: "origin", ref },
    lock,
  };
}

/** Fresh metadata for refresh-head; this never creates or force-starts a session. */
export function freshReviewMetadata(
  session: ReviewRegistrySession,
  github?: GitHubDeps,
): PullRequestMetadata {
  try {
    const metadata = resolvePullRequest(
      session.review.pullRequest.url,
      session.repo,
      session.review.pullRequest.identity.repository,
      github,
    );
    if (metadata.identity.key !== session.review.pullRequest.identity.key) {
      fail("E_REVIEW_IDENTITY", "fresh GitHub metadata changed the review's canonical PR identity");
    }
    return metadata;
  } catch (error) {
    if (error instanceof GitHubResolutionError) fail(error.code, error.message);
    throw error;
  }
}
