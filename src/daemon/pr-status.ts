// The GitHub PR-state probe: the daemon's poller asks GitHub "is this session's
// latest PR still open, merged, or closed?" so the home UI can section an
// implemented plan by its real fate instead of leaving it a graveyard. It shells
// out to the `gh` CLI (`gh pr view <url> --json state`), reusing the user's
// existing `gh auth` (no token for otacon to store, manage, or leak), and it is a
// LOCAL OS call, never a model API (the zero-API-spend invariant is untouched).
//
// `fetchPrState` is pure and total: it NEVER throws or rejects. On ANY failure
// (gh missing / ENOENT, non-zero exit, network error, a hung process that the
// timeout kills, empty / malformed / unexpected JSON, an unknown state value) it
// resolves `undefined`, which the caller reads as "couldn't determine, treat as
// still open and degrade to a plain link". `gh` reports `state` as one of OPEN /
// CLOSED / MERGED, which we lower-case into the model's "open" / "merged" /
// "closed".

import { execFile } from "node:child_process";
import type { RegistrySession } from "../shared/types.js";

export type PrState = "open" | "merged" | "closed";

/** How long a single `gh pr view` may run before we give up and resolve undefined. */
const GH_TIMEOUT_MS = 5_000;

/**
 * The process seam: `run(args)` invokes `gh` with the given argv and resolves its
 * stdout. Tests inject a fake to simulate success / spawn error / non-zero exit
 * without spawning a real process; the default actually runs `gh`.
 */
export interface PrStatusDeps {
  run?: (args: string[]) => Promise<string>;
}

/** Default seam: `execFile("gh", …)` (arg array, no shell) with a timeout, resolving stdout (rejects on failure). */
const defaultRun = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: GH_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

/**
 * Probe a PR's GitHub state via `gh pr view <url> --json state`. Returns the
 * mapped `PrState`, or `undefined` on any failure whatsoever (see file header).
 * Never throws.
 */
export async function fetchPrState(
  url: string,
  deps: PrStatusDeps = {},
): Promise<PrState | undefined> {
  const run = deps.run ?? defaultRun;
  try {
    const stdout = await run(["pr", "view", url, "--json", "state"]);
    const parsed = JSON.parse(stdout) as { state?: unknown };
    switch (parsed.state) {
      case "OPEN":
        return "open";
      case "MERGED":
        return "merged";
      case "CLOSED":
        return "closed";
      default:
        return undefined; // empty, missing, or an unexpected value
    }
  } catch {
    // gh missing/ENOENT, non-zero exit, network error, timeout kill, or malformed
    // JSON: all degrade to "couldn't determine".
    return undefined;
  }
}

/**
 * The PR poller refreshes only UN-SETTLED PRs (`open` or not-yet-known) so the
 * home UI can re-section an implemented plan the moment its PR merges or closes.
 * A settled PR ("merged"/"closed") is GitHub-terminal, so it is never re-queried.
 * Refresh happens on a timer (every few minutes) AND on demand via `pollNow`
 * (the index UI kicks one each time it connects), and any state CHANGE publishes
 * the session so subscribers re-summarize live. Like `fetchPrState`, a poll
 * never throws: an indeterminate probe leaves the session untouched.
 */

/** How often the timer refreshes un-settled PRs. A few minutes: PR fates change on human, not machine, time. */
const POLL_INTERVAL_MS = 3 * 60_000;

/** Everything the poller needs from the daemon, injectable for tests. */
export interface PrPollingDeps {
  /** All registry sessions (the poller filters to PR-bearing, un-settled ones). */
  listSessions: () => RegistrySession[];
  /** Persist a refreshed state (store.updateSession). */
  updateSession: (id: string, patch: { prState: PrState }) => void;
  /** Re-summarize + SSE a session by id (publishSession-by-id) so the UI re-sections. */
  publish: (id: string) => void;
  /** Test seam: defaults to the module's `fetchPrState`. */
  fetchPrState?: (url: string) => Promise<PrState | undefined>;
  /** Test seam: timer cadence in ms (default a few minutes). */
  intervalMs?: number;
  /** Test seam: the timer factory (defaults to setInterval/clearInterval). */
  setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (h: ReturnType<typeof setInterval>) => void;
}

/**
 * Start the timer that periodically refreshes un-settled PRs. Returns `pollNow`
 * (an on-demand sweep, awaitable) and `stop` (clears the timer). The timer is
 * armed here but does NOT fire on start (the caller decides when to kick the
 * first poll). Like the tailer, the handle is `unref`'d so it never holds the
 * process open.
 */
export function startPrPolling(
  deps: PrPollingDeps,
): { pollNow: () => Promise<void>; stop: () => void } {
  const probe = deps.fetchPrState ?? fetchPrState;
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
  const setIntervalFn = deps.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h));

  const pollNow = async (): Promise<void> => {
    // Skip settled PRs (merged/closed are GitHub-terminal) and session-without-PR
    // rows entirely: only `open`/`undefined` are worth a probe.
    const eligible = deps
      .listSessions()
      .filter((s) => typeof s.prUrl === "string" && s.prState !== "merged" && s.prState !== "closed");
    await Promise.all(
      eligible.map(async (session) => {
        // `probe` is total, but stay defensive: one bad probe must not sink the sweep.
        let next: PrState | undefined;
        try {
          next = await probe(session.prUrl as string);
        } catch {
          return; // couldn't determine, leave the session unchanged
        }
        // An absent prState already reads as "open" (see RegistrySession), so a
        // probe of "open" against undefined is NOT a change worth republishing.
        const current = session.prState ?? "open";
        if (next === undefined || next === current) return; // no change to publish
        deps.updateSession(session.id, { prState: next });
        deps.publish(session.id);
      }),
    );
  };

  const timer = setIntervalFn(() => {
    void pollNow();
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.(); // never holds the daemon open on its own

  const stop = (): void => {
    clearIntervalFn(timer);
  };

  return { pollNow, stop };
}
