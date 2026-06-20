// Launch a URL in the user's default browser for `otacon open` / `otacon config`
// (review loop and daemon API, DECISIONS.md "open and config launch the browser"). Both run on
// the human's machine and the whole point of these two verbs is "show me the
// page", so they spawn the browser instead of printing the URL.
//
// The launch is best-effort and detached: a missing opener (ENOENT), a non-GUI
// host, or a slow browser must never fail the command, throw out of the CLI's
// JSON-on-stdout contract, or stall an agent that ran it. OTACON_NO_BROWSER
// suppresses the launch and prints the URL as one JSON line instead. That is the
// seam headless hosts (CI, the e2e scripts) and any agent that wants to parse the
// URL use to get the old print-only behavior back.

import { spawn } from "node:child_process";
import { notice, printJson } from "./output.js";

/** The platform's "open this URL with the default app" command + args. */
function opener(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      // `start` is a cmd builtin; the empty "" is its window-title argument, so a
      // URL carrying spaces/`&` isn't swallowed as the title instead of the URL.
      return { command: "cmd", args: ["/c", "start", "", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/** Fire the default browser at `url`, detached; never throws (see header). */
export function openInBrowser(url: string): void {
  const { command, args } = opener(url);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // Without a listener an ENOENT (no opener on PATH) would surface as an
    // uncaught error event; swallow it. The stderr notice still carries the URL.
    child.on("error", () => {});
    child.unref();
  } catch {
    // spawn can also throw synchronously; the URL is still in the notice.
  }
}

/**
 * Deliver a URL the way `open`/`config` do: launch the browser and print a stderr
 * notice carrying the link (a clickable fallback when the launch is a no-op).
 * Under OTACON_NO_BROWSER it falls back to the print-only contract (one JSON line
 * on stdout) for headless hosts, the e2e scripts, and URL-parsing agents.
 */
export function openOrPrint(url: string, payload: Record<string, unknown>): void {
  if (process.env.OTACON_NO_BROWSER) {
    printJson(payload);
    return;
  }
  notice(`opening ${url}`);
  openInBrowser(url);
}
