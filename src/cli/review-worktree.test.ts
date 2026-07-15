import { describe, expect, test } from "bun:test";
import type { CanonicalGitHubRepo } from "../shared/knowledge.js";
import type { ReviewRegistrySession } from "../shared/types.js";
import { CliError } from "./output.js";
import {
  checkoutReviewWorktree,
  freshReviewMetadata,
  parseReviewWorktrees,
  type ReviewWorktreeDeps,
} from "./review-worktree.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const REPO = "/repo";
const EXISTING = "/worktrees/existing";
const WORKTREE_ROOT = "/repo/.otacon-worktrees";

function session(options: {
  fork?: boolean;
  permission?: "admin" | "maintain" | "write" | "triage" | "read";
  sha?: string;
  status?: "working" | "reviewing" | "done";
  prState?: "open" | "closed" | "merged";
} = {}): ReviewRegistrySession {
  const repository = "acme/app" as CanonicalGitHubRepo;
  const fork = options.fork ?? false;
  const permission = options.permission ?? "write";
  const headRepository = (fork ? "octo/app" : repository) as CanonicalGitHubRepo;
  const sha = options.sha ?? SHA;
  return {
    kind: "review",
    id: "otc_review1",
    title: "#42 Safe checkout",
    repo: REPO,
    branch: "main",
    quick: false,
    socratic: false,
    status: options.status ?? "reviewing",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    review: {
      pullRequest: {
        identity: { host: "github.com", repository, number: 42, key: "github.com/acme/app#42" },
        url: "https://github.com/acme/app/pull/42",
        title: "Safe checkout",
        author: "octo",
        baseRef: "main",
        headRef: "feature",
        headRepository,
        headSha: sha,
        state: options.prState ?? "open",
        isCrossRepository: fork,
        permissions: {
          maintainerCanModify: true,
          viewerPermission: permission,
          readOnly: fork || permission === "read" || permission === "triage",
        },
      },
      head: { sha, ref: "feature", repository: headRepository, capturedAt: "2026-07-15T00:00:00.000Z" },
      revision: 2,
    },
  };
}

function porcelain(entries: Array<{ path: string; head: string; branch?: string; detached?: boolean }>): string {
  return entries.map((entry) => [
    `worktree ${entry.path}`,
    `HEAD ${entry.head}`,
    entry.detached ? "detached" : `branch refs/heads/${entry.branch}`,
  ].join("\0")).join("\0\0") + "\0\0";
}

function fake(
  outputs: Record<string, string | Error>,
  options: { exists?: boolean } = {},
): { deps: ReviewWorktreeDeps; calls: string[]; made: string[] } {
  const calls: string[] = [];
  const made: string[] = [];
  return {
    calls,
    made,
    deps: {
      git: (args, cwd) => {
        const key = `${cwd} :: ${args.join(" ")}`;
        calls.push(key);
        const output = outputs[key];
        if (output instanceof Error) throw output;
        if (output === undefined) throw new Error(`unexpected git call ${key}`);
        return output;
      },
      exists: () => options.exists ?? false,
      mkdir: (path) => { made.push(path); },
      realpath: (path) => path,
      worktreeDir: () => ".otacon-worktrees",
    },
  };
}

function mutating(calls: string[]): string[] {
  return calls.filter((call) =>
    / :: (fetch|reset|checkout|commit|push|branch)( |$)/.test(call) || call.includes(" :: worktree add ")
  );
}

const writablePreamble = (worktrees: string) => ({
  [`${REPO} :: remote get-url origin`]: "git@github.com:acme/app.git\n",
  [`${REPO} :: check-ref-format --branch feature`]: "feature\n",
  [`${REPO} :: worktree list --porcelain -z`]: worktrees,
});

