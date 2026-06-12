// otacon wait [--timeout 540] [--session id] — the parked wait (DESIGN.md §6):
// long-poll the session's queue and print exactly one event as JSON, exit 0
// ({"event":"timeout"} included — re-parking is the agent's normal loop).
//
// The deadline is fixed once at entry; each iteration re-ensures the daemon
// (a cheap health probe when it is up, a respawn + handshake after a crash)
// and parks for min(remaining, 240s). A connection failure mid-park therefore
// re-parks transparently until the overall deadline — a daemon restart is
// invisible to the agent. The 240s slice stays under undici's 300s
// response-headers timeout (DECISIONS.md "wait parks in slices").

import { parseArgs } from "node:util";
import { api, ensureDaemon } from "../client.js";
import { CliError, fail, printJson, usageError } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";

const MAX_PARK_SECONDS = 240;
const RESPONSE_GRACE_MS = 10_000;
const RETRY_DELAY_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { timeout: { type: "string", default: "540" }, session: { type: "string" } },
  });
  const timeoutSeconds = Number(values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    usageError("--timeout must be a positive number of seconds");
  }

  await ensureDaemon();
  const session = resolveSession(await listSessions(), values.session, realpathOr(process.cwd()));

  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      await ensureDaemon();
      const parkSeconds = Math.min(Math.ceil(remainingMs / 1000), MAX_PARK_SECONDS);
      const response = await api(
        "GET",
        `/api/sessions/${session.id}/events?wait=${parkSeconds}`,
        undefined,
        // Guard a wedged connection; generous because the daemon owns the clock.
        AbortSignal.timeout(Math.min(remainingMs, parkSeconds * 1000) + RESPONSE_GRACE_MS),
      );
      if (response.status !== 200) {
        fail(
          "E_UNKNOWN_SESSION",
          `daemon no longer knows session ${session.id}: ${JSON.stringify(response.body)}`,
        );
      }
      if ((response.body as { event?: string }).event === "timeout") continue; // re-park
      printJson(response.body);
      return 0;
    } catch (error) {
      if (error instanceof CliError) throw error; // ensureDaemon refusals, 404s
      // Connection died (daemon killed or restarting): back off, then the loop
      // re-ensures the daemon and re-parks. Queued events survive on disk.
      await sleep(RETRY_DELAY_MS);
    }
  }
  printJson({ event: "timeout" });
  return 0;
}
