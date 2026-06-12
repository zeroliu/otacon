// otacon start --title <t> [--quick] — mint and register a session (DESIGN.md
// §6, §16): POST /api/sessions, write .otacon/current-session at the repo
// root, append .otacon/ to the repo's .gitignore if missing (with a notice),
// print the session id and review URL.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { currentSessionPath, otaconDir } from "../../shared/paths.js";
import type { RegistrySession } from "../../shared/types.js";
import { api, baseUrl, ensureDaemon } from "../client.js";
import { fail, notice, printJson, usageError } from "../output.js";
import { currentBranch, findRepoRoot, realpathOr } from "../session.js";

export async function startCommand(argv: string[]): Promise<number> {
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

  mkdirSync(otaconDir(repo), { recursive: true });
  const pointerPath = currentSessionPath(repo);
  if (existsSync(pointerPath)) {
    const previous = readFileSync(pointerPath, "utf8").trim();
    if (previous !== "" && previous !== session.id) {
      notice(`current-session pointer now ${session.id} (was ${previous})`);
    }
  }
  writeFileSync(pointerPath, `${session.id}\n`);
  if (gitRoot !== undefined) ensureGitignore(gitRoot);

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

/** First start in a repo appends .otacon/ to .gitignore, with a notice (DESIGN.md §16). */
function ensureGitignore(repo: string): void {
  const path = join(repo, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const covered = existing
    .split("\n")
    .some((line) => /^\/?\.otacon\/?$/.test(line.trim()));
  if (covered) return;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${separator}.otacon/\n`);
  notice(`appended .otacon/ to ${path} (working state stays out of git, DESIGN.md §12)`);
}
