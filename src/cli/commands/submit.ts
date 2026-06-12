// otacon submit [plan.md] [--resolutions res.json] [--session id] — read the
// plan (default: .otacon/<session>/plan.md in the session's repo, DESIGN.md
// §4) and POST it for linting. A 422 prints the daemon's lint issues JSON and
// exits 1 so the agent fixes and resubmits (DESIGN.md §5).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { planPath } from "../../shared/paths.js";
import { api, ensureDaemon } from "../client.js";
import { fail, printJson, usageError } from "../output.js";
import { listSessions, realpathOr, resolveSession } from "../session.js";

export async function submitCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { resolutions: { type: "string" }, session: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length > 1) usageError("otacon submit takes at most one plan path");

  await ensureDaemon();
  const session = resolveSession(await listSessions(), values.session, realpathOr(process.cwd()));

  const path =
    positionals[0] !== undefined ? resolve(positionals[0]) : planPath(session.repo, session.id);
  let plan: string;
  try {
    plan = readFileSync(path, "utf8");
  } catch {
    fail("E_NO_PLAN", `cannot read plan file ${path}; write the plan there or pass its path`);
  }

  let resolutions: unknown;
  if (values.resolutions !== undefined) {
    try {
      resolutions = JSON.parse(readFileSync(resolve(values.resolutions), "utf8")) as unknown;
    } catch {
      fail("E_BAD_RESOLUTIONS", `cannot read ${values.resolutions} as JSON`);
    }
  }

  const response = await api("POST", `/api/sessions/${session.id}/submit`, { plan, resolutions });
  if (response.status === 200 || response.status === 422) {
    // 200: {ok,session,revision,status,warnings}. 422: {ok:false,errors,warnings}.
    printJson(response.body);
    return response.status === 200 ? 0 : 1;
  }
  fail("E_INTERNAL", `submit failed: ${JSON.stringify(response.body)}`, undefined, 2);
}
