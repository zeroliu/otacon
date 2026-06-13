// JSON-only stdout discipline for the otacon CLI (DESIGN.md §6): every command
// prints exactly one JSON line on stdout — the machine-readable result a coding
// agent parses as its Bash tool output — and human-facing notices go to stderr.
//
// Exit codes: 0 success (including {"event":"timeout"}, DESIGN.md §6), 1
// expected failure the agent can act on (lint reject, ambiguous session, port
// conflict), 2 usage or internal error.
/** A machine-readable command failure; main.ts prints the payload and exits. */
export class CliError extends Error {
    code;
    exitCode;
    extra;
    constructor(code, message, exitCode = 1, extra = {}) {
        super(message);
        this.code = code;
        this.exitCode = exitCode;
        this.extra = extra;
        this.name = "CliError";
    }
    toPayload() {
        return { ok: false, error: { code: this.code, message: this.message, ...this.extra } };
    }
}
/** Throw an expected failure (exit 1 unless told otherwise). */
export function fail(code, message, extra, exitCode = 1) {
    throw new CliError(code, message, exitCode, extra);
}
export function usageError(message) {
    throw new CliError("E_USAGE", message, 2);
}
/** The one stdout write a command makes. */
export function printJson(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
/** Human-facing notice; never stdout, which agents parse. */
export function notice(message) {
    process.stderr.write(`otacon: ${message}\n`);
}
//# sourceMappingURL=output.js.map