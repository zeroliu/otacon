// `otacon start`'s auto-update gate (install/update). The top of this file is the
// pure, side-effect-free decision core (Phase 1); `maybeAutoUpdate` at the
// bottom wires the side effects (Phase 2): the npm update and the re-exec.
//
// Decisions that shape the code:
//   - D3: the whole check is throttled to once per hour via the
//     `update-check.json` cache (`updateCheckDue`).
//   - D5: the registry version is discovered by GET
//     registry.npmjs.org/otacon/<tag> with a short timeout, fail-open on ANY
//     error (`fetchDistTag` → undefined).
//   - D6: a source-tree run (the `.ts` daemon entry signal, `isSourceRun`) is
//     skipped — there is no global npm package to update from a checkout.
//   - D7: update with `npm install -g otacon@<channel>`; on any failure notify the
//     manual command and proceed on the installed version — never sudo.
//   - D8: `OTACON_UPDATED=1` guards the re-exec'd child against a second check.
//   - Channel: the update channel is derived purely from the installed VERSION's
//     suffix (`channelOf`): a `-staging.` build tracks the `staging` dist-tag and
//     stays on staging, anything else tracks `latest`. No new config or state.

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../shared/config.js";
import { otaconHome, updateCachePath } from "../shared/paths.js";
import { VERSION } from "../shared/version.js";
import { isSourceRun } from "./client.js";
import { notice } from "./output.js";
import { findRepoRoot, realpathOr } from "./session.js";

/**
 * The npm dist-tag a given installed version tracks. A `-staging.` prerelease
 * build follows the `staging` channel (so staging→staging, never pulled back to
 * stable); anything else (a clean `vX.Y.Z`, any other suffix, or malformed
 * input) follows `latest`. Derived purely from the version string (no config or
 * state) and never throws. Intentionally a binary staging/latest split (not a
 * general preid lookup); see DECISIONS.md.
 */
export function channelOf(version: string): "staging" | "latest" {
  return typeof version === "string" && /-staging\./.test(version) ? "staging" : "latest";
}

/**
 * True iff `latest` is a strictly greater semver than `current`. Compares the
 * major.minor.patch triple numerically first (a leading `v` ignored). When the
 * cores are equal it is prerelease-aware: a version with NO prerelease ranks
 * above one WITH a prerelease (so stable `0.1.4` > `0.1.4-staging.9`), and two
 * `-staging.N` prereleases compare by their numeric `N` (so `0.1.4-staging.7` >
 * `0.1.4-staging.3`). A malformed input on either side returns false (never
 * throws), so a garbled registry answer can never trigger an update. For two
 * clean versions the result is identical to the core-triple-only comparison.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < 3; i++) {
    const [ai, bi] = [a.core[i] ?? 0, b.core[i] ?? 0];
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  // Equal cores: rank the prerelease component. A clean build (pre === undefined)
  // outranks any staging build; two staging builds order by their numeric N.
  if (a.pre === b.pre) return false;
  if (a.pre === undefined) return true; // clean latest > staging current
  if (b.pre === undefined) return false; // staging latest is NOT newer than clean current
  return a.pre > b.pre; // both staging: higher N is newer
}

/**
 * A parsed version: the numeric `core` triple plus the optional `staging`
 * prerelease counter (`pre`, the `N` in `-staging.N`). `pre` is `undefined` for
 * a clean version and for any non-staging suffix, so a clean build always
 * outranks a staging one at the same core.
 */
interface ParsedSemver {
  core: [number, number, number];
  pre: number | undefined;
}

/** Parse `x.y.z[-staging.N]` (optional leading `v`, `+build` ignored) into a core triple + optional staging `N`. */
function parseSemver(version: string): ParsedSemver | undefined {
  if (typeof version !== "string") return undefined;
  const trimmed = version.trim().replace(/^v/, "");
  const core = trimmed.split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  if (parts.length !== 3) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    nums.push(Number(part));
  }
  const staging = /-staging\.(\d+)/.exec(trimmed);
  return {
    core: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0],
    pre: staging ? Number(staging[1]) : undefined,
  };
}

