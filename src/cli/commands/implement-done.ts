// otacon implement-done [--ledger <file>] [--pr <url>] [--failed] [--session id]
// — the agent's build-outcome report for Approve & Implement. Once the
// approved plan is built, the agent calls this to flip the session out of
// `implementing`: `--failed` → `implement_failed`, otherwise `implemented`
// (both terminal). `--pr` records the opened PR's URL so the home card can
// surface the link. `--ledger` attests every behavioral scenario in the
// approved plan's per-phase Verification gwt blocks (the verify-before-merge
// gate): on a success report the daemon refuses (422 E_UNVERIFIED) unless the
// ledger covers them all pass|skip with non-empty evidence. Prints the daemon's
// {ok, session, status, prUrl}.
//
// The session must currently be `implementing`: a stray call (or a double
// report) surfaces the daemon's E_NOT_IMPLEMENTING as a clear CLI failure, not
// a crash — symmetrical with how the other mutating verbs translate a 409.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { api, ensureDaemon } from "../client.js";
import { changedFiles } from "../drift.js";
import { fail, printJson, usageError } from "../output.js";
import { findRepoRoot, listSessions, realpathOr, resolveSession } from "../session.js";

export async function implementDoneCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      pr: { type: "string" },
      failed: { type: "boolean", default: false },
      ledger: { type: "string" },
      session: { type: "string" },
    },
  });

  // The ledger file is read+parsed here so a missing/garbled file is a clean
  // usage error, not an opaque daemon 422. Sent verbatim as `ledger`; the
  // daemon's gate judges completeness against the approved plan's scenarios.
  let ledger: unknown;
  if (values.ledger !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(values.ledger, "utf8");
    } catch (error) {
      usageError(`cannot read ledger file ${values.ledger}: ${(error as Error).message}`);
    }
    try {
      ledger = JSON.parse(raw);
    } catch (error) {
      usageError(`ledger file ${values.ledger} is not valid JSON: ${(error as Error).message}`);
    }
  }

  // Drift reconciliation input (Phase 3): the source files this build changed
  // vs its merge-base with the default branch, computed in the worktree the
  // agent runs in. The daemon reconciles them against the approved plan's
  // `Files:` and flags any it never cited. ADVISORY — `changedFiles` fails soft
  // (returns [] on any git error), so a non-repo/detached/no-merge-base cwd just
  // sends an empty list and never breaks the report. Only on a SUCCESS report:
  // an aborted build has no implementation to reconcile against the plan.
  const cwd = realpathOr(process.cwd());
  const changed = values.failed === true ? [] : changedFiles(findRepoRoot(cwd) ?? cwd);

  // Omit absent keys: a bare `implement-done` posts {} (success), the daemon
  // defaults to `implemented`. --failed and --pr are independent — an aborted
  // build can still carry the PR of a partial branch if the agent opened one.
  const payload: { pr?: string; failed?: boolean; ledger?: unknown; changed?: string[] } = {
    ...(values.pr !== undefined ? { pr: values.pr } : {}),
    ...(values.failed === true ? { failed: true } : {}),
    ...(ledger !== undefined ? { ledger } : {}),
    ...(changed.length > 0 ? { changed } : {}),
  };

  await ensureDaemon();
  const session = resolveSession(await listSessions(), values.session, cwd);

  const response = await api("POST", `/api/sessions/${session.id}/implement-done`, payload);
  if (response.status === 200) {
    printJson(response.body);
    return 0;
  }
  const error = response.body.error as
    | { code?: string; message?: string; unverified?: unknown }
    | undefined;
  const code = error?.code;
  const message = error?.message;
  if (response.status === 422) {
    // The verify-before-merge gate refused: surface the daemon's machine-
    // readable list of unattested scenarios so the agent can fix the ledger and
    // retry. Exit 1 (a failure the agent can act on), not 2 (usage/internal).
    fail(
      code ?? "E_UNVERIFIED",
      message ?? "implement-done refused: verification scenarios are not attested",
      error?.unverified !== undefined ? { unverified: error.unverified } : undefined,
    );
  }
  if (response.status === 409) {
    // Not implementing (never started, or already reported): surface the
    // daemon's own code so the agent knows the build outcome was not recorded.
    fail(code ?? "E_NOT_IMPLEMENTING", message ?? `session ${session.id} is not implementing`);
  }
  if (response.status === 404) {
    fail("E_UNKNOWN_SESSION", `daemon no longer knows session ${session.id}`);
  }
  if (response.status === 400) {
    fail("E_BAD_REQUEST", message ?? "daemon rejected the outcome report");
  }
  fail("E_INTERNAL", `implement-done failed: ${JSON.stringify(response.body)}`, undefined, 2);
}
