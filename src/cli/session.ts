// Registry-first session resolution (DESIGN.md §7): explicit --session always
// wins; otherwise the .otacon/current-session pointer at the repo root;
// otherwise the repo's single active session in the daemon registry. Two or
// more active sessions without a pointer — or a pointer naming a session the
// registry does not know — is a refusal carrying the candidates, never a guess
// (DECISIONS.md "Session resolution precedence").

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { currentSessionPath } from "../shared/paths.js";
import type { RegistrySession } from "../shared/types.js";
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

function readPointer(repoRoot: string): string | undefined {
  try {
    return readFileSync(currentSessionPath(repoRoot), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The daemon registry — callers ensureDaemon() first. */
export async function listSessions(): Promise<RegistrySession[]> {
  const response = await api("GET", "/api/sessions");
  return (response.body.sessions ?? []) as RegistrySession[];
}

const isActive = (s: RegistrySession): boolean => s.status !== "approved";

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
    return session;
  }

  const root = findRepoRoot(cwd) ?? realpathOr(cwd);
  const pointer = readPointer(root);
  if (pointer !== undefined) {
    const session = sessions.find((s) => s.id === pointer);
    if (!session) {
      // A stale pointer never falls through to the registry scan: silently
      // picking "the other session" could cross-post feedback.
      fail(
        "E_STALE_POINTER",
        `${currentSessionPath(root)} points at ${pointer}, which is not in the daemon registry; run otacon start or pass --session <id>`,
      );
    }
    return session;
  }

  const here = sessions.filter((s) => isActive(s) && realpathOr(s.repo) === root);
  if (here.length === 1) return here[0] as RegistrySession;
  if (here.length === 0) {
    fail(
      "E_NO_SESSION",
      `no active otacon session for ${root}; run otacon start (or pass --session <id>)`,
    );
  }
  fail(
    "E_AMBIGUOUS_SESSION",
    `${here.length} active sessions for ${root} and no .otacon/current-session pointer; pass --session <id>`,
    { sessions: here.map((s) => ({ id: s.id, title: s.title, status: s.status })) },
  );
}
