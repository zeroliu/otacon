// otacon open [--session id]: launch the review URL in the browser (DESIGN.md
// §6, human convenience). It runs on the human's machine and the verb means "show
// me the page", so it spawns the browser; OTACON_NO_BROWSER prints the URL as JSON
// instead, for headless hosts and URL-parsing agents (DECISIONS.md "open and
// config launch the browser"). With no resolvable session the index URL is the
// answer, not an error; reading is never the wrong screen, and the never-guess
// rule guards writes, not looks.

import { parseArgs } from "node:util";
import { openOrPrint } from "../browser.js";
import { baseUrl, ensureDaemon } from "../client.js";
import { CliError, notice } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";

export async function openCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { session: { type: "string" } },
  });
  await ensureDaemon();
  const sessions = await listSessions();
  try {
    const session = resolveSession(sessions, values.session, realpathOr(process.cwd()));
    const url = `${baseUrl()}/s/${session.id}`;
    openOrPrint(url, { ok: true, session: session.id, title: session.title, url });
  } catch (error) {
    // An explicit --session that fails to resolve is a real refusal; implicit
    // resolution failures (no session, ambiguity, stale pointer) degrade to
    // the index, which lists everything.
    if (!(error instanceof CliError) || values.session !== undefined) throw error;
    notice(`${error.message}; using the index`);
    const url = `${baseUrl()}/`;
    openOrPrint(url, { ok: true, url });
  }
  return 0;
}
