import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "../../shared/types.js";
import { appendStreamEvents, readStream, StreamSeq } from "./stream-store.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otacon-stream-"));
  path = join(dir, "stream.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const at = (n: number) => `2026-06-21T00:00:${String(n).padStart(2, "0")}.000Z`;

/** A minimal valid event; seq/at vary per call so order is observable. */
function ev(seq: number, label = `event ${seq}`): StreamEvent {
  return { seq, at: at(seq % 60), kind: "highlight", label };
}

describe("readStream / appendStreamEvents", () => {
  test("missing file reads as empty, never throws", () => {
    expect(readStream(path)).toEqual([]);
  });

  test("appends preserve order, oldest first; one event per line", () => {
    appendStreamEvents(path, [ev(1), ev(2)], 2000);
    appendStreamEvents(path, [ev(3)], 2000);
    expect(readStream(path).map((e) => e.seq)).toEqual([1, 2, 3]);
    // Exactly three JSONL lines (+ trailing newline → one empty split).
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3);
  });

  test("appendStreamEvents returns the events as appended", () => {
    const events = [ev(1), ev(2)];
    expect(appendStreamEvents(path, events, 2000)).toBe(events);
  });

  test("an empty batch is a no-op (no file written)", () => {
    appendStreamEvents(path, [], 2000);
    expect(existsSync(path)).toBeFalse();
  });

  test("past the cap, only the newest N persist, each keeping its monotonic seq", () => {
    // Append one at a time (the high-frequency path) past the cap.
    for (let i = 1; i <= 25; i++) appendStreamEvents(path, [ev(i)], 20);
    const events = readStream(path);
    expect(events).toHaveLength(20);
    expect(events[0]?.seq).toBe(6); // 1..5 dropped
    expect(events[events.length - 1]?.seq).toBe(25);
    // Strictly monotonic across the survivors.
    for (let i = 1; i < events.length; i++) {
      expect((events[i] as StreamEvent).seq).toBeGreaterThan((events[i - 1] as StreamEvent).seq);
    }
  });

  test("a batch that overflows the cap in one call trims to the newest N", () => {
    appendStreamEvents(
      path,
      Array.from({ length: 30 }, (_, i) => ev(i + 1)),
      10,
    );
    const events = readStream(path);
    expect(events.map((e) => e.seq)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  });

  test("cap <= 0 keeps everything", () => {
    for (let i = 1; i <= 5; i++) appendStreamEvents(path, [ev(i)], 0);
    expect(readStream(path)).toHaveLength(5);
  });

  test("readStream(limit) returns only the newest N", () => {
    appendStreamEvents(path, [ev(1), ev(2), ev(3), ev(4)], 2000);
    expect(readStream(path, 2).map((e) => e.seq)).toEqual([3, 4]);
  });

  test("corrupt and blank lines are skipped, the good ones survive (never throws)", () => {
    appendStreamEvents(path, [ev(1)], 2000);
    appendFileSync(path, "{not json\n");
    appendFileSync(path, "\n"); // blank line
    appendFileSync(path, JSON.stringify({ seq: "nope", at: at(2), kind: "text", label: "x" }) + "\n");
    appendFileSync(path, JSON.stringify({ seq: 9, at: at(3), kind: "bogus", label: "y" }) + "\n");
    appendStreamEvents(path, [ev(2)], 2000);
    expect(readStream(path).map((e) => e.seq)).toEqual([1, 2]);
  });

  test("a torn (incomplete) final line is skipped, not fatal", () => {
    appendStreamEvents(path, [ev(1)], 2000);
    appendFileSync(path, '{"seq":2,"at":"'); // truncated mid-write
    expect(readStream(path).map((e) => e.seq)).toEqual([1]);
  });
});

describe("StreamSeq", () => {
  test("mints a strictly increasing sequence", () => {
    const seq = new StreamSeq();
    expect(seq.next(path)).toBe(1);
    expect(seq.next(path)).toBe(2);
    expect(seq.next(path)).toBe(3);
  });

  test("seeds from the file's max seq on first use (survives a restart)", () => {
    appendStreamEvents(path, [ev(5), ev(7), ev(6)], 2000);
    const seq = new StreamSeq(); // a fresh daemon lifetime
    expect(seq.next(path)).toBe(8); // max(5,7,6) + 1
    expect(seq.next(path)).toBe(9);
  });

  test("seeds at 0 for a missing file", () => {
    expect(new StreamSeq().next(join(dir, "nope.jsonl"))).toBe(1);
  });

  test("ignores a corrupt file when seeding (treats as no events)", () => {
    writeFileSync(path, "{garbage\nmore garbage\n");
    expect(new StreamSeq().next(path)).toBe(1);
  });
});
