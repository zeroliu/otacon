// otacon ask --question "…" [--options "A|B|C"] [--recommend A] [--multi]
// [--session id] — post a grill question card to the UI (DESIGN.md §6, §8).
// Prints the question id; the agent then parks in `otacon wait` and the
// user's answer arrives as an {"event":"answer"} on stdout there.
import { parseArgs } from "node:util";
import { api, ensureDaemon } from "../client.js";
import { fail, printJson, usageError } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";
export async function askCommand(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            question: { type: "string" },
            options: { type: "string" },
            recommend: { type: "string" },
            multi: { type: "boolean", default: false },
            session: { type: "string" },
        },
    });
    if (values.question === undefined || values.question.trim() === "") {
        usageError('otacon ask requires --question "…"');
    }
    let options;
    if (values.options !== undefined) {
        options = values.options.split("|").map((o) => o.trim());
        if (options.length < 2 || options.some((o) => o === "") || new Set(options).size !== options.length) {
            usageError('--options must be 2+ distinct choices separated by "|" (e.g. "A|B|C")');
        }
    }
    if (values.recommend !== undefined && !options?.includes(values.recommend)) {
        usageError("--recommend must name one of the --options choices");
    }
    if (values.multi === true && options === undefined) {
        usageError("--multi requires --options");
    }
    await ensureDaemon();
    const session = resolveSession(await listSessions(), values.session, realpathOr(process.cwd()));
    const response = await api("POST", `/api/sessions/${session.id}/ask`, {
        question: values.question,
        options,
        recommend: values.recommend,
        multi: values.multi === true ? true : undefined,
    });
    if (response.status === 201) {
        printJson(response.body); // {ok, session, id: "q<n>"} — now park in `otacon wait`
        return 0;
    }
    const code = response.body.error?.code;
    const message = response.body.error?.message;
    if (response.status === 409) {
        fail(code ?? "E_SESSION_OVER", message ?? `session ${session.id} is over`);
    }
    if (response.status === 404) {
        fail("E_UNKNOWN_SESSION", `daemon no longer knows session ${session.id}`);
    }
    if (response.status === 400) {
        fail("E_BAD_REQUEST", message ?? "daemon rejected the question");
    }
    fail("E_INTERNAL", `ask failed: ${JSON.stringify(response.body)}`, undefined, 2);
}
//# sourceMappingURL=ask.js.map