// otacon progress "<note>" [--session id] — narrate what you are doing
// Appends a timestamped note to the session's live activity
// feed so the review UI shows the agent at work during research and drafting,
// when no other command is firing. Non-blocking — it never parks; the agent
// calls it at checkpoints and keeps working. Prints {ok, session, note}.
//
// The note is taken from the positional argument(s) (joined) or --note; the
// daemon trims it to the configured max so long narration never fails.

import { parseArgs } from "node:util";
import { api, ensureDaemon } from "../client.js";
import { fail, printJson, usageError } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";

export async function progressCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { session: { type: "string" }, note: { type: "string" } },
    allowPositionals: true,
  });
  // The note is the positional remainder (`otacon progress reading auth`) or
  // --note; positionals win nothing if --note is given.
  const note = values.note ?? positionals.join(" ");
  if (note.trim() === "") {
    usageError('otacon progress requires a note: otacon progress "<what you are doing>"');
  }

  await ensureDaemon();
  const session = resolveSession(await listSessions(), values.session, realpathOr(process.cwd()));

  const response = await api("POST", `/api/sessions/${session.id}/progress`, { note });
  if (response.status === 200) {
    printJson(response.body);
    return 0;
  }
  const code = (response.body.error as { code?: string } | undefined)?.code;
  const message = (response.body.error as { message?: string } | undefined)?.message;
  if (response.status === 409) {
    fail(code ?? "E_SESSION_OVER", message ?? `session ${session.id} is over`);
  }
  if (response.status === 404) {
    fail("E_UNKNOWN_SESSION", `daemon no longer knows session ${session.id}`);
  }
  if (response.status === 400) {
    fail("E_BAD_REQUEST", message ?? "daemon rejected the note");
  }
  fail("E_INTERNAL", `progress failed: ${JSON.stringify(response.body)}`, undefined, 2);
}
