import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DaemonHealth, RestartResult } from "../client.js";
import type { RestartCommandDeps } from "./restart.js";
import { restartCommand } from "./restart.js";

let out: string[];
let writeSpy: typeof process.stdout.write;

beforeEach(() => {
  out = [];
  writeSpy = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = writeSpy;
});

const health = (pid: number): DaemonHealth => ({
  app: "otacond",
  version: "1.2.3",
  pid,
  viewers: 0,
});

const run = async (result: RestartResult): Promise<Record<string, unknown>> => {
  const deps: RestartCommandDeps = { restart: async () => result };
  expect(await restartCommand([], deps)).toBe(0);
  return JSON.parse(out.join("").trim()) as Record<string, unknown>;
};

test("reports the replaced daemon and its fresh PID", async () => {
  expect(await run({ restarted: true, previous: health(41), daemon: health(42) })).toEqual({
    ok: true,
    restarted: true,
    previous: { version: "1.2.3", pid: 41 },
    daemon: { version: "1.2.3", pid: 42, port: 4747 },
  });
});

test("starts the daemon when none was running", async () => {
  expect(await run({ restarted: false, daemon: health(42) })).toEqual({
    ok: true,
    restarted: false,
    daemon: { version: "1.2.3", pid: 42, port: 4747 },
  });
});
