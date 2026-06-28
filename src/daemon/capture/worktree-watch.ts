// The per-session worktree liveness watch: while a session is `implementing`,
// the daemon polls that session's own implement worktree for filesystem changes
// and refreshes liveness on any increase in the newest mtime. This keeps the
// agent-live dot lit through multi-minute subagent runs where the parent
// orchestrator emits nothing to its transcript — the build still edits, builds,
// and tests near-continuously, so the worktree's newest mtime keeps moving.
//
// Why the worktree, not the subagent transcript: the worktree is unique per
// session, so it needs no attribution heuristics, no hooks, and no agent
// cooperation. A child subagent's transcript carries no back-link to its parent
// session, so following it would be a heuristic. The worktree mtime is a direct
// signal of real work.
//
// Design choices mirror the tailer's (favoring reliability over cleverness):
//   - A plain poll loop, not `fs.watch`. `fs.watch` is platform-flaky (missed
//     events, double-fires, no support on some network FSes); a coarse interval
//     poll is boring and always works. The cadence only has to stay below the
//     5-min `agentLive` window, since a single worktree write inside that window
//     keeps the dot live — so a coarse poll suffices and cuts scan cost.
//   - Prime on the first observed mtime WITHOUT bumping. The worktree is freshly
//     written at implement-start (or already populated on a daemon restart), so
//     the first observed mtime is a baseline, not new activity.
//   - Tolerate a not-yet-created dir: the worktree may appear a beat after the
//     watch starts; scan returns undefined and we keep polling without a bump.
//   - Fail-soft throughout: any fs error returns undefined for that subtree and
//     never throws; a tick error is swallowed and the next tick retries.

import type { Dirent } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Default poll cadence. It only has to stay BELOW the 5-min `agentLive` window:
 * a single worktree write inside that window keeps the dot live, so a coarse
 * poll suffices and cuts scan cost. Not a config key, to keep surface minimal.
 */
export const DEFAULT_WORKTREE_POLL_MS = 30_000;

/** Directories never worth scanning — noisy, large, and not agent-edit signal. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * The newest mtime (ms) of any file/dir under `dir`, skipping `node_modules` and
 * `.git`. Returns undefined if `dir` does not exist yet, is empty, or the scan
 * failed. Fully fail-soft: any fs error on a subtree contributes nothing rather
 * than throwing.
 */
export function scanNewestMtime(dir: string): number | undefined {
  let newest: number | undefined;
  const visit = (path: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return; // unreadable subtree (missing/permission) — contributes nothing
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const child = join(path, entry.name);
      try {
        const st = statSync(child);
        if (newest === undefined || st.mtimeMs > newest) newest = st.mtimeMs;
        if (entry.isDirectory()) visit(child);
      } catch {
        // A racing unlink or a broken symlink — skip this entry, keep scanning.
      }
    }
  };
  try {
    // Stat the root itself so an empty-but-touched dir still reads as activity.
    const rootStat = statSync(dir);
    newest = rootStat.mtimeMs;
  } catch {
    return undefined; // dir does not exist yet
  }
  visit(dir);
  return newest;
}

/** Everything the watch needs from the daemon, injectable for tests. */
export interface WorktreeWatchDeps {
  /** The session's implement worktree path. */
  dir: string;
  /** Bump session liveness when the newest mtime increases; skipped on baseline. */
  onActivity: () => void;
  /** Test seam: poll interval in ms. */
  intervalMs?: number;
  /** Test seam: the scan fn (defaults to the real recursive mtime walk). */
  scan?: (dir: string) => number | undefined;
  /** Test seam: the timer factory (defaults to setInterval/clearInterval). */
  setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * One session's worktree watch. Construct, `start()`, and `stop()`; both are
 * idempotent. A test can skip the timer entirely and drive `tick()` by hand.
 */
export class WorktreeWatch {
  private readonly dir: string;
  private readonly onActivity: () => void;
  private readonly intervalMs: number;
  private readonly scan: (dir: string) => number | undefined;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  // The first observed mtime is the baseline (the worktree is freshly written at
  // implement-start / already populated on a restart), so it must not count as
  // new activity. Until a real mtime is seen, this stays undefined and no bump
  // can fire — tolerating a not-yet-created dir.
  private baseline: number | undefined;

  constructor(deps: WorktreeWatchDeps) {
    this.dir = deps.dir;
    this.onActivity = deps.onActivity;
    this.intervalMs = deps.intervalMs ?? DEFAULT_WORKTREE_POLL_MS;
    this.scan = deps.scan ?? scanNewestMtime;
    this.setIntervalFn = deps.setInterval ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h));
  }

  /** Begin polling. Idempotent — a second `start` is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const timer = this.setIntervalFn(() => this.tick(), this.intervalMs);
    // Don't let the poll timer keep the daemon process alive on its own.
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  /** Tear down the poller. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One poll: scan the worktree's newest mtime. Establish the baseline on the
   * first real reading (no bump). On any later reading strictly greater than the
   * baseline, re-baseline and fire onActivity. Public so a test can drive it
   * without a real timer. Fully fail-soft — any error is swallowed.
   */
  tick(): void {
    try {
      const newest = this.scan(this.dir);
      if (newest === undefined) return; // dir not there yet / empty / scan failed
      if (this.baseline === undefined) {
        this.baseline = newest; // prime: first reading is a baseline, not activity
        return;
      }
      if (newest > this.baseline) {
        this.baseline = newest;
        this.onActivity();
      }
    } catch {
      // A scan/callback hiccup on one tick must not kill the loop — retry next.
    }
  }
}
