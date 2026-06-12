import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "../shared/types.js";
import { answerEntry, appendEntry, readTranscript } from "./transcript.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otacon-transcript-"));
  path = join(dir, "transcript.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(id: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { id, question: `question ${id}?`, askedAt: "2026-06-13T00:00:00.000Z", ...extra };
}

describe("readTranscript / appendEntry", () => {
  test("missing file reads as empty", () => {
    expect(readTranscript(path)).toEqual([]);
  });

  test("appends preserve order and full entry shape", () => {
    appendEntry(path, entry("q1", { options: ["A", "B"], recommend: "A" }));
    appendEntry(path, entry("q2", { options: ["X", "Y"], multi: true }));
    appendEntry(path, entry("q3"));
    const entries = readTranscript(path);
    expect(entries.map((e) => e.id)).toEqual(["q1", "q2", "q3"]);
    expect(entries[0]).toMatchObject({ options: ["A", "B"], recommend: "A" });
    expect(entries[1]?.multi).toBeTrue();
    expect(entries[2]?.options).toBeUndefined();
  });

  test("a corrupt file is quarantined and reads as empty, never throws", () => {
    writeFileSync(path, "{not json");
    expect(readTranscript(path)).toEqual([]);
    expect(existsSync(path)).toBeFalse();
    expect(readdirSync(dir).some((n) => n.startsWith("transcript.json.corrupt-"))).toBeTrue();
  });

  test("a JSON-valid file with a corrupt entry is quarantined too", () => {
    writeFileSync(path, JSON.stringify({ version: 1, entries: [{ id: 42 }] }));
    expect(readTranscript(path)).toEqual([]);
    expect(readdirSync(dir).some((n) => n.startsWith("transcript.json.corrupt-"))).toBeTrue();
  });
});

describe("answerEntry", () => {
  test("records the answer on the entry and persists it", () => {
    appendEntry(path, entry("q1", { options: ["A", "B"] }));
    const updated = answerEntry(path, "q1", {
      choice: "A",
      answeredAt: "2026-06-13T01:00:00.000Z",
    });
    expect(updated?.answer?.choice).toBe("A");
    expect(readTranscript(path)[0]?.answer?.choice).toBe("A");
  });

  test("unknown ids return undefined and write nothing", () => {
    appendEntry(path, entry("q1"));
    expect(answerEntry(path, "q9", { text: "x", answeredAt: "t" })).toBeUndefined();
    expect(readTranscript(path)[0]?.answer).toBeUndefined();
  });

  test("re-answering overwrites (at-least-once delivery)", () => {
    appendEntry(path, entry("q1", { options: ["A", "B"] }));
    answerEntry(path, "q1", { choice: "A", answeredAt: "t1" });
    answerEntry(path, "q1", { choice: "B", text: "changed my mind", answeredAt: "t2" });
    const stored = readTranscript(path)[0]?.answer;
    expect(stored).toEqual({ choice: "B", text: "changed my mind", answeredAt: "t2" });
  });
});
