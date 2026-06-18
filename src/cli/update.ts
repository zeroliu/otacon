// The pure update-check core for `otacon start`'s auto-update gate (DESIGN.md
// §16). Side-effect-free helpers only — no npm spawn, no re-exec, no start
// wiring (those land in Phase 2). Everything here is testable without a network
// or a package manager.
//
// Two decisions shape the shapes below:
//   - D3: the whole check is throttled to once per hour via the
//     `update-check.json` cache (`updateCheckDue`).
//   - D5: latest is discovered by GET registry.npmjs.org/otacon/latest with a
//     short timeout, fail-open on ANY error (`fetchLatest` → undefined).

/**
 * True iff `latest` is a strictly greater semver than `current`. Parses
 * major.minor.patch numerically (a leading `v` and any prerelease/build suffix
 * after patch is ignored). A malformed input on either side returns false —
 * never throws — so a garbled registry answer can never trigger an update.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < 3; i++) {
    const [ai, bi] = [a[i] ?? 0, b[i] ?? 0];
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

/** Parse `x.y.z` (optional leading `v`, trailing `-pre`/`+build` ignored) into a numeric triple. */
function parseSemver(version: string): [number, number, number] | undefined {
  if (typeof version !== "string") return undefined;
  const core = version.trim().replace(/^v/, "").split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  if (parts.length !== 3) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    nums.push(Number(part));
  }
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
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
 * GET registry.npmjs.org/otacon/latest and return its `.version` (D5). On ANY
 * error — network failure, non-200, bad JSON, missing/empty version, or the
 * timeout — resolves to `undefined` so the caller fails open and proceeds on
 * the current version. Never throws. Defaults to a 1.5s timeout when no
 * `signal` is supplied.
 */
export async function fetchLatest(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch("https://registry.npmjs.org/otacon/latest", {
      signal: signal ?? AbortSignal.timeout(1500),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version.length > 0 ? body.version : undefined;
  } catch {
    return undefined;
  }
}
