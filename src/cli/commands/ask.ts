// otacon ask --question "…" [--options "A|B|C"] [--recommend A] [--multi]
// [--session id] — post a grill question card to the UI.
// Prints the question id; the agent then parks in `otacon wait` and the
// user's answer arrives as an {"event":"answer"} on stdout there.
//
// `--batch <file|->` posts several INDEPENDENT questions in one call (a JSON
// array of the same specs): the daemon mints them atomically and they render
// as ordinary cards, each answered instantly. Dependency-first grilling still
// holds — only independent siblings batch (interview questions).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type QuestionSpec, parseQuestionSpec } from "../../shared/question-spec.js";
import { api, ensureDaemon } from "../client.js";
import { fail, printJson, usageError } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";

/**
 * Hold one question body to the shared validator — the same
 * rules the daemon re-checks — turning its error string into a usage error
 * (E_USAGE, exit 2) carrying the caller's context: a `--batch[i] ` index, or
 * "" for the bare flag form.
 */
function specOrUsage(raw: unknown, where: string): QuestionSpec {
  const spec = parseQuestionSpec(raw);
  if (typeof spec === "string") usageError(`${where}${spec}`);
  return spec;
}

/**
 * Parse and validate a --batch payload: a non-empty JSON array of question
 * specs. Throws a usage error on a malformed array or member (naming its
 * index) so the agent fixes its file before the daemon sees it; the daemon
 * re-validates and mints the whole batch atomically (a bad member fails it
 * all — no partial queue).
 */
export function parseBatch(content: string): QuestionSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    usageError("--batch must be a JSON array of question objects");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    usageError("--batch must be a non-empty JSON array of question objects");
  }
  return parsed.map((raw, i) => specOrUsage(raw, `--batch[${i}] `));
}

export async function askCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      question: { type: "string" },
      options: { type: "string" },
      recommend: { type: "string" },
      multi: { type: "boolean", default: false },
      session: { type: "string" },
      batch: { type: "string" },
    },
  });

  let payload: Record<string, unknown>;
  if (values.batch !== undefined) {
    if (
      values.question !== undefined ||
      values.options !== undefined ||
      values.recommend !== undefined ||
      values.multi === true
    ) {
      usageError("--batch is exclusive with --question/--options/--recommend/--multi");
    }
    let content: string;
    try {
      content = readFileSync(values.batch === "-" ? 0 : resolve(values.batch), "utf8");
    } catch {
      fail("E_NO_BATCH", `cannot read --batch ${values.batch}; write the questions there or pass -`);
    }
    payload = { questions: parseBatch(content) };
  } else {
    if (values.question === undefined || values.question.trim() === "") {
      usageError('otacon ask requires --question "…" (or --batch <file|->)');
    }
    // Assemble the same spec a --batch member is, then hold it to the one shared
    // validator — the only flag-specific bit is splitting --options on "|".
    payload = {
      ...specOrUsage(
        {
          question: values.question,
          ...(values.options !== undefined
            ? { options: values.options.split("|").map((o) => o.trim()) }
            : {}),
          ...(values.recommend !== undefined ? { recommend: values.recommend } : {}),
          ...(values.multi === true ? { multi: true } : {}),
        },
        "",
      ),
    };
  }

  await ensureDaemon();
  const session = resolveSession(await listSessions(), values.session, realpathOr(process.cwd()));

  const response = await api("POST", `/api/sessions/${session.id}/ask`, payload);
  if (response.status === 201) {
    // single: {ok, session, id: "q<n>"}; batch: {ok, session, ids: [...]} —
    // now park in `otacon wait`, looping it to drain a batch.
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
    fail("E_BAD_REQUEST", message ?? "daemon rejected the question");
  }
  fail("E_INTERNAL", `ask failed: ${JSON.stringify(response.body)}`, undefined, 2);
}
