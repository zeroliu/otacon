// otacon start --title <t> [--quick] — mint and register a session (DESIGN.md
// §6, §16): POST /api/sessions, append .otacon/ to the repo's .gitignore if
// missing (with a notice), print the session id and review URL. No local
// session pointer — the daemon registry is the single source of truth (§7).

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
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

/**
 * First start in a repo appends a SELECTIVE .otacon/ ignore to .gitignore, with
 * a notice (DESIGN.md §16): `.otacon/*` ignores all working state while
 * `!.otacon/config.json` keeps the committed, team-shared project config tracked
 * (config.local.json stays ignored by the glob). A repo that already has any
 * otacon ignore line (blanket `.otacon/` from before, or this selective pair) is
 * left untouched — no migration of pre-existing ignores (plan decision t2).
 */
export function ensureGitignore(repo: string): void {
  const path = join(repo, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const covered = existing
    .split("\n")
    .some((line) => /^!?\/?\.otacon(\/\*?|\/config\.json)?\/?$/.test(line.trim()));
  if (covered) return;
  // Match the file's own line endings — appending LF to a CRLF file would
  // leave it with mixed endings.
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const separator = existing === "" || existing.endsWith("\n") ? "" : eol;
  appendFileSync(path, `${separator}.otacon/*${eol}!.otacon/config.json${eol}`);
  notice(
    `appended .otacon/ ignore to ${path} (working state stays out of git; config.json stays tracked, DESIGN.md §12, §16)`,
  );
}