/** The persisted update-check cache (`$OTACON_HOME/update-check.json`): when we last checked. */
export interface UpdateCache {
  checkedAt: number;
}

/**
 * The 1h throttle (D3): returns true when a fresh check is due — i.e. there is
 * no valid cache, or `nowMs - cache.checkedAt >= windowMs`. A malformed or
 * absent cache (or a non-finite `checkedAt`) counts as due, so a corrupt cache
 * file never wedges the check off.
 */
export function updateCheckDue(
  cache: UpdateCache | undefined,
  nowMs: number,
  windowMs = 3_600_000,
): boolean {
  if (cache === undefined || typeof cache.checkedAt !== "number" || !Number.isFinite(cache.checkedAt)) {
    return true;
  }
  return nowMs - cache.checkedAt >= windowMs;
}

/**
 * GET registry.npmjs.org/otacon/<tag> and return its `.version` (D5), where
 * `tag` is the channel dist-tag (`latest` or `staging`). On ANY error (network
 * failure, non-200, bad JSON, missing/empty version, or the timeout) resolves
 * to `undefined` so the caller fails open and proceeds on the current version.
 * Never throws. Defaults to a 1.5s timeout when no `signal` is supplied.
 */
export async function fetchDistTag(tag: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(`https://registry.npmjs.org/otacon/${tag}`, {
      signal: signal ?? AbortSignal.timeout(1500),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version.length > 0 ? body.version : undefined;
  } catch {
    return undefined;
  }
}

/** Read+parse the throttle cache; a missing/corrupt file is `undefined` (= due). */
function readCache(): UpdateCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(updateCachePath(), "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && "checkedAt" in parsed) {
      return parsed as UpdateCache;
    }
  } catch {
    // missing or malformed → treated as due by updateCheckDue(undefined, …)
  }
  return undefined;
}

/** Persist `checkedAt: now` BEFORE attempting the update, so a failed update still throttles. */
function writeCache(nowMs: number): void {
  try {
    mkdirSync(otaconHome(), { recursive: true });
    writeFileSync(updateCachePath(), `${JSON.stringify({ checkedAt: nowMs })}\n`);
  } catch {
    // a cache we can't write just means the next start re-checks; never fatal
  }
}

/**
 * Run `npm install -g otacon@<tag>` (D7), the one mutating side effect shared by
 * the auto-update gate (`maybeAutoUpdate`) and the standalone `otacon update`
 * command. `tag` is the channel dist-tag (`latest` or `staging`), so a staging
 * install stays on staging and a clean install resolves `otacon@latest` exactly
 * as before. stdio is inherited so npm's own progress reaches the human's stderr.
 * Returns `{ ok }`: false on a non-zero exit (a non-writable global dir, an npm
 * error) OR a spawn error (`ENOENT` when npm is missing) — never throws, and
 * never escalates to sudo (D1). `spawnSync` is injectable so tests drive both
 * outcomes with no real npm.
 */
export function runNpmUpdate(
  tag: string,
  spawnSync: typeof nodeSpawnSync = nodeSpawnSync,
): { ok: boolean } {
  const install = spawnSync("npm", ["install", "-g", `otacon@${tag}`], {
    stdio: "inherit",
  });
  return { ok: install.error === undefined && install.status === 0 };
}

/**
 * Seams for `maybeAutoUpdate` so tests drive every branch without a real
 * registry, npm, or process exit. Defaults wire the real implementations; a
 * test passes stubs. `spawnSync` runs the npm install and the re-exec; `exit`
 * ends the parent after a successful re-exec (so maybeAutoUpdate never returns
 * on that path). `nowMs`/`fetch` mirror the pure helpers' injectable shape;
 * `fetch` receives the channel dist-tag to look up.
 */
