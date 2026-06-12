// Per-session disk-backed FIFO event queue with waiter parking (DESIGN.md §6, §7).
//
// Every method is synchronous: Node's single thread therefore cannot interleave
// an enqueue between a queue-empty check and a waiter parking — the whole
// no-lost-wakeup argument (DECISIONS.md "SessionQueue: synchronous methods only").
//
// Delivery is at-least-once (DECISIONS.md "Event delivery: at-least-once"):
// take() and waiter wake-ups dequeue in memory only. The caller responds first,
// then calls flush(); a crash inside that window re-delivers the event on the
// next daemon start instead of losing it. An event seq is minted by the caller
// (Store.bumpCounter "eventSeq") so seqs survive queue drains.

import { existsSync, readFileSync } from "node:fs";
import type { EventPayload, EventsFile, QueuedEvent } from "../shared/types.js";
import { writeFileAtomic } from "./store.js";

export type Waiter = (event: QueuedEvent) => void;

export interface ParkHandle {
  /** Unpark without consuming anything; queued events stay queued. No-op after wake. */
  cancel(): void;
}

export class SessionQueue {
  private events: QueuedEvent[] = [];
  private waiters: { waiter: Waiter }[] = [];

  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (cause) {
      throw new Error(`corrupt events file: ${filePath}`, { cause });
    }
    const file = raw as EventsFile;
    if (file?.version !== 1 || !Array.isArray(file.events)) {
      throw new Error(`corrupt events file: ${filePath}`);
    }
    this.events = file.events;
  }

  /** Undelivered events currently queued in memory. */
  get size(): number {
    return this.events.length;
  }

  get waiterCount(): number {
    return this.waiters.length;
  }

  /** Durably append (flushes before any waiter sees it), then wake the first waiter. */
  enqueue(payload: EventPayload, seq: number): QueuedEvent {
    const event: QueuedEvent = { seq, queuedAt: new Date().toISOString(), payload };
    this.events.push(event);
    this.flush();
    this.dispatch();
    return event;
  }

  /** Fast path: dequeue in memory. Respond, then flush() — never flush first. */
  take(): QueuedEvent | undefined {
    return this.events.shift();
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

  /** Return an undeliverable event (e.g. wait aborted after wake) to the head, durably. */
  requeue(event: QueuedEvent): void {
    this.events.unshift(event);
    this.flush();
    this.dispatch();
  }

  /** Persist the in-memory queue. Call after a take()/wake response goes out. */
  flush(): void {
    const file: EventsFile = { version: 1, events: this.events };
    writeFileAtomic(this.filePath, JSON.stringify(file, null, 2) + "\n");
  }

  /** Pair queued events with parked waiters, FIFO on both sides, one event each. */
  private dispatch(): void {
    while (this.waiters.length > 0 && this.events.length > 0) {
      const entry = this.waiters.shift();
      const event = this.events.shift();
      if (entry && event) entry.waiter(event);
    }
  }
}
