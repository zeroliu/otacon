// otacon answer <question-id> (--body "…" | --file f.md) [--session id] — the
// agent's reply to a user question (DESIGN.md §6, §9): the answer lands on the
// question's thread, the plan and status stay untouched, and the agent goes
// back to `otacon wait`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { api, ensureDaemon } from "../client.js";
import { fail, printJson, usageError } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";

export async function answerCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      body: { type: "string" },
      file: { type: "string" },
      session: { type: "string" },
    },
    allowPositionals: true,
  });
  const questionId = positionals[0];
  if (questionId === undefined || positionals.length > 1) {
    usageError("otacon answer takes exactly one <question-id>");
  }
  if ((values.body === undefined) === (values.file === undefined)) {
    usageError("otacon answer requires exactly one of --body or --file");
  }
  let body: string;
  if (values.body !== undefined) {
    body = values.body;
  } else {
    const path = resolve(values.file as string);
    try {
      body = readFileSync(path, "utf8");
    } catch {
      fail("E_NO_FILE", `cannot read answer file ${path}`);
    }
  }
  if (body.trim() === "") usageError("the answer body must be non-empty");

  await ensureDaemon();
  const session = resolveSession(await listSessions(), values.session, realpathOr(process.cwd()));

  const response = await api(
    "POST",
    `/api/sessions/${session.id}/questions/${encodeURIComponent(questionId)}/answer`,
    { body },
  );
  if (response.status === 200) {
    printJson(response.body);
    return 0;
  }
  const code = (response.body.error as { code?: string } | undefined)?.code;
  if (response.status === 404 && code === "E_UNKNOWN_QUESTION") {
    fail("E_UNKNOWN_QUESTION", `session ${session.id} has no question ${questionId}`);
  }
  if (response.status === 404) {
    fail("E_UNKNOWN_SESSION", `daemon no longer knows session ${session.id}`);
  }
  if (response.status === 409) {
    const message = (response.body as { error?: { message?: string } })?.error?.message;
    fail("E_SESSION_OVER", message ?? `session ${session.id} is approved — the session is over`);
  }
  fail("E_INTERNAL", `answer failed: ${JSON.stringify(response.body)}`, undefined, 2);
}
