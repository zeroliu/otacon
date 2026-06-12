// The REAL built CLI, runnable from UI e2e specs (not collected as a spec —
// playwright.config.ts matches only *.e2e.ts). The CLI only touches its home
// when it has to spawn a daemon (it never should here — the webServer daemon
// is up); a temp home keeps a failure from ever spilling into ~/.otacon.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "..", "dist", "cli", "main.js");
const port = Number(process.env.OTACON_E2E_PORT ?? "4790");
const cliHome = mkdtempSync(join(tmpdir(), "otacon-ui-e2e-cli-"));

// A test that fails between spawning a parked `otacon wait` and awaiting it
// would otherwise orphan the child to long-poll the daemon for up to 30s past
// the failure; specs register reapCli in test.afterEach.
const liveChildren = new Set<ChildProcess>();

export function reapCli(): void {
  for (const child of liveChildren) child.kill("SIGKILL");
  liveChildren.clear();
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real built CLI against the e2e daemon; resolves on exit. */
export function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        OTACON_PORT: String(port),
        OTACON_HOME: cliHome,
        NO_PROXY: "127.0.0.1,localhost",
      },
    });
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      liveChildren.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      liveChildren.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}
