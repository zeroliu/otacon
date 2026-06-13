// otacon status [--all] — the crash/resume entry point (DESIGN.md §6): a
// brand-new agent session runs this to find its open session, current
// revision, and undelivered event count, then resumes the loop.
//
// Routing is registry-first (DESIGN.md §7): the daemon's registry says where
// every session's repo lives, so the default view is "sessions whose repo
// contains my cwd" — no local state needed beyond the optional
// .otacon/current-session pointer, which is only reported, never guessed from.
import { sep } from "node:path";
import { parseArgs } from "node:util";
import { otaconPort } from "../../shared/paths.js";
import { api, ensureDaemon } from "../client.js";
import { printJson } from "../output.js";
import { readPointer, realpathOr } from "../session.js";
function repoContains(repo, cwd) {
    const root = realpathOr(repo);
    return cwd === root || cwd.startsWith(root + sep);
}
export async function statusCommand(argv) {
    const { values } = parseArgs({
        args: argv,
        options: { all: { type: "boolean", default: false } },
    });
    const daemon = await ensureDaemon();
    const index = await api("GET", "/api/sessions");
    const all = (index.body.sessions ?? []);
    const cwd = realpathOr(process.cwd());
    const relevant = values.all ? all : all.filter((s) => repoContains(s.repo, cwd));
    // Detail adds revision + pendingEvents (the undelivered event count).
    const details = await Promise.all(relevant.map((s) => api("GET", `/api/sessions/${s.id}`)));
    const sessions = relevant.flatMap((session, i) => {
        const detail = details[i];
        // A session can vanish between index and detail (e.g. otacon clean);
        // skip it rather than spreading the 404 error body into the report.
        if (detail === undefined || detail.status !== 200)
            return [];
        return [{ ...detail.body, current: readPointer(session.repo) === session.id }];
    });
    printJson({
        ok: true,
        daemon: { version: daemon.version, pid: daemon.pid, port: otaconPort() },
        sessions,
    });
    return 0;
}
//# sourceMappingURL=status.js.map