describe("parseReviewWorktrees", () => {
  test("decodes NUL-delimited worktree paths and branch identity", () => {
    expect(parseReviewWorktrees(porcelain([
      { path: "/repo with spaces", head: SHA, branch: "main" },
      { path: EXISTING, head: OTHER, detached: true },
    ]))).toEqual([
      { path: "/repo with spaces", head: SHA, branch: "refs/heads/main", detached: false, locked: false, prunable: false },
      { path: EXISTING, head: OTHER, branch: undefined, detached: true, locked: false, prunable: false },
    ]);
  });

  test("refuses malformed porcelain without attempting recovery", () => {
    expect(() => parseReviewWorktrees(`worktree ${REPO}\0HEAD ${SHA}\0branch refs/heads/main\0`))
      .toThrow(expect.objectContaining({ code: "E_REVIEW_WORKTREE_STATE" }));
  });

  test("accepts real locked and prunable porcelain reason fields", () => {
    const raw = [
      `worktree /locked path\0HEAD ${SHA}\0branch refs/heads/feature\0locked in use by another process`,
      `worktree /old\0HEAD ${OTHER}\0detached\0prunable gitdir file points to non-existent location`,
    ].join("\0\0") + "\0\0";
    expect(parseReviewWorktrees(raw)).toEqual([
      {
        path: "/locked path",
        head: SHA,
        branch: "refs/heads/feature",
        detached: false,
        locked: true,
        lockedReason: "in use by another process",
        prunable: false,
      },
      {
        path: "/old",
        head: OTHER,
        branch: undefined,
        detached: true,
        locked: false,
        prunable: true,
        prunableReason: "gitdir file points to non-existent location",
      },
    ]);
  });
});

