import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimReviewWorktreeLeaseFile,
  releaseReviewWorktreeLeaseFile,
  reviewWorktreeLeaseOwner,
  type ReviewWorktreeLease,
  type ReviewWorktreeLeaseAction,
} from "./review-worktree-lease.js";

let root: string;
let path: string;

const action = (thread: string, requestedAt: string): ReviewWorktreeLeaseAction => ({
  session: "otc_review1",
  thread,
  reportRevision: 1,
  headRevision: 1,
  headSha: "a".repeat(40),
  requestedAt,
});

const lease = (value: ReviewWorktreeLeaseAction): ReviewWorktreeLease => ({
  version: 2,
  owner: reviewWorktreeLeaseOwner(value),
  action: value,
  worktree: "/worktree",
  branch: "feature",
  head: "a".repeat(40),
  acquiredAt: "2026-07-15T12:00:00.000Z",
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "otacon-review-lease-"));
  path = join(root, "pr.lease");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("review worktree lease files", () => {
  test("an older terminal retry cannot release a newer action generation", () => {
    const first = lease(action("t1", "2026-07-15T12:00:00.000Z"));
    const second = lease(action("t2", "2026-07-15T12:01:00.000Z"));
    claimReviewWorktreeLeaseFile(path, first);
    expect(releaseReviewWorktreeLeaseFile(path, first.owner)).toBe("released");
    claimReviewWorktreeLeaseFile(path, second);

    expect(releaseReviewWorktreeLeaseFile(path, first.owner)).toBe("mismatch");
    expect(existsSync(path)).toBe(true);
    expect(releaseReviewWorktreeLeaseFile(path, second.owner)).toBe("released");
  });

  test("concurrent duplicate cleanup cannot unlink the next owner", () => {
    const first = lease(action("t1", "2026-07-15T12:00:00.000Z"));
    const second = lease(action("t2", "2026-07-15T12:01:00.000Z"));
    claimReviewWorktreeLeaseFile(path, first);
    expect(releaseReviewWorktreeLeaseFile(path, first.owner)).toBe("released");
    claimReviewWorktreeLeaseFile(path, second);
    expect(releaseReviewWorktreeLeaseFile(path, first.owner)).toBe("mismatch");
    expect(releaseReviewWorktreeLeaseFile(path, second.owner)).toBe("released");
  });
});
