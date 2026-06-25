// otacon start --title <t> [--quick] [--socratic] — mint and register a session:
// POST /api/sessions, print the session id, review URL, and the plan draft path
// (~/.otacon/sessions/<id>/plan.md, where the agent writes the plan). No local
// session pointer — the daemon registry is the single source of truth.

import { parseArgs } from "node:util";
import type { RegistrySession } from "../../shared/types.js";
import { planPath } from "../../shared/paths.js";
import { api, baseUrl, ensureDaemon } from "../client.js";
import { fail, notice, printJson, usageError } from "../output.js";
import { refreshInstalledWrappers } from "../install/wrapper.js";
import { currentBranch, findRepoRoot, realpathOr } from "../session.js";
import { maybeAutoUpdate } from "../update.js";

export async function startCommand(argv: string[]): Promise<number> {
  // Pre-session auto-update gate (install/update): on a newer published version
  // this self-updates and re-execs `start` with the original argv, so the flags
  // below are reconstructed exactly; in every other case it returns and we
  // proceed on the installed version. Must run before ensureDaemon so the
  // re-exec's version handshake restarts the stale daemon.
  await maybeAutoUpdate(argv);

  // Fallback/migration: re-assert already-installed managed wrappers to their
  // desired state (promote a copy to a symlink, repair a drifted project copy).
  // Inert for a correct symlink, skipped on source runs, notices go to stderr,
  // so the single-JSON-line stdout contract below is untouched.
  try {
    refreshInstalledWrappers();
  } catch {
    /* fail-open: never block start on a wrapper refresh */
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      title: { type: "string" },
      quick: { type: "boolean", default: false },
      // No default: `values.socratic` is `true` only when `--socratic` is passed,
      // `undefined` otherwise — letting the daemon apply the `socratic.default`
      // config when the flag is omitted.
      socratic: { type: "boolean" },
    },
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
    // Send `socratic: true` only when the flag was passed; omitting it lets the
    // daemon apply the `socratic.default` config.
    ...(values.socratic === true ? { socratic: true } : {}),
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
    socratic: session.socratic,
    url: `${baseUrl()}/s/${session.id}`,
    plan: planPath(session.id),
  });
  return 0;
}
