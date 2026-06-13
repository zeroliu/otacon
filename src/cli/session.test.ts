import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistrySession } from "../shared/types.js";
import { CliError } from "./output.js";
import { currentBranch, findRepoRoot, resolveSession } from "./session.js";

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

function session(id: string, repo: string, status: RegistrySession["status"] = "draft"): RegistrySession {
  const now = new Date().toISOString();
  return {
    id,
    title: `title for ${id}`,
    repo,
    branch: "",
    quick: false,
    status,
    createdAt: now,
    updatedAt: now,
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
