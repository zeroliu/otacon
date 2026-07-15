import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventPayload, QueuedEvent } from "../shared/types.js";
import { SessionQueue } from "./queue.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otacon-queue-"));
  file = join(dir, "events.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function payload(n: number): EventPayload {
  return {
    event: "question",
    session: "otc_abc123",
    id: `q${n}`,
    anchor: null,
    body: `question ${n}`,
  };
}

describe("SessionQueue fast path", () => {
  test("take returns queued events FIFO when no waiter is parked", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    q.enqueue(payload(2), 2);
    expect(q.size).toBe(2);
    expect(q.take()?.seq).toBe(1);
    expect(q.take()?.seq).toBe(2);
    expect(q.take()).toBeUndefined();
  });

  test("enqueue stamps seq and an ISO queuedAt", () => {
    const q = new SessionQueue(file);
    const event = q.enqueue(payload(1), 7);
    expect(event.seq).toBe(7);
    expect(Number.isNaN(Date.parse(event.queuedAt))).toBe(false);
    expect(event.payload).toEqual(payload(1));
  });

  test("startup repair can deduplicate against queued and in-flight payloads", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    q.enqueue(payload(2), 2);
    expect(q.hasPayload((item) => item.event === "question" && item.id === "q1")).toBe(true);
    expect(q.hasPayload((item) => item.event === "question" && item.id === "q3")).toBe(false);
    q.take();
    expect(q.hasPayload((item) => item.event === "question" && item.id === "q1")).toBe(true);
  });

  test("parking when events are already queued delivers synchronously", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    const got: QueuedEvent[] = [];
    q.park((e) => got.push(e));
    expect(got.map((e) => e.seq)).toEqual([1]);
    expect(q.waiterCount).toBe(0);
  });
});

describe("SessionQueue park and wake", () => {
  test("a parked waiter is woken by the next enqueue", () => {
    const q = new SessionQueue(file);
    const got: QueuedEvent[] = [];
    q.park((e) => got.push(e));
    expect(q.waiterCount).toBe(1);
    q.enqueue(payload(1), 1);
    expect(got.map((e) => e.seq)).toEqual([1]);
    expect(q.waiterCount).toBe(0);
    expect(q.size).toBe(0);
  });

  test("multiple waiters are served in FIFO order, one event each", () => {
    const q = new SessionQueue(file);
    const got: string[] = [];
    q.park((e) => got.push(`w1:${e.seq}`));
    q.park((e) => got.push(`w2:${e.seq}`));
    q.park((e) => got.push(`w3:${e.seq}`));
    q.enqueue(payload(1), 1);
    q.enqueue(payload(2), 2);
    q.enqueue(payload(3), 3);
    expect(got).toEqual(["w1:1", "w2:2", "w3:3"]);
    expect(q.waiterCount).toBe(0);
  });

  test("one enqueue wakes exactly one of several waiters", () => {
    const q = new SessionQueue(file);
    const got: string[] = [];
    q.park((e) => got.push(`w1:${e.seq}`));
    q.park((e) => got.push(`w2:${e.seq}`));
    q.enqueue(payload(1), 1);
    expect(got).toEqual(["w1:1"]);
    expect(q.waiterCount).toBe(1);
  });
});

describe("SessionQueue abort", () => {
  test("a canceled waiter never fires and events stay queued", () => {
    const q = new SessionQueue(file);
    let woken = 0;
    const handle = q.park(() => {
      woken += 1;
    });
    handle.cancel();
    expect(q.waiterCount).toBe(0);
    q.enqueue(payload(1), 1);
    expect(woken).toBe(0);
    expect(q.size).toBe(1);
    expect(q.take()?.seq).toBe(1);
  });

  test("canceling the first waiter promotes the second", () => {
    const q = new SessionQueue(file);
    const got: string[] = [];
    const first = q.park((e) => got.push(`w1:${e.seq}`));
    q.park((e) => got.push(`w2:${e.seq}`));
    first.cancel();
    q.enqueue(payload(1), 1);
    expect(got).toEqual(["w2:1"]);
  });

  test("cancel after delivery is a no-op and steals nothing", () => {
    const q = new SessionQueue(file);
    const got: QueuedEvent[] = [];
    const handle = q.park((e) => got.push(e));
    q.enqueue(payload(1), 1);
    handle.cancel();
    q.enqueue(payload(2), 2);
    expect(got.map((e) => e.seq)).toEqual([1]);
    expect(q.size).toBe(1);
  });
});

