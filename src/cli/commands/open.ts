// otacon open [--session id]: launch the review URL in the browser. It runs on
// the human's machine and the verb means "show me the page", so it spawns the
// browser; OTACON_NO_BROWSER prints the URL as JSON
// instead, for headless hosts and URL-parsing agents (DECISIONS.md "open and
// config launch the browser"). With no resolvable session the index URL is the
// answer, not an error; reading is never the wrong screen, and the never-guess
// rule guards writes, not looks.
//
// Open-tab reuse (DECISIONS.md "routes one existing tab"): if any Otacon tab
// from this daemon is connected, route the daemon-selected visible/live tab to
// the exact URL rather than pile up a duplicate. This is in-page navigation,
// not unreliable OS-level window focus.

import { parseArgs } from "node:util";
import { openOrPrint } from "../browser.js";
import { api, baseUrl, ensureDaemon } from "../client.js";
import { CliError, notice, printJson } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";

export async function openCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { session: { type: "string" } },
  });
  const { viewers } = await ensureDaemon();

  // Deliver a URL by routing one existing tab, with launch as the race/failure
  // fallback. `viewers ?? 0` keeps an absent field behaving like today (open as
  // usual), so an older daemon degrades gracefully.
  const deliver = async (
    url: string,
    payload: Record<string, unknown>,
    session?: string,
  ): Promise<void> => {
    // Headless callers explicitly requested no browser side effects. Preserve
    // the JSON-only contract and report whether a tab was observed, but do not
    // navigate that tab or launch a new one.
    if (process.env.OTACON_NO_BROWSER) {
      printJson({ ...payload, reused: (viewers ?? 0) >= 1 });
      return;
    }
    if ((viewers ?? 0) >= 1) {
      try {
        const routed = await api(
          "POST",
          "/api/viewers/navigate",
          session === undefined ? {} : { session },
        );
        if (routed.status === 200 && routed.body.delivered === true) {
          notice("switched the existing Otacon tab to this page");
          return;
        }
      } catch {
        // The viewer may have disappeared or the daemon may have restarted
        // between health and routing. Opening the URL is the safe fallback.
      }
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
    await deliver(url, { ok: true, session: session.id, title: session.title, url }, session.id);
  } catch (error) {
    // An explicit --session that fails to resolve is a real refusal; implicit
    // resolution failures (no session, ambiguity, stale pointer) degrade to
    // the index, which lists everything.
    if (!(error instanceof CliError) || values.session !== undefined) throw error;
    notice(`${error.message}; using the index`);
    const url = `${baseUrl()}/`;
    await deliver(url, { ok: true, url });
  }
  return 0;
}
