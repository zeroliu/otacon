// otacon status [--all] — the crash/resume entry point (review loop and daemon API): a
// brand-new agent session runs this to find its open session, current
// revision, and undelivered event count, then resumes the loop.
//
// Routing is registry-first (session registry and switcher): the daemon's registry says where
// every session's repo lives, so the default view is "sessions whose repo
// contains my cwd" — no local state needed, the registry is the source of truth.

import { sep } from "node:path";
import { parseArgs } from "node:util";
import { otaconPort, planPath } from "../../shared/paths.js";
import type { RegistrySession } from "../../shared/types.js";
import { api, ensureDaemon } from "../client.js";
import { printJson } from "../output.js";
import { realpathOr, worktreeOwners } from "../session.js";

function repoContains(repo: string, cwd: string): boolean {
  const root = realpathOr(repo);
  return cwd === root || cwd.startsWith(root + sep);
}

export async function statusCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { all: { type: "boolean", default: false } },
  });
  const daemon = await ensureDaemon();
  const index = await api("GET", "/api/sessions");
  const all = (index.body.sessions ?? []) as RegistrySession[];
  const cwd = realpathOr(process.cwd());
  const relevant = values.all ? all : all.filter((s) => repoContains(s.repo, cwd));

  // Detail adds revision + pendingEvents (the undelivered event count).
  const details = await Promise.all(
    relevant.map((s) => api("GET", `/api/sessions/${s.id}`)),
  );
  const sessions = details.flatMap((detail) => {
    // A session can vanish between index and detail (e.g. otacon clean);
    // skip it rather than spreading the 404 error body into the report.
    if (detail === undefined || detail.status !== 200) return [];
    return [detail.body];
  });

  // The worktree owner is found over ALL sessions, not `relevant`: the owner's
  // `.repo` is the MAIN repo (where planning happened), which does not contain
  // this build-worktree cwd, so it would never appear in the repo-scoped list. A
  // single owner surfaces as the resume candidate; ambiguity stays silent (let
  // `otacon resume` refuse with the candidate list).
  const owners = worktreeOwners(all, cwd);
  const owner = owners.length === 1 ? owners[0] : undefined;
  const resumeCandidate = owner
    ? { id: owner.id, title: owner.title, status: owner.status, plan: planPath(owner.repo, owner.id) }
    : undefined;

  printJson({
    ok: true,
    daemon: { version: daemon.version, pid: daemon.pid, port: otaconPort() },
    sessions,
    ...(resumeCandidate ? { resumeCandidate } : {}),
  });
  return 0;
}
