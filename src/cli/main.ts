#!/usr/bin/env node
import { VERSION } from "../shared/version.js";

const COMMANDS = ["start", "submit", "wait", "status"] as const;

// M1a stub: real command dispatch lands with the CLI phases (M1g+).
const command = process.argv[2];
const message = command
  ? `otacon ${command}: not implemented yet`
  : `usage: otacon <${COMMANDS.join("|")}> [options]`;
process.stdout.write(
  `${JSON.stringify({
    ok: false,
    error: { code: "E_NOT_IMPLEMENTED", message, version: VERSION },
  })}\n`,
);
process.exit(command ? 1 : 2);