describe("SessionQueue at-least-once delivery", () => {
  test("take dequeues in memory only; disk keeps the event until the flush ack", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    const taken = q.take();
    expect(taken?.seq).toBe(1);
    expect(q.inFlightCount).toBe(1);
    // Simulated crash before flush: a fresh instance re-delivers the event.
    expect(new SessionQueue(file).take()?.seq).toBe(1);
    q.flush(taken as QueuedEvent);
    expect(q.inFlightCount).toBe(0);
    expect(new SessionQueue(file).size).toBe(0);
  });

  test("a woken waiter's event survives on disk until the flush ack", () => {
    const q = new SessionQueue(file);
    let delivered: QueuedEvent | undefined;
    q.park((e) => {
      delivered = e;
    });
    q.enqueue(payload(1), 1);
    expect(q.size).toBe(0);
    expect(q.inFlightCount).toBe(1);
    expect(new SessionQueue(file).size).toBe(1);
    q.flush(delivered as QueuedEvent);
    expect(new SessionQueue(file).size).toBe(0);
  });

  test("an enqueue between take and ack cannot trim the in-flight event from disk", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    const taken = q.take() as QueuedEvent;
    // A concurrent POST lands before the taker's response goes out.
    q.enqueue(payload(2), 2);
    // Simulated crash before the taker's ack: both events survive, FIFO intact.
    const fresh = new SessionQueue(file);
    expect(fresh.take()?.seq).toBe(1);
    expect(fresh.take()?.seq).toBe(2);
    // The ack trims only the acked event.
    q.flush(taken);
    expect(new SessionQueue(file).take()?.seq).toBe(2);
  });

  test("flush(event) acks only that event; other in-flight events stay durable", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    q.enqueue(payload(2), 2);
    const first = q.take() as QueuedEvent;
    const second = q.take() as QueuedEvent;
    q.flush(second);
    expect(q.inFlightCount).toBe(1);
    expect(new SessionQueue(file).take()?.seq).toBe(1);
    q.flush(first);
    expect(new SessionQueue(file).size).toBe(0);
  });

  test("a waiter that throws gets its event back at the head, still durable", () => {
    const q = new SessionQueue(file);
    q.park(() => {
      throw new Error("response write failed");
    });
    expect(() => q.enqueue(payload(1), 1)).toThrow("response write failed");
    expect(q.size).toBe(1);
    expect(q.inFlightCount).toBe(0);
    expect(q.waiterCount).toBe(0);
    expect(q.take()?.seq).toBe(1);
    expect(new SessionQueue(file).take()?.seq).toBe(1);
  });

  test("requeue returns an undeliverable event to the head, durably", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    q.enqueue(payload(2), 2);
    const event = q.take();
    expect(event?.seq).toBe(1);
    q.requeue(event as QueuedEvent);
    expect(q.size).toBe(2);
    expect(q.inFlightCount).toBe(0);
    const fresh = new SessionQueue(file);
    expect(fresh.size).toBe(2); // requeue moved it back, never duplicated it
    expect(fresh.take()?.seq).toBe(1);
  });

  test("requeue wakes a parked waiter", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    const event = q.take() as QueuedEvent;
    const got: QueuedEvent[] = [];
    q.park((e) => got.push(e));
    q.requeue(event);
    expect(got.map((e) => e.seq)).toEqual([1]);
  });
});