export interface AutoUpdateDeps {
  fetch: typeof fetchDistTag;
  spawnSync: typeof nodeSpawnSync;
  exit: (code: number) => never;
  nowMs: () => number;
  sourceRun: () => boolean;
}

const REAL_DEPS: AutoUpdateDeps = {
  fetch: fetchDistTag,
  spawnSync: nodeSpawnSync,
  exit: (code) => process.exit(code),
  nowMs: () => Date.now(),
  sourceRun: isSourceRun,
};

/**
 * The pre-session auto-update gate, called as the very first thing in
 * `otacon start` (install/update). Guards in order — each early return means
 * "proceed on the installed version" (the no-op path):
 *
 *   1. loop guard   — `OTACON_UPDATED` set → the re-exec'd child, don't re-check (D8)
 *   2. dev-run skip — a source checkout has no global package to update (D6)
 *   3. config gate  — `update.auto:false` pins the version (D4)
 *   4. throttle     — checked within the hour → skip; else stamp the cache now (D3)
 *   5. fetch+compare— the channel's registry version (fail-open) must be strictly newer (D5)
 *   6. update       — `npm install -g otacon@<channel>`; on success notice + re-exec
 *                     `start <argv>` with OTACON_UPDATED=1 and exit the parent;
 *                     on ANY failure notice the manual command and return (D1/D7)
 *
 * The channel is derived from the installed VERSION (`channelOf`): a `-staging.`
 * build tracks the `staging` dist-tag (staging stays on staging, never pulled to
 * stable), anything else tracks `latest`, identical to the prior behavior for a
 * clean install.
 *
 * On the successful-update path this NEVER returns: it re-execs and exits with
 * the child's status. The child runs the new CLI, mints the session, and (via
 * the version handshake in ensureDaemon) restarts the stale daemon — no extra
 * restart code (D9).
 */
export async function maybeAutoUpdate(
  argv: string[],
  deps: AutoUpdateDeps = REAL_DEPS,
): Promise<void> {
  // 1. Loop guard (D8): the re-exec'd child must not check again.
  if (process.env.OTACON_UPDATED) return;

  // 2. Dev-run skip (D6): a source checkout has no global npm package.
  if (deps.sourceRun()) return;

  // 3. Config gate (D4): honor project config the same way start.ts resolves the repo.
  const cwd = realpathOr(process.cwd());
  const repo = findRepoRoot(cwd) ?? cwd;
  if (loadConfig(repo).update.auto === false) return;

  // 4. Throttle (D3): stamp the cache BEFORE attempting the update so a failed
  // attempt still throttles the next hour (no npm hammering on a flaky network).
  const now = deps.nowMs();
  if (!updateCheckDue(readCache(), now)) return;
  writeCache(now);

  // 5. Fetch + compare (D5): look up the installed version's channel dist-tag,
  // fail-open on no answer; only act if strictly newer.
  const channel = channelOf(VERSION);
  const latest = await deps.fetch(channel);
  if (latest === undefined) return;
  if (!isNewer(latest, VERSION)) return;

  // 6. Update (D7): npm install -g via the shared helper; fail-open on any error.
  if (!runNpmUpdate(channel, deps.spawnSync).ok) {
    // ENOENT (npm missing), non-zero exit, or a non-writable global dir — never
    // escalate to sudo (D1). Notify the manual command and proceed on current.
    notice(
      `a newer otacon ${latest} is available but auto-update failed; run: npm install -g otacon@${channel}`,
    );
    return;
  }

  // Success: re-exec the same `start` invocation on the freshly-installed CLI.
  // OTACON_UPDATED=1 trips the loop guard above; stdio is inherited so the child
  // prints the single JSON line on stdout, preserving the start contract.
  notice(`updated otacon ${VERSION} → ${latest}; restarting`);
  const child = deps.spawnSync(
    process.execPath,
    [process.argv[1] ?? "", "start", ...argv],
    { stdio: "inherit", env: { ...process.env, OTACON_UPDATED: "1" } },
  );
  deps.exit(child.status ?? 0);
}
