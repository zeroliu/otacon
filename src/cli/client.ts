// HTTP client for otacond, plus ensureDaemon — the auto-spawn and version
// handshake every CLI command runs first (DESIGN.md §16).
//
// The daemon is spawned by resolved path — the dist/daemon/main.js sibling of
// this very module — never via PATH (DECISIONS.md "Daemon spawned by resolved
// file path"), detached with stdout/stderr appended to $OTACON_HOME/daemon.log.
// Instead of reading the boot line, the CLI re-probes /api/health and watches
// the child's exit code: exit 0 before health means it lost the spawn race to
// another otacond (the port is the lock — keep polling the winner); any other
// exit is a refusal or crash, surfaced with a pointer at the log (DECISIONS.md
// "Daemon spawn: health re-probe, not the boot line").

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { daemonLogPath, otaconHome, otaconPort } from "../shared/paths.js";
import { VERSION } from "../shared/version.js";
import { fail, notice } from "./output.js";

export interface DaemonHealth {
  app: string;
  version: string;
  pid: number;
}

const PROBE_TIMEOUT_MS = 1500;
const SPAWN_DEADLINE_MS = 8000;
const POLL_INTERVAL_MS = 100;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function baseUrl(): string {
  return `http://127.0.0.1:${otaconPort()}`;
}

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * JSON request/response against the daemon. A connection failure (refused,
 * reset, aborted, truncated body) throws E_DAEMON_DOWN — an actionable exit-1
 * failure per the exit-code contract, not an internal error. `otacon wait`
 * treats exactly that code as "back off and re-park".
 */
export async function api(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<ApiResponse> {
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    // Every /api response is JSON; a body that fails to parse is a connection
    // truncated mid-response and must NOT pass as an empty result — for events
    // that would print {} as the event while the daemon requeues it.
    const parsed = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("E_DAEMON_DOWN", `cannot reach otacond at ${baseUrl()}${path}: ${message}; retry`);
  }
}

type Probe = { state: "up"; health: DaemonHealth } | { state: "down" } | { state: "foreign" };

/** down = nothing answered HTTP; foreign = answered but is not otacond. */
async function probe(): Promise<Probe> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return { state: "down" };
  }
  try {
    const health = (await response.json()) as DaemonHealth;
    if (health.app === "otacond" && typeof health.version === "string") {
      return { state: "up", health };
    }
  } catch {
    // non-JSON body: not otacond
  }
  return { state: "foreign" };
}

function portConflict(): never {
  fail(
    "E_PORT_CONFLICT",
    `port ${otaconPort()} is in use by something that is not otacond; set OTACON_PORT to pick another port`,
  );
}

/** dist/daemon/main.js sibling; from a source-tree run (bun) the .ts entry. */
function daemonEntry(): string {
  const built = fileURLToPath(new URL("../daemon/main.js", import.meta.url));
  if (existsSync(built)) return built;
  // Running from src/ (e.g. `bun run src/cli/main.ts`): no built sibling, but
  // process.execPath is bun, which runs the TypeScript entry directly — this
  // is what keeps "local dev behaves identically" true (DECISIONS.md "Daemon
  // spawned by resolved file path").
  return fileURLToPath(new URL("../daemon/main.ts", import.meta.url));
}

/** Spawn the daemon detached; returns the child's exit code, undefined while alive. */
function spawnDaemon(): () => number | undefined {
  mkdirSync(otaconHome(), { recursive: true });
  const log = openSync(daemonLogPath(), "a");
  const child = spawn(process.execPath, [daemonEntry()], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log); // the child holds its own descriptor
  let exitCode: number | undefined;
  child.on("error", (error) => {
    // spawn itself failed (ENOENT/EACCES); without a listener this event
    // would crash the CLI outside the JSON-on-stdout contract.
    notice(`failed to spawn otacond: ${error.message}`);
    exitCode = 1;
  });
  child.on("exit", (code) => {
    exitCode = code ?? 1; // signal death counts as failure
  });
  return () => exitCode;
}

async function spawnAndAwaitHealth(): Promise<DaemonHealth> {
  const exitCode = spawnDaemon();
  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result.state === "up") return result.health;
    if (result.state === "foreign") portConflict();
    const code = exitCode();
    if (code !== undefined && code !== 0) {
      // Covers the non-HTTP port squatter too: the probe sees "down", the
      // spawned daemon hits EADDRINUSE, fails its own ownership check, exits 1.
      fail(
        "E_DAEMON_START",
        `otacond exited with code ${code} before becoming healthy; see ${daemonLogPath()} (if the port is taken, set OTACON_PORT)`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  fail("E_DAEMON_START", `otacond did not become healthy on ${baseUrl()}; see ${daemonLogPath()}`);
}

async function shutdownStaleDaemon(): Promise<void> {
  try {
    await api("POST", "/api/shutdown");
  } catch {
    // it may drop the connection while exiting; the down-poll below decides
  }
  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result.state === "down") return;
    // A concurrent CLI may have already respawned the current version into
    // the gap; that restart is as good as ours — without this check we would
    // poll a healthy daemon for the full deadline and fail spuriously.
    if (result.state === "up" && result.health.version === VERSION) return;
    await sleep(POLL_INTERVAL_MS);
  }
  fail("E_DAEMON_RESTART", "stale otacond did not exit after POST /api/shutdown");
}

/**
 * Health probe → spawn if down → exact-version handshake, restarting a stale
 * daemon via POST /api/shutdown (DESIGN.md §16). Refuses a port held by a
 * non-otacond process. Basic restart flow — M1i hardens the failure paths.
 */
export async function ensureDaemon(): Promise<DaemonHealth> {
  const first = await probe();
  if (first.state === "foreign") portConflict();
  if (first.state === "up") {
    if (first.health.version === VERSION) return first.health;
    notice(`restarting stale otacond ${first.health.version} → ${VERSION}`);
    await shutdownStaleDaemon();
    const after = await probe(); // a peer CLI may have respawned already
    if (after.state === "foreign") portConflict();
    if (after.state === "up" && after.health.version === VERSION) return after.health;
  }
  const health = await spawnAndAwaitHealth();
  if (health.version !== VERSION) {
    // Plausible only if an older CLI won the respawn race.
    fail(
      "E_VERSION_MISMATCH",
      `daemon on port ${otaconPort()} runs ${health.version} but this CLI is ${VERSION}; retry`,
    );
  }
  return health;
}
