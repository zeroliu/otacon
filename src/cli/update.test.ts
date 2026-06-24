import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateCachePath } from "../shared/paths.js";
import {
  type AutoUpdateDeps,
  channelOf,
  fetchDistTag,
  isNewer,
  maybeAutoUpdate,
  runNpmUpdate,
  type UpdateCache,
  updateCheckDue,
} from "./update.js";

describe("channelOf", () => {
  test("a -staging. prerelease tracks the staging channel", () => {
    expect(channelOf("0.1.4-staging.2")).toBe("staging");
    expect(channelOf("v0.1.4-staging.0")).toBe("staging");
    expect(channelOf("1.0.0-staging.99")).toBe("staging");
  });

  test("a clean version tracks latest", () => {
    expect(channelOf("0.1.4")).toBe("latest");
    expect(channelOf("v0.1.4")).toBe("latest");
    expect(channelOf("1.0.0")).toBe("latest");
  });

  test("a non-staging prerelease tracks latest (binary split)", () => {
    expect(channelOf("0.1.4-beta.1")).toBe("latest");
    expect(channelOf("0.1.4-rc.0")).toBe("latest");
    // `-staging` with no `.N` is not the staging shape we cut → latest.
    expect(channelOf("0.1.4-staging")).toBe("latest");
  });

  test("malformed input is latest, never throws", () => {
    expect(channelOf("")).toBe("latest");
    expect(channelOf("garbage")).toBe("latest");
    expect(channelOf(undefined as unknown as string)).toBe("latest");
  });
});

describe("isNewer", () => {
  test("a strictly greater patch is newer", () => {
    expect(isNewer("0.1.2", "0.1.1")).toBe(true);
    expect(isNewer("0.1.1", "0.1.2")).toBe(false);
  });

  test("equal versions are not newer", () => {
    expect(isNewer("0.1.1", "0.1.1")).toBe(false);
  });

  test("an older version is not newer", () => {
    expect(isNewer("0.1.0", "0.2.5")).toBe(false);
  });

  test("minor outranks patch (0.2.0 > 0.1.9)", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
  });

  test("major outranks minor and patch (1.0.0 > 0.9.9)", () => {
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  });

  test("a leading v and a prerelease suffix are tolerated", () => {
    expect(isNewer("v0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.2.0-beta.1", "0.1.0")).toBe(true);
  });

  test("a malformed version on either side is never newer", () => {
    expect(isNewer("garbage", "0.1.1")).toBe(false);
    expect(isNewer("0.1.2", "nope")).toBe(false);
    expect(isNewer("0.1", "0.1.1")).toBe(false);
    expect(isNewer("0.1.2.3", "0.1.1")).toBe(false);
    expect(isNewer("", "0.1.1")).toBe(false);
  });

  // Prerelease-aware ordering (Phase 2). The stable-path cases above must be
  // unaffected; these add the staging cases.
  test("two clean versions order exactly as the core triple (regression guard)", () => {
    // The full set of stable cases must match the pre-Phase-2 core-only behavior.
    expect(isNewer("0.1.4", "0.1.3")).toBe(true);
    expect(isNewer("0.1.3", "0.1.4")).toBe(false);
    expect(isNewer("0.1.4", "0.1.4")).toBe(false);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
  });

  test("two -staging.N at the same core order by their numeric N", () => {
    expect(isNewer("0.1.4-staging.7", "0.1.4-staging.3")).toBe(true);
    expect(isNewer("0.1.4-staging.3", "0.1.4-staging.7")).toBe(false);
    expect(isNewer("0.1.4-staging.7", "0.1.4-staging.7")).toBe(false);
    // Numeric, not lexicographic: 10 > 9.
    expect(isNewer("0.1.4-staging.10", "0.1.4-staging.9")).toBe(true);
  });

  test("a clean version outranks a staging build at the same core", () => {
    expect(isNewer("0.1.4", "0.1.4-staging.7")).toBe(true);
    expect(isNewer("0.1.4", "0.1.4-staging.0")).toBe(true);
  });

  test("a staging build never outranks the clean release at the same core", () => {
    // A stable user must never be offered a -staging build at the same core.
    expect(isNewer("0.1.4-staging.7", "0.1.4")).toBe(false);
    expect(isNewer("0.1.4-staging.99", "0.1.4")).toBe(false);
  });

  test("a higher core wins regardless of prerelease on either side", () => {
    expect(isNewer("0.2.0-staging.0", "0.1.9-staging.4")).toBe(true);
    expect(isNewer("0.2.0", "0.1.9-staging.4")).toBe(true);
    expect(isNewer("0.2.0-staging.0", "0.1.9")).toBe(true);
    // and a lower core never wins
    expect(isNewer("0.1.9-staging.4", "0.2.0-staging.0")).toBe(false);
  });
});

