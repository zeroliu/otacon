import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistrySession } from "../shared/types.js";
import { CliError } from "./output.js";
import { currentBranch, findRepoRoot, resolveSession, worktreeOwners } from "./session.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "otacon-cli-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function gitInit(path: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", path], { stdio: "ignore" });
}

function session(
  id: string,
  repo: string,
  status: RegistrySession["status"] = "draft",
  impl?: { worktree: string; branch: string },
): RegistrySession {
  const now = new Date().toISOString();
  return {
    id,
    title: `title for ${id}`,
    repo,
    branch: "",
    quick: false,
    socratic: false,
    status,
    createdAt: now,
    updatedAt: now,
    ...(impl ? { impl } : {}),
  };
}

function caught(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error("expected a CliError");
}

describe("findRepoRoot / currentBranch", () => {
  test("finds the git root from a nested subdirectory", () => {
    gitInit(dir);
    const sub = join(dir, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(findRepoRoot(sub)).toBe(dir);
  });

  test("returns undefined outside any git repo", () => {
    expect(findRepoRoot(dir)).toBeUndefined();
  });

  test("reports the branch of a fresh repo", () => {
    gitInit(dir);
    expect(currentBranch(dir)).toBe("main");
  });

  test("branch is empty outside git", () => {
    expect(currentBranch(dir)).toBe("");
  });
});

describe("resolveSession: explicit --session", () => {
  test("explicit id wins over the repo's lone active session", () => {
    gitInit(dir);
    const sessions = [session("otc_aaaaaa", dir), session("otc_bbbbbb", "/elsewhere")];
    expect(resolveSession(sessions, "otc_bbbbbb", dir).id).toBe("otc_bbbbbb");
  });

  test("explicit id not in the registry refuses", () => {
    const error = caught(() => resolveSession([], "otc_zzzzzz", dir));
    expect(error.code).toBe("E_UNKNOWN_SESSION");
    expect(error.exitCode).toBe(1);
  });

  test("explicit id may name an approved session (escape hatch)", () => {
    const sessions = [session("otc_aaaaaa", dir, "approved")];
    expect(resolveSession(sessions, "otc_aaaaaa", dir).id).toBe("otc_aaaaaa");
  });
});

describe("resolveSession: registry scan", () => {
  test("the repo's single active session is assumed", () => {
    gitInit(dir);
    const sessions = [session("otc_aaaaaa", dir), session("otc_bbbbbb", "/elsewhere")];
    expect(resolveSession(sessions, undefined, dir).id).toBe("otc_aaaaaa");
  });

  test("resolves the repo's active session from a nested subdirectory", () => {
    gitInit(dir);
    const sub = join(dir, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(resolveSession([session("otc_aaaaaa", dir)], undefined, sub).id).toBe("otc_aaaaaa");
  });

  test("resolves in a non-git directory (cwd is the root)", () => {
    expect(resolveSession([session("otc_aaaaaa", dir)], undefined, dir).id).toBe("otc_aaaaaa");
  });

  test("approved sessions do not count toward ambiguity", () => {
    const sessions = [session("otc_aaaaaa", dir, "approved"), session("otc_bbbbbb", dir, "in_review")];
    expect(resolveSession(sessions, undefined, dir).id).toBe("otc_bbbbbb");
  });

  test("two active sessions refuse with the candidate list — never guess", () => {
    const sessions = [session("otc_aaaaaa", dir), session("otc_bbbbbb", dir, "in_review")];
    const error = caught(() => resolveSession(sessions, undefined, dir));
    expect(error.code).toBe("E_AMBIGUOUS_SESSION");
    expect(error.exitCode).toBe(1);
    expect(error.extra.sessions).toEqual([
      { id: "otc_aaaaaa", title: "title for otc_aaaaaa", status: "draft" },
      { id: "otc_bbbbbb", title: "title for otc_bbbbbb", status: "in_review" },
    ]);
  });

  test("no session for this repo refuses with guidance", () => {
    const error = caught(() => resolveSession([session("otc_aaaaaa", "/elsewhere")], undefined, dir));
    expect(error.code).toBe("E_NO_SESSION");
    expect(error.message).toContain("otacon start");
  });
});

describe("worktreeOwners / worktree-aware resolution", () => {
  // `dir` is a tmp dir, NOT a git repo, so findRepoRoot returns undefined and the
  // code falls back to realpathOr(cwd), letting us stand in as the build worktree
  // root without a real git checkout. The session's .repo points elsewhere (the
  // main repo where planning happened); only its impl.worktree matches cwd.

  test("worktreeOwners returns the session whose impl.worktree is cwd", () => {
    const owner = session("otc_aaaaaa", "/main/repo", "implemented", { worktree: dir, branch: "feat" });
    const elsewhere = session("otc_bbbbbb", "/other/repo", "implementing", {
      worktree: "/some/other/worktree",
      branch: "x",
    });
    expect(worktreeOwners([owner, elsewhere], dir).map((s) => s.id)).toEqual(["otc_aaaaaa"]);
  });

  test("worktreeOwners ignores sessions without impl", () => {
    expect(worktreeOwners([session("otc_aaaaaa", dir)], dir)).toEqual([]);
  });

  test("resolveSession matches an active session by impl.worktree even when .repo differs", () => {
    // implementing is active; its .repo is the main repo, but impl.worktree is cwd.
    const owner = session("otc_aaaaaa", "/main/repo", "implementing", { worktree: dir, branch: "feat" });
    expect(resolveSession([owner], undefined, dir).id).toBe("otc_aaaaaa");
  });

  test("a TERMINAL session with matching impl.worktree is excluded by resolveSession but owned by worktreeOwners", () => {
    const owner = session("otc_aaaaaa", "/main/repo", "implemented", { worktree: dir, branch: "feat" });
    // worktreeOwners sees it (resume targets terminal sessions by design)...
    expect(worktreeOwners([owner], dir).map((s) => s.id)).toEqual(["otc_aaaaaa"]);
    // ...but resolveSession still excludes it (isActive == false) and refuses.
    const error = caught(() => resolveSession([owner], undefined, dir));
    expect(error.code).toBe("E_NO_SESSION");
  });
});
