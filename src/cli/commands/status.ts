// otacon status [--all] — the crash/resume entry point (DESIGN.md §6): a
// brand-new agent session runs this to find its open session, current
// revision, and undelivered event count, then resumes the loop.
//
// Routing is registry-first (DESIGN.md §7): the daemon's registry says where
// every session's repo lives, so the default view is "sessions whose repo
// contains my cwd" — no local state needed beyond the optional
// .otacon/current-session pointer, which is only reported, never guessed from.

import { readFileSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { parseArgs } from "node:util";
import { currentSessionPath, otaconPort } from "../../shared/paths.js";
import type { RegistrySession } from "../../shared/types.js";
import { api, ensureDaemon } from "../client.js";
import { printJson } from "../output.js";

/** Resolve symlinks (mktemp dirs on macOS live behind /var → /private/var). */
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function repoContains(repo: string, cwd: string): boolean {
  const root = realpathOr(repo);
  return cwd === root || cwd.startsWith(root + sep);
}

function pointerAt(repo: string): string | undefined {
  try {
    return readFileSync(currentSessionPath(repo), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
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

  const sessions: Record<string, unknown>[] = [];
  for (const session of relevant) {
    // Detail adds revision + pendingEvents (the undelivered event count).
    const detail = await api("GET", `/api/sessions/${session.id}`);
    sessions.push({ ...detail.body, current: pointerAt(session.repo) === session.id });
  }
  printJson({
    ok: true,
    daemon: { version: daemon.version, pid: daemon.pid, port: otaconPort() },
    sessions,
  });
  return 0;
}
