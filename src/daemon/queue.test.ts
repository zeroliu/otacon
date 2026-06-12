import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  test("take dequeues in memory only; disk keeps the event until flush", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    expect(q.take()?.seq).toBe(1);
    // Simulated crash before flush: a fresh instance re-delivers the event.
    expect(new SessionQueue(file).take()?.seq).toBe(1);
    q.flush();
    expect(new SessionQueue(file).size).toBe(0);
  });

  test("a woken waiter's event survives on disk until flush", () => {
    const q = new SessionQueue(file);
    q.park(() => {});
    q.enqueue(payload(1), 1);
    expect(q.size).toBe(0);
    expect(new SessionQueue(file).size).toBe(1);
    q.flush();
    expect(new SessionQueue(file).size).toBe(0);
  });

  test("requeue returns an undeliverable event to the head, durably", () => {
    const q = new SessionQueue(file);
    q.enqueue(payload(1), 1);
    q.enqueue(payload(2), 2);
    const event = q.take();
    expect(event?.seq).toBe(1);
    q.requeue(event as QueuedEvent);
    expect(q.size).toBe(2);
    expect(new SessionQueue(file).take()?.seq).toBe(1);
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

describe("SessionQueue persistence", () => {
  test("events round-trip FIFO across instances", () => {
    const q1 = new SessionQueue(file);
    q1.enqueue(payload(1), 1);
    q1.enqueue(payload(2), 2);

    const q2 = new SessionQueue(file);
    expect(q2.size).toBe(2);
    expect(q2.take()?.payload).toEqual(payload(1));
    q2.flush();

    const q3 = new SessionQueue(file);
    expect(q3.size).toBe(1);
    expect(q3.take()?.payload).toEqual(payload(2));
  });

  test("a missing file means an empty queue", () => {
    const q = new SessionQueue(join(dir, "does-not-exist.json"));
    expect(q.size).toBe(0);
    expect(q.take()).toBeUndefined();
  });

  test("a corrupt events file throws instead of silently dropping events", () => {
    writeFileSync(file, "{not json");
    expect(() => new SessionQueue(file)).toThrow(/corrupt events file/);
    writeFileSync(file, JSON.stringify({ version: 2, events: [] }));
    expect(() => new SessionQueue(file)).toThrow(/corrupt events file/);
    writeFileSync(file, JSON.stringify({ version: 1 }));
    expect(() => new SessionQueue(file)).toThrow(/corrupt events file/);
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
