// Per-session disk-backed FIFO event queue with waiter parking.
//
// Every method is synchronous: Node's single thread therefore cannot interleave
// an enqueue between a queue-empty check and a waiter parking — the whole
// no-lost-wakeup argument (DECISIONS.md "SessionQueue: synchronous methods only").
//
// Delivery is at-least-once (DECISIONS.md "Event delivery: at-least-once"):
// take() and waiter wake-ups move the event to an in-flight list — still
// persisted by every flush — and the caller acks it with flush(event) only
// after the response goes out. A crash inside that window re-delivers the event
// on the next daemon start instead of losing it, even if other enqueues flushed
// in between. An event seq is minted by the caller (Store.bumpCounter
// "eventSeq") so seqs survive queue drains.

import { existsSync, readFileSync } from "node:fs";
import type { EventPayload, EventsFile, QueuedEvent } from "../shared/types.js";
import { quarantineCorruptFile, stringify, writeFileAtomic } from "./store.js";

export type Waiter = (event: QueuedEvent) => void;

export interface ParkHandle {
  /** Unpark without consuming anything; queued events stay queued. No-op after wake. */
  cancel(): void;
}

const EVENT_KINDS = new Set(["comments", "question", "answer", "quiz-answer", "review-thread", "approved", "deleted"]);

function validReviewThreadPayload(raw: Record<string, unknown>): boolean {
  if (raw.event !== "review-thread") return true;
  const optional = raw.remember === undefined ? [] : ["remember"];
  const expected = ["event", "work", "session", "thread", "reportRevision", "headRevision", "headSha", "anchor", "body", ...optional].sort();
  const actual = Object.keys(raw).sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) return false;
  if (raw.work !== "question" && raw.work !== "report-feedback" && raw.work !== "code-change") return false;
  if (typeof raw.session !== "string" || !/^otc_[0-9a-z]{6,64}$/.test(raw.session) ||
    typeof raw.thread !== "string" || !/^[qt][1-9]\d{0,8}$/.test(raw.thread) ||
    (raw.work === "question" ? !raw.thread.startsWith("q") : !raw.thread.startsWith("t")) ||
    !Number.isSafeInteger(raw.reportRevision) || (raw.reportRevision as number) < 1 ||
    !Number.isSafeInteger(raw.headRevision) || (raw.headRevision as number) < 1 ||
    typeof raw.headSha !== "string" || !/^[0-9a-f]{40}$/i.test(raw.headSha) ||
    typeof raw.body !== "string" || raw.body.trim() === "" || raw.body.length > 20_000 ||
    typeof raw.anchor !== "object" || raw.anchor === null || Array.isArray(raw.anchor)) return false;
  const anchor = raw.anchor as Record<string, unknown>;
  const anchorOptional = ["prefix", "suffix"].filter((key) => anchor[key] !== undefined);
  const anchorExpected = ["section", "exact", ...anchorOptional].sort();
  const anchorActual = Object.keys(anchor).sort();
  if (anchorActual.length !== anchorExpected.length || !anchorActual.every((key, index) => key === anchorExpected[index]) ||
    typeof anchor.section !== "string" || anchor.section.trim() === "" || anchor.section.length > 200 ||
    typeof anchor.exact !== "string" || anchor.exact.trim() === "" || anchor.exact.length > 10_000 ||
    (anchor.prefix !== undefined && (typeof anchor.prefix !== "string" || anchor.prefix.length > 1_000)) ||
    (anchor.suffix !== undefined && (typeof anchor.suffix !== "string" || anchor.suffix.length > 1_000))) return false;
  if (raw.remember !== undefined) {
    if (typeof raw.remember !== "object" || raw.remember === null || Array.isArray(raw.remember)) return false;
    const remember = raw.remember as Record<string, unknown>;
    if (Object.keys(remember).length !== 1 || (remember.scope !== "user" && remember.scope !== "project")) return false;
  }
  return true;
}

function validQueuedEvent(value: unknown): value is QueuedEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const payload = event.payload;
  return Number.isSafeInteger(event.seq) && (event.seq as number) >= 0 &&
    typeof event.queuedAt === "string" && Number.isFinite(Date.parse(event.queuedAt)) &&
    typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).event === "string" &&
    EVENT_KINDS.has((payload as Record<string, unknown>).event as string) &&
    typeof (payload as Record<string, unknown>).session === "string" &&
    ((payload as Record<string, unknown>).session as string) !== "" &&
    validReviewThreadPayload(payload as Record<string, unknown>);
}

