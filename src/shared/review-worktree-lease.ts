import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { otaconHome } from "./paths.js";
import type { ReviewThread } from "./types.js";

export interface ReviewWorktreeLeaseAction {
  session: string;
  thread: string;
  reportRevision: number;
  headRevision: number;
  headSha: string;
  requestedAt: string;
}

export interface ReviewWorktreeLease {
  version: 2;
  owner: string;
  action: ReviewWorktreeLeaseAction;
  worktree: string;
  branch: string;
  head: string;
  acquiredAt: string;
}

export function reviewWorktreeLeaseAction(thread: ReviewThread): ReviewWorktreeLeaseAction | undefined {
  if (thread.codeAction === undefined) return undefined;
  return {
    session: thread.identity.session,
    thread: thread.id,
    reportRevision: thread.identity.reportRevision,
    headRevision: thread.identity.headRevision,
    headSha: thread.identity.headSha.toLowerCase(),
    requestedAt: thread.codeAction.requestedAt,
  };
}

export function reviewWorktreeLeaseOwner(action: ReviewWorktreeLeaseAction): string {
  const generation = createHash("sha256").update(JSON.stringify([
    action.session,
    action.thread,
    action.reportRevision,
    action.headRevision,
    action.headSha.toLowerCase(),
    action.requestedAt,
  ])).digest("hex");
  return `otacon-review:${action.session}:${action.thread}:${generation}`;
}

export function reviewWorktreeLeasePathForPr(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return join(otaconHome(), "review-worktree-leases", `${digest}.lease`);
}

function ownerFile(path: string, owner: string): string {
  const digest = createHash("sha256").update(owner).digest("hex");
  return join(path, `${digest}.json`);
}

function removeEmptyLeaseDir(path: string): void {
  try { rmdirSync(path); } catch { /* non-empty, absent, or concurrently replaced */ }
}

/** Atomically publish a complete PR lease directory without replacing an owner. */
export function claimReviewWorktreeLeaseFile(path: string, lease: ReviewWorktreeLease): void {
  mkdirSync(dirname(path), { recursive: true });
  // Repair only the empty directory left by a crash after an owner file was
  // removed but before its lease directory was removed.
  removeEmptyLeaseDir(path);
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(temp);
  try {
    writeFileSync(ownerFile(temp, lease.owner), `${JSON.stringify(lease, null, 2)}\n`, { flag: "wx" });
    // Both contenders publish a non-empty directory. POSIX rename refuses to
    // replace the winner, so readers never observe a partial owner record.
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Compare-and-release one action generation. Owner-specific filenames ensure
 * that even concurrent retries for action A cannot unlink action B after B
 * acquires the same PR lease directory.
 */
export function releaseReviewWorktreeLeaseFile(
  path: string,
  owner: string,
): "released" | "absent" | "mismatch" {
  const expected = ownerFile(path, owner);
  let lease: unknown;
  try {
    lease = JSON.parse(readFileSync(expected, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "mismatch";
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch (readError) {
      return (readError as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "mismatch";
    }
    if (entries.length > 0) return "mismatch";
    removeEmptyLeaseDir(path);
    return "absent";
  }
  if (typeof lease !== "object" || lease === null ||
      (lease as { version?: unknown }).version !== 2 ||
      (lease as { owner?: unknown }).owner !== owner) {
    return "mismatch";
  }
  try {
    unlinkSync(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "mismatch";
    removeEmptyLeaseDir(path);
    return "absent";
  }
  removeEmptyLeaseDir(path);
  return "released";
}
