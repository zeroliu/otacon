// otacon resume [--session id]: reopen a finished otacon session to amend its
// approved plan. Run from inside an Implement build worktree, it auto-detects
// the session that worktree belongs to (the recorded `impl.worktree`) and flips
// it back to `revising`, so a later `/otacon <request>` amends the same plan in
// place instead of spawning a second worktree. `--session` names one explicitly.
//
// The session must be terminal (a finished build, or approved): a non-terminal
// session surfaces the daemon's E_NOT_REOPENABLE as a clear CLI failure, not a
// crash (symmetrical with how the other mutating verbs translate a 409).

import { parseArgs } from "node:util";
import { planPath } from "../../shared/paths.js";
import type { RegistrySession } from "../../shared/types.js";
import { api, ensureDaemon } from "../client.js";
import { fail, printJson } from "../output.js";
import { listSessions, realpathOr, worktreeOwners } from "../session.js";

/**
 * The session to reopen: the explicit `--session` id when given, else the lone
 * session whose recorded build worktree is this cwd. Refuses (never returns) on
 * an unknown id, no worktree owner, or two or more owners of one worktree.
 */
function resolveTarget(sessions: RegistrySession[], explicit: string | undefined): RegistrySession {
  if (explicit !== undefined) {
    const target = sessions.find((s) => s.id === explicit);
    if (target === undefined) {
      fail("E_UNKNOWN_SESSION", `--session ${explicit}: not in the daemon registry`);
    }
    if (target.kind === "review") {
      fail("E_SESSION_KIND", `--session ${explicit} is a PR review, not a plan session`);
    }
    return target;
  }
  const owners = worktreeOwners(sessions, realpathOr(process.cwd()));
  if (owners.length === 0) {
    fail(
      "E_NO_RESUME_CANDIDATE",
      "not inside a known otacon build worktree; run otacon start to plan fresh",
    );
  }
  if (owners.length > 1) {
    fail("E_AMBIGUOUS_RESUME", `${owners.length} sessions claim this worktree; pass --session <id>`, {
      sessions: owners.map((s) => ({ id: s.id, title: s.title, status: s.status })),
    });
  }
  return owners[0] as RegistrySession;
}

export async function resumeCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { session: { type: "string" } },
  });

  await ensureDaemon();
  const sessions = await listSessions();

  // Target by explicit id, else the single session whose recorded build
  // worktree is this cwd. Zero candidates → plan fresh; two or more refuse with
  // the candidate list rather than guess which plan to reopen.
  const target = resolveTarget(sessions, values.session);

  const response = await api("POST", `/api/sessions/${target.id}/reopen`, {});
  if (response.status === 200) {
    // Enrich with where to edit: the plan lives in the home store
    // (~/.otacon/sessions/<id>/), so the agent knows the exact file to amend.
    printJson({ ...response.body, title: target.title, repo: target.repo, plan: planPath(target.id) });
    return 0;
  }
  const code = (response.body.error as { code?: string } | undefined)?.code;
  const message = (response.body.error as { message?: string } | undefined)?.message;
  if (response.status === 409) {
    fail(code ?? "E_NOT_REOPENABLE", message ?? `session ${target.id} is not reopenable`);
  }
  if (response.status === 404) {
    fail("E_UNKNOWN_SESSION", `daemon no longer knows session ${target.id}`);
  }
  fail("E_INTERNAL", `resume failed: ${JSON.stringify(response.body)}`, undefined, 2);
}