export class SessionQueue {
  private events: QueuedEvent[] = [];
  /** Dequeued (taken or delivered to a waiter) but not yet acked via flush(event). */
  private inFlight: QueuedEvent[] = [];
  private waiters: { waiter: Waiter }[] = [];
  private closed = false;

  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      raw = undefined;
    }
    const file = raw as EventsFile | undefined;
    if (file?.version !== 1 || !Array.isArray(file.events) || !file.events.every(validQueuedEvent)) {
      // Quarantine, never wedge (DECISIONS.md "Corrupt state files are
      // quarantined, not fatal"): pending events are preserved in the
      // quarantined file for manual recovery, and the session keeps working
      // instead of every events call throwing forever.
      quarantineCorruptFile(filePath, "events queue");
      this.flush(); // re-seed an empty file so the next instance reads clean
      return;
    }
    this.events = file.events;
  }

  /** Undelivered events currently queued in memory. */
  get size(): number {
    return this.events.length;
  }

  /** Delivered events awaiting their post-response flush(event) ack. */
  get inFlightCount(): number {
    return this.inFlight.length;
  }

  get waiterCount(): number {
    return this.waiters.length;
  }

  /** Inspect durable queued/in-flight work without consuming it (startup repair). */
  hasPayload(predicate: (payload: EventPayload) => boolean): boolean {
    // The constructor rejects malformed durable envelopes, and enqueue only
    // accepts EventPayload. Keep this inspection defensive too: startup repair
    // must never skip a missing wake because an unexpected null entry throws
    // before the predicate reaches later valid work.
    return [...this.inFlight, ...this.events].some((event) =>
      validQueuedEvent(event) && predicate(event.payload)
    );
  }

  /** Durably append (flushes before any waiter sees it), then wake the first waiter. */
  enqueue(payload: EventPayload, seq: number): QueuedEvent {
    const event: QueuedEvent = { seq, queuedAt: new Date().toISOString(), payload };
    this.events.push(event);
    this.flush();
    this.dispatch();
    return event;
  }

  /** Fast path: dequeue into the in-flight list. Respond, then flush(event) to ack. */
  take(): QueuedEvent | undefined {
    const event = this.events.shift();
    if (event) this.inFlight.push(event);
    return event;
  }

  /** Park a waiter, FIFO behind earlier ones; wakes immediately if events are queued. */
  park(waiter: Waiter): ParkHandle {
    const entry = { waiter };
    this.waiters.push(entry);
    this.dispatch();
    return {
      cancel: () => {
        const index = this.waiters.indexOf(entry);
        if (index !== -1) this.waiters.splice(index, 1);
      },
    };
  }

  /**
   * Detach from disk forever (DELETE /api/sessions/:id evicted this instance):
   * flush and requeue become no-ops. A delivered-but-unacked event's
   * post-response ack callback can fire after the delete removes the home
   * session dir: writing then would recreate ~/.otacon/sessions/<id>/
   * (writeFileAtomic mkdirs). The events file leaves with the dir.
   */
  close(): void {
    this.closed = true;
  }

  /**
   * Detach from disk AND wake every parked waiter with one terminal event
   * (DELETE of a live session, approval and archive lifecycle): set `closed` first so
   * flush/requeue/dispatch all become no-ops (the synthetic event is never
   * persisted or requeued, and a late post-response ack can't recreate the
   * `~/.otacon/sessions/<id>/` dir the caller is about to remove), then hand each
   * parked waiter the same payload so its long-poll resolves cleanly instead of
   * 404ing on the next call. No waiter parked = nobody to wake (an agent that
   * is not parked discovers the delete via its next call's 404). The synthetic
   * seq is -1: it never touches disk or the eventSeq counter.
   */
  closeWith(payload: EventPayload): void {
    this.close(); // share the detach-from-disk semantics — closed first, see above
    const event: QueuedEvent = { seq: -1, queuedAt: new Date().toISOString(), payload };
    for (const { waiter } of this.waiters.splice(0)) waiter(event);
  }

  /** Return an undeliverable event (e.g. wait aborted after wake) to the head, durably. */
  requeue(event: QueuedEvent): void {
    if (this.closed) return;
    this.dropInFlight(event);
    this.events.unshift(event);
    this.flush();
    this.dispatch();
  }

  /**
   * Persist the queue: in-flight events first (they were dequeued earlier, so
   * FIFO order survives a restart), then the queued tail. Pass the event a
   * response just went out for to ack it — only an ack removes it from disk.
   */
  flush(acked?: QueuedEvent): void {
    if (this.closed) return;
    if (acked) this.dropInFlight(acked);
    const file: EventsFile = { version: 1, events: [...this.inFlight, ...this.events] };
    writeFileAtomic(this.filePath, stringify(file));
  }

  private dropInFlight(event: QueuedEvent): void {
    const index = this.inFlight.indexOf(event);
    if (index !== -1) this.inFlight.splice(index, 1);
  }

  /**
   * Pair queued events with parked waiters, FIFO on both sides, one event each.
   * A waiter that throws gets its event back at the head (still durable) so the
   * next dispatch can deliver it; the throw propagates to the caller.
   */
  private dispatch(): void {
    while (this.waiters.length > 0 && this.events.length > 0) {
      const entry = this.waiters.shift() as { waiter: Waiter };
      const event = this.events.shift() as QueuedEvent;
      this.inFlight.push(event);
      try {
        entry.waiter(event);
      } catch (error) {
        this.dropInFlight(event);
        this.events.unshift(event);
        throw error;
      }
    }
  }
}