describe("checkoutReviewWorktree", () => {
  test("a done review refuses before any git mutation", () => {
    const { deps, calls, made } = fake({});
    expect(() => checkoutReviewWorktree(session({ status: "done" }), deps)).toThrow(expect.objectContaining({
      code: "E_REVIEW_DONE",
      message: expect.stringContaining("start a new review"),
    }));
    expect(mutating(calls)).toEqual([]);
    expect(made).toEqual([]);
  });

  test("a closed or merged pull request refuses before any git mutation", () => {
    for (const prState of ["closed", "merged"] as const) {
      const { deps, calls, made } = fake({});
      expect(() => checkoutReviewWorktree(session({ prState }), deps)).toThrow(expect.objectContaining({
        code: "E_REVIEW_PR_STATE",
        message: expect.stringContaining(prState),
      }));
      expect(mutating(calls)).toEqual([]);
      expect(made).toEqual([]);
    }
  });

  test("forks return an explicit read-only result with zero git or filesystem mutation", () => {
    const { deps, calls, made } = fake({});
    expect(checkoutReviewWorktree(session({ fork: true }), deps)).toMatchObject({
      mode: "read-only",
      action: "read-only",
      reason: "fork",
    });
    expect(calls).toEqual([]);
    expect(made).toEqual([]);
  });

  test("insufficient permission returns read-only before any git command", () => {
    const { deps, calls } = fake({});
    expect(checkoutReviewWorktree(session({ permission: "read" }), deps)).toMatchObject({
      mode: "read-only",
      reason: "permission",
    });
    expect(calls).toEqual([]);
  });

  test("reuses only an exact clean worktree and performs no fetch or create", () => {
    const { deps, calls } = fake({
      ...writablePreamble(porcelain([{ path: EXISTING, head: SHA, branch: "feature" }])),
      [`${EXISTING} :: symbolic-ref --quiet --short HEAD`]: "feature\n",
      [`${EXISTING} :: rev-parse --verify HEAD^{commit}`]: `${SHA}\n`,
      [`${EXISTING} :: status --porcelain=v1 -z --untracked-files=all`]: "",
    });
    expect(checkoutReviewWorktree(session(), deps)).toEqual({
      mode: "writable",
      action: "reused",
      worktree: EXISTING,
      branch: "feature",
      head: SHA,
      push: { remote: "origin", ref: "feature" },
    });
    expect(mutating(calls)).toEqual([]);
  });

  test("a dirty exact worktree refuses with actionable context", () => {
    const { deps, calls } = fake({
      ...writablePreamble(porcelain([{ path: EXISTING, head: SHA, branch: "feature" }])),
      [`${EXISTING} :: symbolic-ref --quiet --short HEAD`]: "feature\n",
      [`${EXISTING} :: rev-parse --verify HEAD^{commit}`]: `${SHA}\n`,
      [`${EXISTING} :: status --porcelain=v1 -z --untracked-files=all`]: "?? scratch.txt\0",
    });
    expect(() => checkoutReviewWorktree(session(), deps)).toThrow(expect.objectContaining({
      code: "E_REVIEW_WORKTREE_DIRTY",
      message: expect.stringContaining("commit, stash, or remove"),
    }));
    expect(mutating(calls)).toEqual([]);
  });

  test("a stale matching worktree is never fetched, reset, or recreated", () => {
    const { deps, calls } = fake(writablePreamble(
      porcelain([{ path: EXISTING, head: OTHER, branch: "feature" }]),
    ));
    expect(() => checkoutReviewWorktree(session(), deps)).toThrow(expect.objectContaining({
      code: "E_REVIEW_WORKTREE_STALE",
    }));
    expect(mutating(calls)).toEqual([]);
  });

  test("a locked exact clean worktree is reusable and preserves its reason", () => {
    const locked = `worktree ${EXISTING}\0HEAD ${SHA}\0branch refs/heads/feature\0locked owned by another agent\0\0`;
    const { deps, calls } = fake({
      ...writablePreamble(locked),
      [`${EXISTING} :: symbolic-ref --quiet --short HEAD`]: "feature\n",
      [`${EXISTING} :: rev-parse --verify HEAD^{commit}`]: `${SHA}\n`,
      [`${EXISTING} :: status --porcelain=v1 -z --untracked-files=all`]: "",
    });
    expect(checkoutReviewWorktree(session(), deps)).toMatchObject({
      mode: "writable",
      action: "reused",
      worktree: EXISTING,
      lock: { reason: "owned by another agent" },
    });
    expect(mutating(calls)).toEqual([]);
  });

  test("path collision refuses before fetch and leaves the occupant untouched", () => {
    const { deps, calls, made } = fake(
      writablePreamble(porcelain([{ path: "/repo", head: SHA, branch: "main" }])),
      { exists: true },
    );
    expect(() => checkoutReviewWorktree(session(), deps)).toThrow(expect.objectContaining({
      code: "E_REVIEW_WORKTREE_COLLISION",
    }));
    expect(mutating(calls)).toEqual([]);
    expect(made).toEqual([]);
  });

  test("malformed worktree state refuses before fetch or directory creation", () => {
    const { deps, calls, made } = fake(writablePreamble("not porcelain\0\0"));
    expect(() => checkoutReviewWorktree(session(), deps)).toThrow(expect.objectContaining({
      code: "E_REVIEW_WORKTREE_STATE",
    }));
    expect(mutating(calls)).toEqual([]);
    expect(made).toEqual([]);
  });

  test("a missing origin refuses before any mutating git command", () => {
    const { deps, calls, made } = fake({
      [`${REPO} :: remote get-url origin`]: new Error("No such remote 'origin'"),
    });
    expect(() => checkoutReviewWorktree(session(), deps)).toThrow(expect.objectContaining({
      code: "E_REVIEW_GIT_REMOTE",
      message: expect.stringContaining("cannot read origin"),
    }));
    expect(mutating(calls)).toEqual([]);
    expect(made).toEqual([]);
  });

  test("a missing remote ref produces a typed refusal and creates no worktree", () => {
    const { deps, calls, made } = fake({
      ...writablePreamble(porcelain([{ path: "/repo", head: SHA, branch: "main" }])),
      [`${REPO} :: ls-remote --exit-code origin refs/heads/feature`]: new Error("remote ref does not exist"),
    });
    expect(() => checkoutReviewWorktree(session(), deps)).toThrow(expect.objectContaining({
      code: "E_REVIEW_HEAD_REF",
      message: expect.stringContaining("does not exist or cannot be read"),
    }));
    expect(mutating(calls)).toEqual([]);
    expect(made).toEqual([]);
  });

  test("a freshly fetched head that differs from the frozen review refuses before create", () => {
    const { deps, calls, made } = fake({
      ...writablePreamble(porcelain([{ path: "/repo", head: SHA, branch: "main" }])),
      [`${REPO} :: ls-remote --exit-code origin refs/heads/feature`]: `${OTHER}\trefs/heads/feature\n`,
    });
    expect(() => checkoutReviewWorktree(session(), deps)).toThrow(expect.objectContaining({
      code: "E_REVIEW_HEAD_STALE",
      message: expect.stringContaining("refresh-head"),
    }));
    expect(mutating(calls)).toEqual([]);
    expect(made).toEqual([]);
  });

  test("fetches, verifies, and creates a tracked worktree without commit or push", () => {
    const target = `${WORKTREE_ROOT}/review-acme-app-pr-42`;
    const { deps, calls, made } = fake({
      ...writablePreamble(porcelain([{ path: "/repo", head: SHA, branch: "main" }])),
      [`${REPO} :: ls-remote --exit-code origin refs/heads/feature`]: `${SHA}\trefs/heads/feature\n`,
      [`${REPO} :: fetch --no-tags origin +refs/heads/feature:refs/remotes/origin/feature`]: "",
      [`${REPO} :: rev-parse --verify refs/remotes/origin/feature^{commit}`]: `${SHA}\n`,
      [`${REPO} :: rev-parse --verify refs/heads/feature^{commit}`]: new Error("missing"),
      [`${REPO} :: worktree add --track -b feature ${target} refs/remotes/origin/feature`]: "",
      [`${target} :: symbolic-ref --quiet --short HEAD`]: "feature\n",
      [`${target} :: rev-parse --verify HEAD^{commit}`]: `${SHA}\n`,
      [`${target} :: status --porcelain=v1 -z --untracked-files=all`]: "",
    });
    const result = checkoutReviewWorktree(session(), deps);
    expect(result).toMatchObject({
      mode: "writable",
      action: "created",
      worktree: target,
      head: SHA,
      push: { remote: "origin", ref: "feature" },
    });
    expect(made).toEqual([WORKTREE_ROOT]);
    expect(calls.some((call) => / :: (reset|checkout|commit|push)( |$)/.test(call))).toBe(false);
  });

  test("an existing stale local branch is not reset", () => {
    const { deps, calls, made } = fake({
      ...writablePreamble(porcelain([{ path: "/repo", head: SHA, branch: "main" }])),
      [`${REPO} :: ls-remote --exit-code origin refs/heads/feature`]: `${SHA}\trefs/heads/feature\n`,
      [`${REPO} :: fetch --no-tags origin +refs/heads/feature:refs/remotes/origin/feature`]: "",
      [`${REPO} :: rev-parse --verify refs/remotes/origin/feature^{commit}`]: `${SHA}\n`,
      [`${REPO} :: rev-parse --verify refs/heads/feature^{commit}`]: `${OTHER}\n`,
    });
    expect(() => checkoutReviewWorktree(session(), deps)).toThrow(expect.objectContaining({
      code: "E_REVIEW_WORKTREE_STALE",
      message: expect.stringContaining("will not reset"),
    }));
    expect(mutating(calls)).toEqual([]);
    expect(made).toEqual([]);
  });
});

describe("freshReviewMetadata", () => {
  test("re-resolves the stored PR URL and authenticated permission", () => {
    const calls: Array<[string, string[]]> = [];
    const metadata = freshReviewMetadata(session(), {
      run: (command, args) => {
        calls.push([command, args]);
        if (args[0] === "pr") return JSON.stringify({
          number: 42,
          url: "https://github.com/acme/app/pull/42",
          title: "Updated title",
          author: { login: "octo" },
          baseRefName: "main",
          headRefName: "feature",
          headRefOid: OTHER,
          headRepository: { nameWithOwner: "acme/app", name: "app" },
          headRepositoryOwner: { login: "acme" },
          state: "OPEN",
          isCrossRepository: false,
          maintainerCanModify: true,
        });
        return JSON.stringify({ viewerPermission: "WRITE" });
      },
    });
    expect(metadata.headSha).toBe(OTHER);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toContain("https://github.com/acme/app/pull/42");
  });

  test("GitHub failures remain typed CLI errors", () => {
    expect(() => freshReviewMetadata(session(), { run: () => { throw new Error("offline"); } }))
      .toThrow(expect.objectContaining({ code: "E_GH" } satisfies Partial<CliError>));
  });
});
