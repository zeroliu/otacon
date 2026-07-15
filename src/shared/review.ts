import { canonicalizeGitHubRepo } from "./knowledge.js";
import type { CanonicalGitHubRepo } from "./knowledge.js";

/** Canonical base-repository + number identity for one GitHub pull request. */
export interface PullRequestIdentity {
  host: "github.com";
  repository: CanonicalGitHubRepo;
  number: number;
  /** Stable lookup key; head changes never change it. */
  key: `github.com/${string}#${number}`;
}

export type PullRequestState = "open" | "closed" | "merged";
export type GitHubRepositoryPermission = "admin" | "maintain" | "write" | "triage" | "read";

export interface PullRequestPermissions {
  /** GitHub lets maintainers update the contributor branch. */
  maintainerCanModify: boolean;
  /** Permission reported for the authenticated viewer on the base repository. */
  viewerPermission: GitHubRepositoryPermission;
  /** Forks, and same-repo PRs without push permission, are review-only for V1. */
  readOnly: boolean;
}

export function reviewIsReadOnly(
  isCrossRepository: boolean,
  viewerPermission: GitHubRepositoryPermission,
): boolean {
  return isCrossRepository || !["admin", "maintain", "write"].includes(viewerPermission);
}

/** Metadata resolved by the CLI's injectable `gh pr view` adapter. */
export interface PullRequestMetadata {
  identity: PullRequestIdentity;
  url: string;
  title: string;
  author: string;
  baseRef: string;
  headRef: string;
  headRepository: CanonicalGitHubRepo;
  headSha: string;
  state: PullRequestState;
  isCrossRepository: boolean;
  permissions: PullRequestPermissions;
}

/** The immutable PR head which caused one review revision. */
export interface ReviewHeadSnapshot {
  sha: string;
  ref: string;
  repository: CanonicalGitHubRepo;
  capturedAt: string;
}

export type ReviewSessionStatus = "working" | "reviewing" | "done";

export const REVIEW_SESSION_STATUSES: readonly ReviewSessionStatus[] = [
  "working",
  "reviewing",
  "done",
];

export function isReviewTerminalStatus(status: ReviewSessionStatus): boolean {
  return status === "done";
}

/** Durable evidence of the exact report/head the reviewer finished reading. */
export interface ReviewCompletionSummary {
  version: 1;
  session: string;
  completedAt: string;
  reportRevision: number;
  headRevision: number;
  headSha: string;
  forced: boolean;
  unresolved: { conversations: number; quizzes: number };
  /** Reserved before completion is committed; one terminal wake owns this seq. */
  eventSeq: number;
  /** Crash-recovery marker: pending is repaired before request routes open. */
  wake: "pending" | "queued";
}

export interface ReviewDoneEvent {
  event: "review-done";
  session: string;
  completion: Omit<ReviewCompletionSummary, "wake">;
}

/** Registry-resident detail needed before report persistence exists. */
export interface ReviewSessionDetail {
  pullRequest: PullRequestMetadata;
  head: ReviewHeadSnapshot;
  /** Starts at one and advances only when the canonical PR's head changes. */
  revision: number;
  /** Append-only completion baselines; a changed head reopens without erasing history. */
  completions?: ReviewCompletionSummary[];
}

export type ReviewStartAction =
  | "created"
  | "reused"
  | "revised"
  | "reused-complete"
  | "reopened-changed";

export function latestReviewCompletion(
  detail: ReviewSessionDetail,
): ReviewCompletionSummary | undefined {
  return detail.completions?.at(-1);
}

export function reviewDoneEvent(completion: ReviewCompletionSummary): ReviewDoneEvent {
  const { wake: _wake, ...publicCompletion } = completion;
  return { event: "review-done", session: completion.session, completion: publicCompletion };
}

export function pullRequestIdentity(
  repository: CanonicalGitHubRepo,
  number: number,
): PullRequestIdentity {
  if (!Number.isInteger(number) || number < 1) throw new Error("pull request number must be positive");
  return {
    host: "github.com",
    repository,
    number,
    key: `github.com/${repository}#${number}`,
  };
}

/** Parse the canonical identity encoded in a GitHub PR URL. */
export function pullRequestIdentityFromUrl(url: string): PullRequestIdentity | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(parsed.pathname);
  if (!match) return undefined;
  const repository = canonicalizeGitHubRepo(`${match[1] ?? ""}/${match[2] ?? ""}`);
  const number = Number(match[3]);
  if (repository === undefined || !Number.isInteger(number) || number < 1) return undefined;
  return pullRequestIdentity(repository, number);
}

/** Strict wire decoder used by the daemon; malformed CLI/API input is refused. */
export function parsePullRequestMetadata(raw: unknown): PullRequestMetadata | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.url !== "string") return undefined;
  const identity = pullRequestIdentityFromUrl(value.url);
  const sentIdentity = value.identity as Record<string, unknown> | undefined;
  if (
    identity === undefined ||
    typeof sentIdentity !== "object" ||
    sentIdentity.repository !== identity.repository ||
    sentIdentity.number !== identity.number ||
    sentIdentity.key !== identity.key ||
    sentIdentity.host !== "github.com"
  ) return undefined;
  const text = (field: string): string | undefined =>
    typeof value[field] === "string" && (value[field] as string).trim() !== ""
      ? value[field] as string
      : undefined;
  const headRepository = typeof value.headRepository === "string"
    ? canonicalizeGitHubRepo(`https://github.com/${value.headRepository}`)
    : undefined;
  const permissions = value.permissions as Record<string, unknown> | undefined;
  const state = value.state;
  if (
    text("title") === undefined || text("author") === undefined ||
    text("baseRef") === undefined || text("headRef") === undefined ||
    text("headSha") === undefined || headRepository === undefined ||
    (state !== "open" && state !== "closed" && state !== "merged") ||
    typeof value.isCrossRepository !== "boolean" ||
    typeof permissions !== "object" ||
    typeof permissions.maintainerCanModify !== "boolean" ||
    (permissions.viewerPermission !== "admin" && permissions.viewerPermission !== "maintain" &&
      permissions.viewerPermission !== "write" && permissions.viewerPermission !== "triage" &&
      permissions.viewerPermission !== "read") ||
    typeof permissions.readOnly !== "boolean"
  ) return undefined;
  if (permissions.readOnly !== reviewIsReadOnly(value.isCrossRepository, permissions.viewerPermission)) {
    return undefined;
  }
  return {
    identity,
    url: value.url,
    title: text("title")!,
    author: text("author")!,
    baseRef: text("baseRef")!,
    headRef: text("headRef")!,
    headRepository,
    headSha: text("headSha")!,
    state,
    isCrossRepository: value.isCrossRepository,
    permissions: {
      maintainerCanModify: permissions.maintainerCanModify,
      viewerPermission: permissions.viewerPermission,
      readOnly: permissions.readOnly,
    },
  };
}
