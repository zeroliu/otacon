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
import { api, ensureDaemon, sleep } from "../client.js";
import { CliError, fail, printJson, usageError } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";
const MAX_PARK_SECONDS = 240;
const RESPONSE_GRACE_MS = 10_000;
const RETRY_DELAY_MS = 250;
export async function waitCommand(argv) {
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
        if (remainingMs <= 0)
            break;
        try {
            await ensureDaemon();
            const parkSeconds = Math.min(Math.ceil(remainingMs / 1000), MAX_PARK_SECONDS);
            const response = await api("GET", `/api/sessions/${session.id}/events?wait=${parkSeconds}`, undefined, 
            // Guard a wedged connection; generous because the daemon owns the clock.
            AbortSignal.timeout(Math.min(remainingMs, parkSeconds * 1000) + RESPONSE_GRACE_MS));
            if (response.status === 404) {
                fail("E_UNKNOWN_SESSION", `daemon no longer knows session ${session.id}: ${JSON.stringify(response.body)}`);
            }
            if (response.status !== 200) {
                // A daemon 500 is not "unknown session" — surface it as what it is.
                fail("E_INTERNAL", `wait failed: ${JSON.stringify(response.body)}`, undefined, 2);
            }
            if (response.body.event === "timeout")
                continue; // re-park
            printJson(response.body);
            return 0;
        }
        catch (error) {
            // Only a dead/wedged connection (daemon killed or restarting) is
            // retryable: back off, then the loop re-ensures the daemon and re-parks
            // (queued events survive on disk). Everything else — ensureDaemon
            // refusals, 404s, programming errors — propagates instead of being
            // silently retried until the deadline.
            if (!(error instanceof CliError) || error.code !== "E_DAEMON_DOWN")
                throw error;
            await sleep(RETRY_DELAY_MS);
        }
    }
    printJson({ event: "timeout" });
    return 0;
}
//# sourceMappingURL=wait.js.map