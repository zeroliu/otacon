// otacon start --title <t> [--quick] — mint and register a session (DESIGN.md
// §6, §16): POST /api/sessions, print the session id and review URL. No local
// session pointer — the daemon registry is the single source of truth (§7).

import { parseArgs } from "node:util";
import type { RegistrySession } from "../../shared/types.js";
import { api, baseUrl, ensureDaemon } from "../client.js";
import { fail, notice, printJson, usageError } from "../output.js";
import { currentBranch, findRepoRoot, realpathOr } from "../session.js";
import { maybeAutoUpdate } from "../update.js";

export async function startCommand(argv: string[]): Promise<number> {
  // Pre-session auto-update gate (DESIGN.md §16): on a newer published version
  // this self-updates and re-execs `start` with the original argv, so the flags
  // below are reconstructed exactly; in every other case it returns and we
  // proceed on the installed version. Must run before ensureDaemon so the
  // re-exec's version handshake restarts the stale daemon.
  await maybeAutoUpdate(argv);

  const { values } = parseArgs({
    args: argv,
    options: { title: { type: "string" }, quick: { type: "boolean", default: false } },
  });
  if (values.title === undefined || values.title.trim() === "") {
    usageError("otacon start requires --title <t>");
  }

  const cwd = realpathOr(process.cwd());
  const gitRoot = findRepoRoot(cwd);
  if (gitRoot === undefined) {
    // DECISIONS.md "`.otacon/` lives at the git repo root": non-git fallback.
    notice(`${cwd} is not inside a git repository; using it as the repo root`);
  }
  const repo = gitRoot ?? cwd;

  await ensureDaemon();
  const created = await api("POST", "/api/sessions", {
    title: values.title,
    repo,
    branch: gitRoot === undefined ? "" : currentBranch(cwd),
    quick: values.quick === true,
  });
  if (created.status !== 201) {
    fail("E_INTERNAL", `session create failed: ${JSON.stringify(created.body)}`, undefined, 2);
  }
  const session = created.body as unknown as RegistrySession;

  printJson({
    ok: true,
    session: session.id,
    title: session.title,
    repo,
    branch: session.branch,
    quick: session.quick,
    url: `${baseUrl()}/s/${session.id}`,
  });
  return 0;
}
