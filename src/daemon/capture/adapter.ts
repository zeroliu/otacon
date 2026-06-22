// The transcript-adapter contract: how the daemon turns a coding agent's own
// on-disk transcript into the normalized live-activity stream WITHOUT any
// per-agent hook or cooperation from the agent. An adapter knows one agent's
// transcript format; it (1) `locate`s the freshest transcript whose recorded
// cwd is this session's repo root, and (2) `parse`s new bytes since a `Cursor`
// into `RawStreamEvent`s the Phase 1 normalizer can stamp + redact + truncate.
//
// Two hard rules every adapter inherits (the graceful-degradation guarantee):
//   - Fail-soft: a malformed line, a vanished file, or any parse error must
//     never throw. At worst the session silently runs on the `otacon progress`
//     floor. The registry no-ops when no adapter matches.
//   - Append-only: Phase 1's store never upserts. A tool's `running` event and
//     its later `ok`/`error` outcome are TWO separate appended events, not one
//     mutated row. Adapters emit follow-on events, never edits.
//
// The `Cursor` is opaque to the daemon: `offset` is the byte position the next
// `parse` resumes from (always left BEFORE a trailing partial line), and an
// adapter may carry extra per-adapter state on it (e.g. pending tool_use ids).
// The daemon round-trips whatever the adapter returns; it never inspects the
// carry.

import type { RawStreamEvent } from "./normalize.js";

export type { RawStreamEvent };

/** A located transcript: which agent wrote it, and where it lives on disk. */
export interface TranscriptHandle {
  /** The adapter's agent id (mirrors `TranscriptAdapter.agent`). */
  agent: string;
  /** Absolute path to the transcript file. */
  path: string;
}

/**
 * Where the next incremental `parse` resumes. `offset` is a byte position into
 * the transcript; everything else is the adapter's private carry (the daemon
 * stores and returns it untouched). A fresh tail starts at `{ offset: 0 }`.
 */
export interface Cursor {
  /** Byte offset to read from on the next parse (end of the last COMPLETE line). */
  offset: number;
  /** Per-adapter carry — the daemon round-trips it without inspecting it. */
  [carry: string]: unknown;
}

/**
 * One agent's transcript reader. Both methods are fail-soft (never throw) and
 * read-only (an adapter never writes the agent's transcript).
 */
export interface TranscriptAdapter {
  /** Stable agent id, e.g. "claude". */
  readonly agent: string;
  /**
   * The freshest transcript whose recorded cwd equals `repoRoot`, or null when
   * this agent has none for that repo. Must never throw.
   */
  locate(repoRoot: string): TranscriptHandle | null;
  /**
   * Read from `cursor.offset` to EOF, emit the complete lines as
   * `RawStreamEvent`s, and return the advanced cursor (offset left before any
   * trailing partial line so the next poll completes it). Incremental and
   * fail-soft: a bad line is skipped, never thrown.
   */
  parse(handle: TranscriptHandle, cursor: Cursor): { events: RawStreamEvent[]; cursor: Cursor };
}

/** The starting cursor for a fresh tail. */
export const INITIAL_CURSOR: Cursor = { offset: 0 };