describe("updateCheckDue", () => {
  const now = 10_000_000_000;
  const hour = 3_600_000;

  test("a fresh check (10 min ago) is not due", () => {
    expect(updateCheckDue({ checkedAt: now - 10 * 60_000 }, now)).toBe(false);
  });

  test("a stale check (2h ago) is due", () => {
    expect(updateCheckDue({ checkedAt: now - 2 * hour }, now)).toBe(true);
  });

  test("an absent cache is due", () => {
    expect(updateCheckDue(undefined, now)).toBe(true);
  });

  test("exactly the window boundary is due (>=)", () => {
    expect(updateCheckDue({ checkedAt: now - hour }, now)).toBe(true);
    expect(updateCheckDue({ checkedAt: now - hour + 1 }, now)).toBe(false);
  });

  test("a malformed checkedAt is treated as due", () => {
    expect(updateCheckDue({ checkedAt: Number.NaN }, now)).toBe(true);
    expect(updateCheckDue({ checkedAt: "soon" } as unknown as UpdateCache, now)).toBe(true);
  });

  test("a custom window is honored", () => {
    expect(updateCheckDue({ checkedAt: now - 90_000 }, now, 60_000)).toBe(true);
    expect(updateCheckDue({ checkedAt: now - 30_000 }, now, 60_000)).toBe(false);
  });
});

describe("fetchDistTag", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(impl: () => Promise<Response>): void {
    globalThis.fetch = (() => impl()) as unknown as typeof fetch;
  }

  test("builds the registry URL from the tag and returns the version", async () => {
    let seenUrl: string | undefined;
    globalThis.fetch = ((url: string) => {
      seenUrl = url;
      return Promise.resolve(new Response(JSON.stringify({ version: "0.3.0" }), { status: 200 }));
    }) as unknown as typeof fetch;
    expect(await fetchDistTag("latest")).toBe("0.3.0");
    expect(seenUrl).toBe("https://registry.npmjs.org/otacon/latest");
  });

  test("a staging tag GETs the staging dist-tag URL", async () => {
    let seenUrl: string | undefined;
    globalThis.fetch = ((url: string) => {
      seenUrl = url;
      return Promise.resolve(
        new Response(JSON.stringify({ version: "0.1.4-staging.2" }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    expect(await fetchDistTag("staging")).toBe("0.1.4-staging.2");
    expect(seenUrl).toBe("https://registry.npmjs.org/otacon/staging");
  });

  test("returns undefined on a non-200 response", async () => {
    stubFetch(async () => new Response("not found", { status: 404 }));
    expect(await fetchDistTag("latest")).toBeUndefined();
  });

  test("returns undefined when fetch rejects (network/timeout)", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });
    expect(await fetchDistTag("latest")).toBeUndefined();
  });

  test("returns undefined on a malformed JSON body", async () => {
    stubFetch(async () => new Response("{not json", { status: 200 }));
    expect(await fetchDistTag("latest")).toBeUndefined();
  });

  test("returns undefined when version is missing or empty", async () => {
    stubFetch(async () => new Response(JSON.stringify({ name: "otacon" }), { status: 200 }));
    expect(await fetchDistTag("latest")).toBeUndefined();
    stubFetch(async () => new Response(JSON.stringify({ version: "" }), { status: 200 }));
    expect(await fetchDistTag("latest")).toBeUndefined();
  });

  test("passes a provided AbortSignal through to fetch", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return Promise.resolve(new Response(JSON.stringify({ version: "0.4.0" }), { status: 200 }));
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    expect(await fetchDistTag("latest", controller.signal)).toBe("0.4.0");
    expect(seen).toBe(controller.signal);
  });
});

