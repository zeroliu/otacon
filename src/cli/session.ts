// Registry-first session resolution (session registry and switcher): explicit --session always
// wins; otherwise the repo's single active session in the daemon registry — the
// registry is the single source of truth, there is no local pointer. Zero active
// sessions for the repo, or two or more, is a refusal carrying the candidates,
// never a guess (DECISIONS.md "Session resolution precedence").

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { TERMINAL_STATUSES, type RegistrySession } from "../shared/types.js";
import { api } from "./client.js";
import { fail } from "./output.js";

/** Resolve symlinks (mktemp dirs on macOS live behind /var → /private/var). */
export function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Git repo root above cwd (DECISIONS.md "`.otacon/` lives at the git repo
 * root"); undefined outside any git repo (callers fall back to cwd).
 */
export function findRepoRoot(cwd: string): string | undefined {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  return root === undefined || root === "" ? undefined : realpathOr(root);
}

/** Current branch name; "" when detached, unborn-without-name, or not a repo. */
export function currentBranch(cwd: string): string {
  return git(cwd, ["branch", "--show-current"]) ?? "";
}

/** The daemon registry — callers ensureDaemon() first. */
export async function listSessions(): Promise<RegistrySession[]> {
  const response = await api("GET", "/api/sessions");
  return (response.body.sessions ?? []) as RegistrySession[];
}

/**
 * Sessions whose recorded Implement worktree IS the cwd's git worktree root.
 * The key that lets `/otacon` run inside a build worktree find the session
 * that created it (its .repo is the main repo, so the repo-root match misses).
 */
export function worktreeOwners(sessions: RegistrySession[], cwd: string): RegistrySession[] {
  const root = findRepoRoot(cwd) ?? realpathOr(cwd);
  return sessions.filter(
    (s) => s.kind !== "review" && s.impl !== undefined && realpathOr(s.impl.worktree) === root,
  );
}

// Exactly the terminal states are inactive (the single source of truth in
// shared/types.ts): `implementing` resolves as the active session so the agent
// can keep narrating/asking mid-build and `otacon resume` re-adopts it, while
// `implemented`/`implement_failed` no longer count once the build is over.
const isActive = (s: RegistrySession): boolean => !TERMINAL_STATUSES.includes(s.status);

export function resolveSession(
  sessions: RegistrySession[],
  explicit: string | undefined,
  cwd: string,
): RegistrySession {
  if (explicit !== undefined) {
    const session = sessions.find((s) => s.id === explicit);
    if (!session) {
      fail("E_UNKNOWN_SESSION", `--session ${explicit}: not in the daemon registry`);
    }
    if (session.kind === "review") {
      fail("E_SESSION_KIND", `--session ${explicit} is a PR review, not a plan session`);
    }
    return session;
  }

  // No local pointer: the repo's single active (non-terminal) session is the
  // implicit default, matched by repo root OR build-worktree root (so a resumed
  // session resolves from inside its worktree, whose .repo is the main repo). A
  // terminal session is over (review loop and daemon API): approved, or a
  // finished build (implemented/implement_failed), so it never counts; reaching
  // it needs an explicit --session. Two or more active sessions refuse with the
  // candidate list rather than guess: cross-posting feedback to the wrong plan
  // is unrecoverable confusion.
  const root = findRepoRoot(cwd) ?? realpathOr(cwd);
  const here = sessions.filter(
    (s) => s.kind !== "review" && isActive(s) &&
      (realpathOr(s.repo) === root || (s.impl !== undefined && realpathOr(s.impl.worktree) === root)),
  );
  if (here.length === 1) return here[0] as RegistrySession;
  if (here.length === 0) {
    fail(
      "E_NO_SESSION",
      `no active otacon session for ${root}; run otacon start (or pass --session <id>)`,
    );
  }
  fail(
    "E_AMBIGUOUS_SESSION",
    `${here.length} active sessions for ${root}; pass --session <id>`,
    { sessions: here.map((s) => ({ id: s.id, title: s.title, status: s.status })) },
  );
}
