// JSON-only stdout discipline for the otacon CLI (DESIGN.md §6): every command
// prints exactly one JSON line on stdout — the machine-readable result a coding
// agent parses as its Bash tool output — and human-facing notices go to stderr.
//
// Exit codes: 0 success (including {"event":"timeout"}, DESIGN.md §6), 1
// expected failure the agent can act on (lint reject, ambiguous session, port
// conflict), 2 usage or internal error.

export type ExitCode = 0 | 1 | 2;

/** A machine-readable command failure; main.ts prints the payload and exits. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: ExitCode = 1,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CliError";
  }

  toPayload(): Record<string, unknown> {
    return { ok: false, error: { code: this.code, message: this.message, ...this.extra } };
  }
}

/** Throw an expected failure (exit 1 unless told otherwise). */
export function fail(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
  exitCode: ExitCode = 1,
): never {
  throw new CliError(code, message, exitCode, extra);
}

export function usageError(message: string): never {
  throw new CliError("E_USAGE", message, 2);
}

/** The one stdout write a command makes. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Human-facing notice; never stdout, which agents parse. */
export function notice(message: string): void {
  process.stderr.write(`otacon: ${message}\n`);
}
