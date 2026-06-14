// otacon clean [--all] — archive working state for ended sessions (DESIGN.md
// §6, §12): for every approved session in this repo (--all: everywhere), the
// daemon deregisters it (DELETE /api/sessions/:id, the approved branch — the
// review UI drives the same route to hard-delete a *pending* session instead),
// then the CLI moves .otacon/<id>/ to .otacon/archive/<id>/ in the session's
// repo. Committed artifacts under docs/plans/ are never touched (DECISIONS.md
// "clean: daemon deregisters, CLI archives").

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { otaconDir, sessionDir } from "../../shared/paths.js";
import { api, ensureDaemon } from "../client.js";
import { notice, printJson } from "../output.js";
import { findRepoRoot, listSessions, realpathOr } from "../session.js";

/** Move .otacon/<id>/ into .otacon/archive/ (suffix on collision); null = no dir. */
function archiveSessionDir(repo: string, id: string): string | null {
  const source = sessionDir(repo, id);
  if (!existsSync(source)) return null;
  const base = join(otaconDir(repo), "archive");
  mkdirSync(base, { recursive: true });
  let dest = join(base, id);
  for (let n = 2; existsSync(dest); n++) dest = join(base, `${id}-${n}`);
  renameSync(source, dest);
  return dest;
}

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
    const archivedTo = archiveSessionDir(session.repo, session.id);
    cleaned.push({ session: session.id, title: session.title, repo: session.repo, archivedTo });
  }
  if (cleaned.length === 0) {
    notice(values.all ? "no approved sessions to clean" : `no approved sessions for ${root} (try --all)`);
  }
  printJson({ ok: true, cleaned });
  return 0;
}