describe("runNpmUpdate", () => {
  type Spawn = typeof spawnSync;

  test("runs `npm install -g otacon@latest` with inherited stdio", () => {
    const calls: { cmd: string; args: string[]; opts?: { stdio?: unknown } }[] = [];
    const spawn = ((cmd: string, args: string[], opts?: { stdio?: unknown }) => {
      calls.push({ cmd, args, opts });
      return { status: 0, error: undefined };
    }) as unknown as Spawn;
    expect(runNpmUpdate("latest", spawn).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: "npm", args: ["install", "-g", "otacon@latest"] });
    expect(calls[0]?.opts?.stdio).toBe("inherit");
  });

  test("a staging tag installs `otacon@staging`", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 0, error: undefined };
    }) as unknown as Spawn;
    expect(runNpmUpdate("staging", spawn).ok).toBe(true);
    expect(calls[0]).toMatchObject({ cmd: "npm", args: ["install", "-g", "otacon@staging"] });
  });

  test("a non-zero exit status is ok:false", () => {
    const spawn = (() => ({ status: 1, error: undefined })) as unknown as Spawn;
    expect(runNpmUpdate("latest", spawn).ok).toBe(false);
  });

  test("a spawn error (ENOENT, npm missing) is ok:false", () => {
    const spawn = (() => ({
      status: null,
      error: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }),
    })) as unknown as Spawn;
    expect(runNpmUpdate("latest", spawn).ok).toBe(false);
  });
});