describe("SessionQueue close (DELETE eviction)", () => {
  test("flush after close never touches disk: a late ack cannot recreate the removed file", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    const taken = q.take() as QueuedEvent;
    q.close();
    rmSync(file); // delete permanently removed the home session dir
    q.flush(taken); // the post-response ack callback fires late
    expect(existsSync(file)).toBe(false);
  });

  test("requeue after close is a no-op on disk", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    const taken = q.take() as QueuedEvent;
    q.close();
    rmSync(file);
    q.requeue(taken); // client aborted after wake, post-eviction
    expect(existsSync(file)).toBe(false);
  });
});

describe("SessionQueue closeWith (pending delete)", () => {
  const terminal: EventPayload = { event: "deleted", session: "otc_abc123" };

  test("wakes every parked waiter with the same terminal event and empties the waiter list", () => {
    const q = new SessionQueue(file);
    const got: EventPayload[] = [];
    q.park((e) => got.push(e.payload));
    q.park((e) => got.push(e.payload));
    q.closeWith(terminal);
    expect(got).toEqual([terminal, terminal]);
    expect(q.waiterCount).toBe(0);
  });

  test("persists nothing for the synthetic event — closed before it is handed out", () => {
    const q = new SessionQueue(file); // file does not exist yet
    q.park(() => {});
    q.closeWith(terminal);
    expect(existsSync(file)).toBe(false);
  });

  test("flush after closeWith never touches disk — a late ack cannot recreate the removed dir", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    const taken = q.take() as QueuedEvent;
    q.closeWith(terminal); // the pending delete woke the parked agent
    rmSync(file); // the working dir was hard-removed
    q.flush(taken); // the woken poll's post-response ack fires late
    expect(existsSync(file)).toBe(false);
  });

  test("no parked waiter: closeWith just closes (the agent finds out on its next call)", () => {
    const q = new SessionQueue(file);
    expect(() => q.closeWith(terminal)).not.toThrow();
    expect(q.waiterCount).toBe(0);
  });
});

describe("SessionQueue persistence", () => {
  test("events round-trip FIFO across instances", () => {
    const q1 = new SessionQueue(file);
    q1.enqueue(payload(1), 1);
    q1.enqueue(payload(2), 2);

    const q2 = new SessionQueue(file);
    expect(q2.size).toBe(2);
    const first = q2.take();
    expect(first?.payload).toEqual(payload(1));
    q2.flush(first as QueuedEvent);

    const q3 = new SessionQueue(file);
    expect(q3.size).toBe(1);
    expect(q3.take()?.payload).toEqual(payload(2));
  });

  test("a missing file means an empty queue", () => {
    const q = new SessionQueue(join(dir, "does-not-exist.json"));
    expect(q.size).toBe(0);
    expect(q.take()).toBeUndefined();
  });

  test("a corrupt events file is quarantined and the queue starts empty", () => {
    writeFileSync(file, "{not json");
    const q = new SessionQueue(file);
    expect(q.size).toBe(0);
    const aside = readdirSync(dir).filter((f) => f.startsWith("events.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] as string), "utf8")).toBe("{not json");
    // an empty file was re-seeded; the queue keeps working across instances
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, events: [] });
    q.enqueue(payload(1), 1);
    expect(new SessionQueue(file).size).toBe(1);
  });

  test("a queued envelope with a null payload is corrupt, not deliverable work", () => {
    writeFileSync(file, JSON.stringify({
      version: 1,
      events: [{ seq: 1, queuedAt: "2026-07-14T00:00:00.000Z", payload: null }],
    }));
    const q = new SessionQueue(file);
    expect(q.size).toBe(0);
    expect(q.hasPayload(() => true)).toBe(false);
  });

  test("wrong-shape events files are quarantined too", () => {
    writeFileSync(file, JSON.stringify({ version: 2, events: [] }));
    expect(new SessionQueue(file).size).toBe(0);
    writeFileSync(file, JSON.stringify({ version: 1 }));
    expect(new SessionQueue(file).size).toBe(0);
    expect(readdirSync(dir).filter((f) => f.startsWith("events.json.corrupt-"))).toHaveLength(2);
  });

  test("flush writes atomically and leaves no temp files behind", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    q.enqueue(payload(2), 2);
    expect(readdirSync(dir)).toEqual(["events.json"]);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.events).toHaveLength(2);
  });
});
