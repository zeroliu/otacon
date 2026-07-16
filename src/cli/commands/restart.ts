// otacon restart — explicitly replace the daemon on the configured port with
// one spawned from this installed/source CLI, then report the fresh identity.

import { parseArgs } from "node:util";
import { otaconPort } from "../../shared/paths.js";
import { restartDaemon } from "../client.js";
import type { RestartResult } from "../client.js";
import { printJson } from "../output.js";

export interface RestartCommandDeps {
  restart: () => Promise<RestartResult>;
}

const REAL_DEPS: RestartCommandDeps = { restart: restartDaemon };

export async function restartCommand(
  argv: string[],
  deps: RestartCommandDeps = REAL_DEPS,
): Promise<number> {
  parseArgs({ args: argv, options: {}, allowPositionals: false });
  const result = await deps.restart();
  printJson({
    ok: true,
    restarted: result.restarted,
    ...(result.previous
      ? { previous: { version: result.previous.version, pid: result.previous.pid } }
      : {}),
    daemon: {
      version: result.daemon.version,
      pid: result.daemon.pid,
      port: otaconPort(),
    },
  });
  return 0;
}
