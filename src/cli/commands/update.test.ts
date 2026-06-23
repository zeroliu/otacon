// otacon update [--check] — the manual/forced upgrade command. The command takes
// injected deps (fetch / runNpmUpdate / sourceRun), so every branch is driven
// with no real registry, npm, or source-run probe; we only need to capture the
// single stdout JSON line and the returned exit code. The throttle and
// update.auto bypass is structural (this command never reads either), so there
// is nothing to stub for it — the absence of those gates is the behavior.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { VERSION } from "../../shared/version.js";
import type { UpdateCommandDeps } from "./update.js";
import { updateCommand } from "./update.js";

// A version strictly newer than the installed VERSION, so isNewer fires.
const NEWER = "99.0.0";

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

const printed = () => JSON.parse(out.join("").trim()) as Record<string, unknown>;

/**
 * Build deps with sensible defaults. `npmCalls` records the dist-tag each install
 * was asked to install; `fetchTags` records the dist-tag each lookup queried.
 */
function harness(over: {
  latest?: string | undefined;
  installOk?: boolean;
  sourceRun?: boolean;
}): { deps: UpdateCommandDeps; npmCalls: string[]; fetchTags: string[] } {
  const npmCalls: string[] = [];
  const fetchTags: string[] = [];
  const deps: UpdateCommandDeps = {
    sourceRun: () => over.sourceRun ?? false,
    fetch: async (tag: string) => {
      fetchTags.push(tag);
      return "latest" in over ? over.latest : NEWER;
    },
    runNpmUpdate: (tag: string) => {
      npmCalls.push(tag);
      return { ok: over.installOk ?? true };
    },
  };
  return { deps, npmCalls, fetchTags };
}

test("--check reports outdated:true and never installs", async () => {
  const h = harness({ latest: NEWER });
  const code = await updateCommand(["--check"], h.deps);
  expect(code).toBe(0);
  expect(printed()).toEqual({ ok: true, current: VERSION, latest: NEWER, outdated: true });
  expect(h.npmCalls).toHaveLength(0);
});

test("--check reports outdated:false when current is latest, never installs", async () => {
  const h = harness({ latest: VERSION });
  const code = await updateCommand(["--check"], h.deps);
  expect(code).toBe(0);
  expect(printed()).toEqual({ ok: true, current: VERSION, latest: VERSION, outdated: false });
  expect(h.npmCalls).toHaveLength(0);
});

test("not outdated (no --check) reports updated:false and does not install", async () => {
  const h = harness({ latest: VERSION });
  const code = await updateCommand([], h.deps);
  expect(code).toBe(0);
  expect(printed()).toEqual({
    ok: true,
    current: VERSION,
    latest: VERSION,
    outdated: false,
    updated: false,
  });
  expect(h.npmCalls).toHaveLength(0);
});

test("outdated install success reports {updated, from, to}", async () => {
  const h = harness({ latest: NEWER, installOk: true });
  const code = await updateCommand([], h.deps);
  expect(code).toBe(0);
  expect(printed()).toEqual({ ok: true, updated: true, from: VERSION, to: NEWER });
  // VERSION is clean → the command queried the `latest` tag and installed `otacon@latest`.
  expect(h.fetchTags).toEqual(["latest"]);
  expect(h.npmCalls).toEqual(["latest"]);
});

test("outdated install failure → exit 1 + E_UPDATE_FAILED", async () => {
  const h = harness({ latest: NEWER, installOk: false });
  const code = await updateCommand([], h.deps);
  expect(code).toBe(1);
  expect(printed()).toEqual({
    ok: false,
    error: { code: "E_UPDATE_FAILED", message: "npm install -g otacon@latest failed" },
  });
  expect(h.npmCalls).toEqual(["latest"]);
});

test("a source checkout refuses with source:true and never installs", async () => {
  const h = harness({ sourceRun: true });
  const code = await updateCommand([], h.deps);
  expect(code).toBe(0);
  expect(printed()).toEqual({ ok: true, source: true, version: VERSION });
  expect(h.npmCalls).toHaveLength(0);
});

test("a registry blip (latest undefined) fails open: latest:null, no install", async () => {
  const h = harness({ latest: undefined });
  const code = await updateCommand([], h.deps);
  expect(code).toBe(0);
  expect(printed()).toEqual({ ok: true, current: VERSION, latest: null, outdated: false });
  expect(h.npmCalls).toHaveLength(0);
});

test("fail-open applies to --check too", async () => {
  const h = harness({ latest: undefined });
  const code = await updateCommand(["--check"], h.deps);
  expect(code).toBe(0);
  expect(printed()).toEqual({ ok: true, current: VERSION, latest: null, outdated: false });
  expect(h.npmCalls).toHaveLength(0);
});
