// Per-session normalized live-activity stream: .otacon/<id>/stream.jsonl holds
// the daemon's append-only, capped record of captured agent activity plus
// `otacon progress` highlights — the high-frequency telemetry the review UI
// watches while the agent works. JSONL (one StreamEvent per line) so a
// frequent capture source pays a cheap append, not a whole-file rewrite, on the
// common path; the file is rewritten only when it grows past the cap (keeping
// the newest N). Same storage posture as activity.ts and the queue/transcript
// readers: atomic rewrites, corrupt lines skipped (never quarantine the whole
// file — a JSONL stream's value is the lines that DID parse), never fatal.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StreamEvent, StreamKind } from "../../shared/types.js";
import { writeFileAtomic } from "../store.js";

const KINDS: readonly StreamKind[] = ["tool", "text", "thinking", "highlight"];

/**
 * One JSONL line → a StreamEvent, or undefined for a blank/corrupt/incomplete
 * line (a torn final append, a hand-edit). Validates every field, not just the
 * envelope (same argument as activity.ts): a bad event would otherwise flow a
 * non-event into the stream snapshot and the SSE frame.
 */
function parseLine(line: string): StreamEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const e = raw as StreamEvent;
  const valid =
    typeof e === "object" &&
    e !== null &&
    typeof e.seq === "number" &&
    Number.isInteger(e.seq) &&
    typeof e.at === "string" &&
    KINDS.includes(e.kind) &&
    typeof e.label === "string" &&
    (e.detail === undefined || typeof e.detail === "string") &&
    (e.tool === undefined || typeof e.tool === "string") &&
    (e.status === undefined ||
      e.status === "running" ||
      e.status === "ok" ||
      e.status === "error");
  return valid ? e : undefined;
}

/** Every parseable event, oldest first; missing file or all-corrupt = []. Never throws. */
function readAll(path: string): StreamEvent[] {
  if (!existsSync(path)) return [];
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const events: StreamEvent[] = [];
  for (const line of body.split("\n")) {
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return events;
}

/**
 * The stream's events, oldest first (newest last). `limit` returns only the
 * newest N — what the per-session SSE snapshot serves. Corrupt lines are
 * skipped; a missing file reads as empty.
 */
export function readStream(path: string, limit?: number): StreamEvent[] {
  const events = readAll(path);
  if (limit !== undefined && limit > 0 && events.length > limit) {
    return events.slice(events.length - limit);
  }
  return events;
}

/**
 * Durably append events as JSONL lines, then cap: when the file holds more than
 * `cap`, it is rewritten atomically to the newest `cap` (older lines drop off
 * the front). The append is the cheap common path; the rewrite is the rare
 * trim. Returns the events as appended (unchanged). A `cap` of 0 or less keeps
 * everything (no trim).
 */
export function appendStreamEvents(path: string, events: StreamEvent[], cap: number): StreamEvent[] {
  if (events.length === 0) return events;
  mkdirSync(dirname(path), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  appendFileSync(path, lines);
  if (cap > 0) {
    const all = readAll(path);
    if (all.length > cap) {
      const kept = all.slice(all.length - cap);
      writeFileAtomic(path, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
  }
  return events;
}

/**
 * Monotonic per-session seq source for the daemon. Seeds lazily from the
 * stream's max seq on first use (so a daemon restart never re-mints a live
 * seq), then increments in memory. One instance per session id; the daemon owns
 * the single writer, so no locking is needed (DECISIONS.md "One daemon process
 * owns all state").
 */
export class StreamSeq {
  private last: number | undefined;

  /** Mint the next seq, seeding from the file's max on first call. */
  next(path: string): number {
    if (this.last === undefined) {
      let max = 0;
      for (const event of readAll(path)) max = Math.max(max, event.seq);
      this.last = max;
    }
    this.last += 1;
    return this.last;
  }
}
