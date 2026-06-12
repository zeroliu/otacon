#!/usr/bin/env node
// otacon CLI dispatch (DESIGN.md §6). stdout carries exactly one JSON line per
// invocation; notices go to stderr; exit 0 success / 1 expected failure /
// 2 usage or internal error (src/cli/output.ts).

import { statusCommand } from "./commands/status.js";
import { CliError, printJson } from "./output.js";

const USAGE = "usage: otacon <start|submit|wait|status> [options]";

async function dispatch(command: string | undefined, argv: string[]): Promise<number> {
  switch (command) {
    case "status":
      return statusCommand(argv);
    case "start":
    case "submit":
    case "wait":
      throw new CliError("E_NOT_IMPLEMENTED", `otacon ${command} lands with M1h`, 1);
    default:
      throw new CliError("E_USAGE", USAGE, 2);
  }
}

const isParseArgsError = (error: unknown): error is Error =>
  error instanceof Error &&
  ((error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS") ?? false);

/** Exit only after queued stdout writes flush (stdout may be a pipe). */
function exit(code: number): void {
  process.stdout.write("", () => process.exit(code));
}

dispatch(process.argv[2], process.argv.slice(3)).then(
  (code) => exit(code),
  (error: unknown) => {
    if (error instanceof CliError) {
      printJson(error.toPayload());
      exit(error.exitCode);
    } else if (isParseArgsError(error)) {
      printJson({ ok: false, error: { code: "E_USAGE", message: `${error.message}; ${USAGE}` } });
      exit(2);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      printJson({ ok: false, error: { code: "E_INTERNAL", message } });
      exit(2);
    }
  },
);
