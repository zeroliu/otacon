// otacon open [--session id] — print the review URL (DESIGN.md §6, human
// convenience). Print, never launch: agents also run this, and stdout is the
// contract (DECISIONS.md "open prints, never launches a browser"). With no
// resolvable session the index URL is the answer, not an error — reading is
// never the wrong screen; the never-guess rule guards writes, not looks.
import { parseArgs } from "node:util";
import { baseUrl, ensureDaemon } from "../client.js";
import { CliError, notice, printJson } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";
export async function openCommand(argv) {
    const { values } = parseArgs({
        args: argv,
        options: { session: { type: "string" } },
    });
    await ensureDaemon();
    const sessions = await listSessions();
    try {
        const session = resolveSession(sessions, values.session, realpathOr(process.cwd()));
        printJson({
            ok: true,
            session: session.id,
            title: session.title,
            url: `${baseUrl()}/s/${session.id}`,
        });
    }
    catch (error) {
        // An explicit --session that fails to resolve is a real refusal; implicit
        // resolution failures (no session, ambiguity, stale pointer) degrade to
        // the index, which lists everything.
        if (!(error instanceof CliError) || values.session !== undefined)
            throw error;
        notice(`${error.message} — printing the index URL`);
        printJson({ ok: true, url: `${baseUrl()}/` });
    }
    return 0;
}
//# sourceMappingURL=open.js.map