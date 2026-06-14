// otacon clean [--all] — archive working state for ended sessions (DESIGN.md
// §6, §12): for every approved session in this repo (--all: everywhere), it
// calls DELETE /api/sessions/:id; the daemon deregisters the session and
// archives its .otacon/<id>/ dir to .otacon/archive/<id>/, reporting the
// destination as `archivedTo` (the review UI drives the same route — approved
// archives, pending hard-deletes). Committed artifacts under docs/plans/ are
// never touched (DECISIONS.md "clean: daemon deregisters and archives").

import { parseArgs } from "node:util";
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
  // Only approved (ended) sessions qualify. `approved` is terminal in the
  // status machine, so a session listed here stays approved: clean's DELETE
  // always takes the daemon's archive branch, never the UI's pending
  // hard-delete one — a racing status change cannot sweep a live session.
  const targets = (await listSessions()).filter(
    (s) => s.status === "approved" && (values.all || realpathOr(s.repo) === root),
  );

  const cleaned: { session: string; title: string; repo: string; archivedTo: string | null }[] = [];
  for (const session of targets) {
    const response = await api("DELETE", `/api/sessions/${session.id}`);
    if (response.status !== 200) {
      notice(`skipping ${session.id}: ${JSON.stringify(response.body)}`);
      continue;
    }
    const pending = response.body.pendingEvents;
    if (typeof pending === "number" && pending > 0) {
      notice(`${session.id}: ${pending} undelivered event(s) archived with it`);
    }
    // The daemon archived the dir and tells us where (null only if it was gone).
    const archivedTo = (response.body.archivedTo as string | null | undefined) ?? null;
    cleaned.push({ session: session.id, title: session.title, repo: session.repo, archivedTo });
  }
  if (cleaned.length === 0) {
    notice(values.all ? "no approved sessions to clean" : `no approved sessions for ${root} (try --all)`);
  }
  printJson({ ok: true, cleaned });
  return 0;
}
