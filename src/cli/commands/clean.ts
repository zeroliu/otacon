// otacon clean [--all]: permanently remove ended sessions. For every terminal
// session in this repo (--all: everywhere), it calls DELETE /api/sessions/:id;
// the daemon deregisters the session and removes its home folder
// `~/.otacon/sessions/<id>/` outright (no archive). The review UI drives the
// same route. The durable copies are never touched: the Save copy under the
// project's `plans.dir`, and (for Implement plans) the PR (DECISIONS.md "Delete
// permanently removes the home session folder; no archive").

import { parseArgs } from "node:util";
import { TERMINAL_STATUSES } from "../../shared/types.js";
import { api, ensureDaemon } from "../client.js";
import { notice, printJson } from "../output.js";
import { findRepoRoot, listSessions, realpathOr } from "../session.js";

export async function cleanCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { all: { type: "boolean", default: false } },
  });
  await ensureDaemon();
  const cwd = realpathOr(process.cwd());
  const root = findRepoRoot(cwd) ?? cwd;
  // Only terminal (ended) sessions qualify — approved, plus implemented /
  // implement_failed once a build finishes (approval and archive lifecycle). A terminal session
  // stays terminal, so clean only ever sweeps finished sessions: a racing
  // status change cannot sweep a live (including `implementing`) session.
  const targets = (await listSessions()).filter(
    (s) => TERMINAL_STATUSES.includes(s.status) && (values.all || realpathOr(s.repo) === root),
  );

  const cleaned: { session: string; title: string; repo: string }[] = [];
  for (const session of targets) {
    const response = await api("DELETE", `/api/sessions/${session.id}`);
    if (response.status !== 200) {
      notice(`skipping ${session.id}: ${JSON.stringify(response.body)}`);
      continue;
    }
    const pending = response.body.pendingEvents;
    if (typeof pending === "number" && pending > 0) {
      notice(`${session.id}: ${pending} undelivered event(s) removed with it`);
    }
    // The daemon permanently removed the home folder; nothing to record beyond
    // the session identity.
    cleaned.push({ session: session.id, title: session.title, repo: session.repo });
  }
  if (cleaned.length === 0) {
    notice(values.all ? "no ended sessions to clean" : `no ended sessions for ${root} (try --all)`);
  }
  printJson({ ok: true, cleaned });
  return 0;
}
