// otacon open [--session id]: launch the review URL in the browser. It runs on
// the human's machine and the verb means "show me the page", so it spawns the
// browser; OTACON_NO_BROWSER prints the URL as JSON
// instead, for headless hosts and URL-parsing agents (DECISIONS.md "open and
// config launch the browser"). With no resolvable session the index URL is the
// answer, not an error; reading is never the wrong screen, and the never-guess
// rule guards writes, not looks.
//
// Open-tab reuse (DECISIONS.md "reuse an existing open tab"): if any otacon tab
// from this daemon is already connected (health's daemon-wide `viewers >= 1`),
// skip the launch rather than pile up a duplicate tab. Dedup only, no focus, and
// it applies to whichever url we would have opened: a single open tab, via its
// session sidebar, already reaches every session.

import { parseArgs } from "node:util";
import { openOrPrint } from "../browser.js";
import { baseUrl, ensureDaemon } from "../client.js";
import { CliError, notice, printJson } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";

export async function openCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { session: { type: "string" } },
  });
  const { viewers } = await ensureDaemon();

  // Deliver a url the way `open` does, but suppress the launch when a tab from
  // this daemon is already open. `viewers ?? 0` keeps an absent field behaving
  // like today (open as usual), so an older daemon degrades gracefully.
  const deliver = (url: string, payload: Record<string, unknown>): void => {
    if ((viewers ?? 0) >= 1) {
      // A tab from this daemon is already connected; don't spawn a duplicate.
      // Under OTACON_NO_BROWSER the result is machine-read, so flag the reuse on
      // stdout; interactively, mirror the spawn path and notice only on stderr.
      if (process.env.OTACON_NO_BROWSER) {
        printJson({ ...payload, reused: true });
      } else {
        notice("otacon is already open in this browser; not opening another tab");
      }
      return;
    }
    openOrPrint(url, { ...payload, reused: false });
  };

  const sessions = await listSessions();
  try {
    // Explicit ids are read-only navigation, so either session kind is valid.
    // Implicit routing remains plan-only: write-oriented plan commands and
    // `open` keep the same never-guess behavior when reviews coexist.
    const session = values.session === undefined
      ? resolveSession(sessions, undefined, realpathOr(process.cwd()))
      : sessions.find((candidate) => candidate.id === values.session);
    if (session === undefined) {
      throw new CliError("E_UNKNOWN_SESSION", `--session ${values.session}: not in the daemon registry`);
    }
    const url = `${baseUrl()}/s/${session.id}`;
    deliver(url, { ok: true, session: session.id, title: session.title, url });
  } catch (error) {
    // An explicit --session that fails to resolve is a real refusal; implicit
    // resolution failures (no session, ambiguity, stale pointer) degrade to
    // the index, which lists everything.
    if (!(error instanceof CliError) || values.session !== undefined) throw error;
    notice(`${error.message}; using the index`);
    const url = `${baseUrl()}/`;
    deliver(url, { ok: true, url });
  }
  return 0;
}
