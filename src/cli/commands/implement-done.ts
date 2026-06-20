// otacon implement-done [--pr <url>] [--failed] [--session id] — the agent's
// build-outcome report for Approve & Implement. Once the
// approved plan is built, the agent calls this to flip the session out of
// `implementing`: `--failed` → `implement_failed`, otherwise `implemented`
// (both terminal). `--pr` records the opened PR's URL so the home card can
// surface the link. Prints the daemon's {ok, session, status, prUrl}.
//
// The session must currently be `implementing`: a stray call (or a double
// report) surfaces the daemon's E_NOT_IMPLEMENTING as a clear CLI failure, not
// a crash — symmetrical with how the other mutating verbs translate a 409.

import { parseArgs } from "node:util";
import { api, ensureDaemon } from "../client.js";
import { fail, printJson } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";

export async function implementDoneCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      pr: { type: "string" },
      failed: { type: "boolean", default: false },
      session: { type: "string" },
    },
  });

  // Omit absent keys: a bare `implement-done` posts {} (success), the daemon
  // defaults to `implemented`. --failed and --pr are independent — an aborted
  // build can still carry the PR of a partial branch if the agent opened one.
  const payload: { pr?: string; failed?: boolean } = {
    ...(values.pr !== undefined ? { pr: values.pr } : {}),
    ...(values.failed === true ? { failed: true } : {}),
  };

  await ensureDaemon();
  const session = resolveSession(await listSessions(), values.session, realpathOr(process.cwd()));

  const response = await api("POST", `/api/sessions/${session.id}/implement-done`, payload);
  if (response.status === 200) {
    printJson(response.body);
    return 0;
  }
  const code = (response.body.error as { code?: string } | undefined)?.code;
  const message = (response.body.error as { message?: string } | undefined)?.message;
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
