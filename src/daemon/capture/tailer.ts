// The per-session transcript tailer: the daemon-side loop that watches a coding
// agent's live transcript and feeds new activity into the Phase 1 stream
// pipeline. Bound to a session's lifetime — `start` when the session goes
// active, `stop` on terminal/removal — it (1) finds the agent's transcript via
// the registry, (2) polls it for new bytes, (3) `parse`s them into
// `RawStreamEvent`s, (4) `normalize`s each (the daemon stamps seq + `at`,
// redaction + truncation happen there), (5) appends them as ONE batch, and (6)
// publishes ONE coalesced `stream` frame per batch.
//
// Design choices (favoring reliability over cleverness):
//   - A plain poll loop, not `fs.watch`. `fs.watch` is famously
//     platform-flaky (missed events, double-fires, no support on some network
//     FSes); a short interval poll is boring and always works. A burst between
//     two polls is naturally coalesced into one parse → one append → one frame.
//   - Re-locate while no transcript is found yet. A session can be created a
//     beat before the agent's transcript file appears; we keep retrying
//     `findAdapter` on each tick until one matches (bounded only by `stop`).
//   - Fail-soft throughout: a parse/store/publish error on one tick is
//     swallowed; the next tick tries again. The tailer never throws into the
//     daemon, and at worst the session runs on the `otacon progress` floor.

import type { StreamConfig } from "../../shared/config.js";
import type { StreamEvent } from "../../shared/types.js";
import type { Cursor, TranscriptAdapter, TranscriptHandle } from "./adapter.js";
import { INITIAL_CURSOR } from "./adapter.js";
import { normalize } from "./normalize.js";
import { findAdapter as defaultFindAdapter } from "./registry.js";

/** Default poll cadence — coalesces a burst of writes into one batch per tick. */
export const DEFAULT_POLL_MS = 150;

/** Everything the tailer needs from the daemon, injectable for tests. */
export interface TailerDeps {
  /** The session's repo root — used to locate the agent's transcript. */
  repoRoot: string;
  /** Mint the next monotonic per-session stream seq (the daemon owns this). */
  nextSeq: () => number;
  /** Append a batch durably (and cap); the daemon's stream store. */
  append: (events: StreamEvent[]) => void;
  /** Publish ONE coalesced `stream` frame for the batch. */
  publish: (events: StreamEvent[]) => void;
  /** The session's stream config (caps) for `normalize`. */
  config: () => StreamConfig;
  /** Bump session liveness when genuinely new activity is ingested; skipped on the first catch-up batch. */
  markActive?: () => void;
  /** Test seam: defaults to the real registry lookup. */
  findAdapter?: (repoRoot: string) => { adapter: TranscriptAdapter; handle: TranscriptHandle } | null;
  /** Test seam: poll interval in ms. */
  pollMs?: number;
  /** Test seam: the timer factory (defaults to setInterval/clearInterval). */
  setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * One session's tailer. Construct, `start()`, and `stop()`; both are idempotent.
 * A test can skip the timer entirely and drive `tick()` by hand.
 */
export class Tailer {
  private readonly deps: Required<Pick<TailerDeps, "repoRoot" | "nextSeq" | "append" | "publish" | "config">> &
    Pick<TailerDeps, never>;
  private readonly markActiveFn?: () => void;
  private readonly findAdapter: (repoRoot: string) => { adapter: TranscriptAdapter; handle: TranscriptHandle } | null;
  private readonly pollMs: number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;

  private timer: ReturnType<typeof setInterval> | undefined;
  private adapter: TranscriptAdapter | undefined;
  private handle: TranscriptHandle | undefined;
  private cursor: Cursor = { ...INITIAL_CURSOR };
  private running = false;
  // The first non-empty batch is the catch-up replay of existing transcript
  // lines; we prime on it WITHOUT bumping liveness, so a daemon restart stays
  // offline until genuinely new activity arrives. markActive fires only from the
  // second non-empty batch onward.
  private primed = false;

  constructor(deps: TailerDeps) {
    this.deps = deps;
    this.markActiveFn = deps.markActive;
    this.findAdapter = deps.findAdapter ?? defaultFindAdapter;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.setIntervalFn = deps.setInterval ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h));
  }

  /** Begin polling. Idempotent — a second `start` is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    // Try to bind immediately so a transcript that already exists streams on the
    // first tick; if none is found yet, `tick` keeps re-locating.
    this.locate();
    const timer = this.setIntervalFn(() => this.tick(), this.pollMs);
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
   * One poll: re-locate if still unbound, then parse any new bytes and flush a
   * single batch. Public so a test can drive it without a real timer. Fully
   * fail-soft — any error is swallowed and the next tick retries.
   */
  tick(): void {
    try {
      if (this.adapter === undefined || this.handle === undefined) {
        this.locate();
        if (this.adapter === undefined || this.handle === undefined) return; // still no transcript
      }
      const { events: raw, cursor } = this.adapter.parse(this.handle, this.cursor);
      this.cursor = cursor;
      if (raw.length === 0) return;
      const cfg = this.deps.config();
      const at = new Date().toISOString();
      const normalized = raw.map((e) => normalize(e, cfg, this.deps.nextSeq(), at));
      this.deps.append(normalized);
      this.deps.publish(normalized);
      // Genuinely new activity bumps liveness — but the first non-empty batch is
      // the catch-up replay, so prime on it and only bump from the next one on.
      if (this.primed) this.markActiveFn?.();
      else this.primed = true;
    } catch {
      // A parse/store/publish hiccup on one tick must not kill the loop — the
      // session falls back to the floor for this tick and we retry next time.
    }
  }

  /** Resolve the adapter+handle for this repo (no-op when one is already bound). */
  private locate(): void {
    if (this.adapter !== undefined && this.handle !== undefined) return;
    const found = this.findAdapter(this.deps.repoRoot);
    if (!found) return; // floor: no adapter for this repo's agent (yet)
    this.adapter = found.adapter;
    this.handle = found.handle;
    this.cursor = { ...INITIAL_CURSOR };
  }
}
