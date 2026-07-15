// Pure folding + selection logic for the live-activity console and the
// now-playing bar (the live-activity stream, §10a). Kept React-free so the
// grouping, run-collapsing, status-pairing, kind-filtering, and the
// now-playing label/mode derivation are unit-tested without a DOM, the same
// split as group.ts (rail grouping) and compact.ts (header state). The
// components in now-playing.tsx / live-console.tsx render what these functions
// return and own nothing but presentation.

import type { AnySessionStatus, StreamEvent, StreamKind } from "../api";

/**
 * The kind-filter chips on the console. "all" is every kind; the rest narrow to
 * one. "highlight" has no chip of its own: progress notes are chapter dividers
 * that always show (they are the floor, never noise), so the filter set is the
 * three captured kinds plus all.
 */
export type StreamFilter = "all" | "tool" | "text" | "thinking";

/**
 * One rendered console row: either a single event, or a collapsed run of
 * consecutive same-label rows folded into one ("Read ×5", expandable). A tool's
 * `running` event and its later `ok`/`error` outcome are paired into one logical
 * event before rows are built, so a row carries the *final* status, never a
 * dangling "running" once the outcome has landed.
 */
export interface ConsoleRow {
  /** Stable key: the seq of the row's first underlying event. */
  key: number;
  kind: StreamKind;
  /** The shared label of the run (every member has the same label). */
  label: string;
  /** Raw tool name when kind === "tool" (from the first member). */
  tool?: string;
  /**
   * The resolved lifecycle status of the row, after pairing running→outcome:
   * "running" only while no outcome has landed yet; "ok"/"error" once it has.
   * Absent for non-tool kinds.
   */
  status?: "running" | "ok" | "error";
  /** The events folded into this row, oldest first. length 1 = a singleton. */
  members: StreamEvent[];
}

/**
 * Pair each tool `running` event with its following `ok`/`error` outcome into a
 * single logical event that carries the resolved status, and drop the bare
 * outcome event (it has no `tool` and only a "→ ok" label, so it is not a row of
 * its own). The outcome need not be adjacent: a `running` is matched to the next
 * outcome event that follows it, so interleaved text/thinking between a call and
 * its result don't break the pairing. A `running` with no outcome yet stays
 * "running" (the now-playing timer ticks on it); an orphan outcome with no open
 * call is passed through untouched (defensive: the daemon emits them in order).
 */
export function pairOutcomes(events: StreamEvent[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  // Indexes into `out` of running tool events still awaiting an outcome, oldest
  // first: an outcome resolves the oldest open call (FIFO), matching the
  // append-only running-then-outcome ordering the adapters guarantee (§10a).
  const open: number[] = [];
  for (const ev of events) {
    const isOutcome = ev.tool === undefined && (ev.status === "ok" || ev.status === "error");
    if (isOutcome && open.length > 0) {
      const at = open.shift() as number;
      const call = out[at] as StreamEvent;
      out[at] = { ...call, status: ev.status };
      continue;
    }
    if (ev.kind === "tool" && ev.status === "running" && ev.tool !== undefined) {
      open.push(out.length);
    }
    out.push(ev);
  }
  return out;
}

/** Does this event survive the active kind filter? Highlights always pass. */
function passesFilter(ev: StreamEvent, filter: StreamFilter): boolean {
  if (ev.kind === "highlight") return true;
  if (filter === "all") return true;
  return ev.kind === filter;
}

/**
 * The full console fold: pair outcomes, apply the kind filter and the thinking
 * toggle, then collapse maximal runs of consecutive same-(kind,label,tool) rows
 * into one counted row. Highlights never collapse: each progress note is its
 * own chapter divider, even two in a row. A run only collapses adjacent
 * members, so an interleaved different event splits the run (5 reads, a write, 2
 * more reads = three rows), which keeps the timeline honest.
 *
 * @param showThinking when false, thinking events are dropped entirely (the
 *   off-by-default toggle, since thinking is the noisiest kind).
 */
export function buildRows(
  events: StreamEvent[],
  filter: StreamFilter,
  showThinking: boolean,
): ConsoleRow[] {
  const paired = pairOutcomes(events);
  const rows: ConsoleRow[] = [];
  for (const ev of paired) {
    if (ev.kind === "thinking" && !showThinking) continue;
    if (!passesFilter(ev, filter)) continue;
    const last = rows[rows.length - 1];
    const collapsible =
      ev.kind !== "highlight" &&
      last !== undefined &&
      last.kind === ev.kind &&
      last.label === ev.label &&
      last.tool === ev.tool &&
      // A still-running tail can't fold into a settled run, or the count would
      // hide that the latest call hasn't returned (the bar needs to see it).
      last.status !== "running" &&
      ev.status !== "running";
    if (collapsible && last) {
      last.members.push(ev);
      last.status = ev.status; // the run carries its newest member's status
      continue;
    }
    rows.push({
      key: ev.seq,
      kind: ev.kind,
      label: ev.label,
      tool: ev.tool,
      status: ev.status,
      members: [ev],
    });
  }
  return rows;
}

/** The agent-active statuses: the now-playing bar pulses only during these. */
const ACTIVE_STATUSES = new Set<AnySessionStatus>([
  "draft",
  "revising",
  "finalizing",
  "implementing",
  "working",
]);

/** Whether the agent is actively working (a live pulse belongs on the bar). */
export function isAgentActive(status: AnySessionStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/**
 * The mode badge: "live" when the stream carries any captured event
 * (tool/text/thinking): an adapter is attached and the firehose is flowing.
 * "notes" when it is empty or holds only `highlight` progress notes (the floor,
 * §10a). Makes the rich-capture-vs-floor distinction visible at a glance.
 */
export function streamMode(events: StreamEvent[]): "live" | "notes" {
  return events.some((e) => e.kind !== "highlight") ? "live" : "notes";
}

/**
 * What the now-playing bar shows for "right now". Prefer the most recent
 * meaningful event (tool/text/highlight); a trailing `thinking` is shown only
 * when nothing more concrete sits under it, and flagged `dim` so the bar renders
 * it muted/italic. `running` is true when the chosen event is a tool call still
 * awaiting its outcome, in which case the bar shows a ticking elapsed timer from `at`.
 * Returns null on an empty stream (the bar shows a calm resting line).
 */
export interface NowPlaying {
  event: StreamEvent;
  /** The chosen event is a still-running tool call: tick an elapsed timer. */
  running: boolean;
  /** The chosen event is a bare `thinking` note: render it dimmed/italic. */
  dim: boolean;
}

export function nowPlaying(events: StreamEvent[]): NowPlaying | null {
  const paired = pairOutcomes(events);
  if (paired.length === 0) return null;
  // Walk newest→oldest for the first meaningful (non-thinking) event; if the
  // whole tail is thinking, fall back to the very latest event, dimmed.
  let chosen: StreamEvent | undefined;
  for (let i = paired.length - 1; i >= 0; i--) {
    const ev = paired[i] as StreamEvent;
    if (ev.kind !== "thinking") {
      chosen = ev;
      break;
    }
  }
  const dim = chosen === undefined;
  const event = chosen ?? (paired[paired.length - 1] as StreamEvent);
  const running = event.kind === "tool" && event.status === "running";
  return { event, running, dim };
}