describe("maybeAutoUpdate", () => {
  // A version strictly newer than the installed version, so isNewer fires.
  const NEWER = "99.0.0";
  // The pinned, clean installed version the tests inject, decoupled from the
  // module VERSION so a staging release (which builds a `-staging.` VERSION)
  // can't flip the derived channel out from under these assertions.
  const INSTALLED = "0.1.0";
  let home: string;
  const savedHome = process.env.OTACON_HOME;
  const savedUpdated = process.env.OTACON_UPDATED;

  // Records of what the seams were asked to do.
  type SpawnCall = { cmd: string; args: string[]; env?: NodeJS.ProcessEnv };

  interface Harness {
    deps: AutoUpdateDeps;
    spawnCalls: SpawnCall[];
    exitCalls: number[];
    fetchCalls: number;
    fetchTags: string[];
  }

  function harness(over: {
    latest?: string | undefined;
    installStatus?: number; // status for the `npm install` spawn
    installError?: Error; // spawn error for `npm install` (e.g. ENOENT)
    sourceRun?: boolean;
    installedVersion?: string;
  }): Harness {
    const spawnCalls: SpawnCall[] = [];
    const exitCalls: number[] = [];
    const fetchTags: string[] = [];
    let fetchCalls = 0;
    const deps: AutoUpdateDeps = {
      sourceRun: () => over.sourceRun ?? false,
      installedVersion: over.installedVersion ?? INSTALLED,
      nowMs: () => 1_000_000_000,
      fetch: async (tag: string) => {
        fetchCalls++;
        fetchTags.push(tag);
        return "latest" in over ? over.latest : NEWER;
      },
      spawnSync: ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        spawnCalls.push({ cmd, args, env: opts?.env });
        // First spawn is the npm install; later spawn is the re-exec (status 0).
        const isInstall = cmd === "npm";
        if (isInstall && over.installError) return { error: over.installError, status: null };
        return { status: isInstall ? (over.installStatus ?? 0) : 0, error: undefined };
      }) as unknown as typeof spawnSync,
      exit: ((code: number) => {
        exitCalls.push(code);
        // Do NOT actually exit; throw a sentinel so the caller stops like exit would.
        throw new Error("__exit__");
      }) as (code: number) => never,
    };
    return {
      deps,
      spawnCalls,
      exitCalls,
      fetchTags,
      get fetchCalls() {
        return fetchCalls;
      },
    } as Harness;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "otacon-update-"));
    process.env.OTACON_HOME = home;
    delete process.env.OTACON_UPDATED;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.OTACON_HOME;
    else process.env.OTACON_HOME = savedHome;
    if (savedUpdated === undefined) delete process.env.OTACON_UPDATED;
    else process.env.OTACON_UPDATED = savedUpdated;
    rmSync(home, { recursive: true, force: true });
  });

  test("OTACON_UPDATED set short-circuits before any fetch", async () => {
    process.env.OTACON_UPDATED = "1";
    const h = harness({});
    await maybeAutoUpdate([], h.deps);
    expect(h.fetchCalls).toBe(0);
    expect(h.spawnCalls).toHaveLength(0);
  });

  test("a source-tree run is skipped before any fetch", async () => {
    const h = harness({ sourceRun: true });
    await maybeAutoUpdate([], h.deps);
    expect(h.fetchCalls).toBe(0);
    expect(h.spawnCalls).toHaveLength(0);
  });

  test("update.auto:false skips before any fetch", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ update: { auto: false } }));
    const h = harness({});
    await maybeAutoUpdate([], h.deps);
    expect(h.fetchCalls).toBe(0);
    expect(h.spawnCalls).toHaveLength(0);
  });

  test("a fresh throttle cache skips before any fetch", async () => {
    // checkedAt = now → within the 1h window → not due.
    writeFileSync(updateCachePath(), JSON.stringify({ checkedAt: 1_000_000_000 }));
    const h = harness({});
    await maybeAutoUpdate([], h.deps);
    expect(h.fetchCalls).toBe(0);
    expect(h.spawnCalls).toHaveLength(0);
  });

  test("the cache is stamped BEFORE the update attempt (failed update still throttles)", async () => {
    const h = harness({ installStatus: 1 });
    await maybeAutoUpdate([], h.deps);
    // npm install was attempted (and failed), but the cache was written first.
    const cache = JSON.parse(readFileSync(updateCachePath(), "utf8")) as { checkedAt: number };
    expect(cache.checkedAt).toBe(1_000_000_000);
    expect(h.spawnCalls[0]?.cmd).toBe("npm");
  });

  test("latest === undefined (fail-open) returns without spawning", async () => {
    const h = harness({ latest: undefined });
    await maybeAutoUpdate([], h.deps);
    expect(h.fetchCalls).toBe(1);
    expect(h.spawnCalls).toHaveLength(0);
  });

  test("not newer than installed returns without spawning", async () => {
    const h = harness({ latest: INSTALLED });
    await maybeAutoUpdate([], h.deps);
    expect(h.fetchCalls).toBe(1);
    expect(h.spawnCalls).toHaveLength(0);
  });

  test("newer + npm success re-execs once with start + original argv + OTACON_UPDATED", async () => {
    const h = harness({ installStatus: 0 });
    // exit() throws our sentinel — maybeAutoUpdate never returns on this path.
    await expect(maybeAutoUpdate(["--title", "x", "--quick"], h.deps)).rejects.toThrow("__exit__");

    // The installed VERSION is clean, so the gate tracks the `latest` channel:
    // it fetched the `latest` tag and installed `otacon@latest`, byte-for-byte as before.
    expect(h.fetchTags).toEqual(["latest"]);
    // exactly two spawns: the npm install, then the re-exec.
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.spawnCalls[0]).toMatchObject({
      cmd: "npm",
      args: ["install", "-g", "otacon@latest"],
    });
    const reexec = h.spawnCalls[1];
    expect(reexec?.cmd).toBe(process.execPath);
    expect(reexec?.args).toEqual([process.argv[1] ?? "", "start", "--title", "x", "--quick"]);
    expect(reexec?.env?.OTACON_UPDATED).toBe("1");
    expect(h.exitCalls).toEqual([0]);
  });

  test("a -staging. installed version tracks the staging channel (fetch + install)", async () => {
    // A staging build (e.g. what a staging release compiles VERSION into) must
    // derive the `staging` channel from the INSTALLED version, not `latest`.
    // NEWER (99.0.0) outranks 0.1.0-staging.5 so the install path fires.
    const h = harness({ installStatus: 0, installedVersion: "0.1.0-staging.5" });
    await expect(maybeAutoUpdate(["--title", "x"], h.deps)).rejects.toThrow("__exit__");

    expect(h.fetchTags).toEqual(["staging"]);
    expect(h.spawnCalls[0]).toMatchObject({
      cmd: "npm",
      args: ["install", "-g", "otacon@staging"],
    });
  });

  test("newer + npm non-zero status notices and returns (no re-exec, no exit)", async () => {
    const h = harness({ installStatus: 1 });
    await maybeAutoUpdate(["--title", "x"], h.deps);
    // only the install spawn — no re-exec.
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]?.cmd).toBe("npm");
    expect(h.exitCalls).toHaveLength(0);
  });

  test("newer + npm ENOENT (spawn error) notices and returns", async () => {
    const h = harness({ installError: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }) });
    await maybeAutoUpdate(["--title", "x"], h.deps);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.exitCalls).toHaveLength(0);
  });
});
