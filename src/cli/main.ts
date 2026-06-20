#!/usr/bin/env node
// otacon CLI dispatch (review loop and daemon API). stdout carries exactly one JSON line per
// invocation; notices go to stderr; exit 0 success / 1 expected failure /
// 2 usage or internal error (src/cli/output.ts).

import { answerCommand } from "./commands/answer.js";
import { askCommand } from "./commands/ask.js";
import { cleanCommand } from "./commands/clean.js";
import { configCommand } from "./commands/config.js";
import { doctorCommand } from "./commands/doctor.js";
import { exposeCommand } from "./commands/expose.js";
import { implementDoneCommand } from "./commands/implement-done.js";
import { installCommand } from "./commands/install.js";
import { openCommand } from "./commands/open.js";
import { progressCommand } from "./commands/progress.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { submitCommand } from "./commands/submit.js";
import { updateCommand } from "./commands/update.js";
import { waitCommand } from "./commands/wait.js";
import { CliError, printJson } from "./output.js";

const USAGE =
  "usage: otacon <start|submit|wait|ask|answer|progress|implement-done|status|open|config|clean|install|doctor|expose|update> [options]\n" +
  "       otacon config [open]      open the Settings web UI in the browser\n" +
  "       otacon config get <key>   print the merged value of one config key\n" +
  "       otacon update [--check]   update the global install to the latest published version";

async function dispatch(command: string | undefined, argv: string[]): Promise<number> {
  switch (command) {
    case "start":
      return startCommand(argv);
    case "submit":
      return submitCommand(argv);
    case "wait":
      return waitCommand(argv);
    case "ask":
      return askCommand(argv);
    case "answer":
      return answerCommand(argv);
    case "progress":
      return progressCommand(argv);
    case "implement-done":
      return implementDoneCommand(argv);
    case "status":
      return statusCommand(argv);
    case "open":
      return openCommand(argv);
    case "config":
      return configCommand(argv);
    case "clean":
      return cleanCommand(argv);
    case "install":
      return installCommand(argv);
    case "doctor":
      return doctorCommand(argv);
    case "expose":
      return exposeCommand(argv);
    case "update":
      return updateCommand(argv);
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
