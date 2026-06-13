import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendActivity, latestNote, readActivity } from "./activity.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otacon-activity-"));
  path = join(dir, "activity.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Distinct ISO stamps so order is observable. */
const at = (n: number) => `2026-06-13T00:00:${String(n).padStart(2, "0")}.000Z`;

describe("readActivity / appendActivity", () => {
  test("missing file reads as empty and has no latest note", () => {
    expect(readActivity(path)).toEqual([]);
    expect(latestNote(path)).toBeUndefined();
  });

  test("appends preserve order, oldest first; latestNote is the newest", () => {
    appendActivity(path, "reading auth module", 20, at(1));
    appendActivity(path, "drafting plan", 20, at(2));
    appendActivity(path, "revising for b3", 20, at(3));
    expect(readActivity(path).map((n) => n.text)).toEqual([
      "reading auth module",
      "drafting plan",
      "revising for b3",
    ]);
    expect(latestNote(path)).toEqual({ at: at(3), text: "revising for b3" });
  });

  test("the cap keeps only the newest N, dropping the oldest", () => {
    for (let i = 1; i <= 25; i++) appendActivity(path, `note ${i}`, 20, at(i));
    const notes = readActivity(path);
    expect(notes).toHaveLength(20);
    expect(notes[0]?.text).toBe("note 6"); // 1..5 dropped
    expect(notes[notes.length - 1]?.text).toBe("note 25");
  });

  test("appendActivity returns the appended note", () => {
    expect(appendActivity(path, "hello", 20, at(1))).toEqual({ at: at(1), text: "hello" });
  });

  test("a corrupt file is quarantined and reads as empty, never throws", () => {
    writeFileSync(path, "{not json");
    expect(readActivity(path)).toEqual([]);
    expect(existsSync(path)).toBeFalse();
    expect(readdirSync(dir).some((n) => n.startsWith("activity.json.corrupt-"))).toBeTrue();
  });

  test("a JSON-valid file with a corrupt note is quarantined too", () => {
    writeFileSync(path, JSON.stringify({ version: 1, notes: [{ at: 42 }] }));
    expect(readActivity(path)).toEqual([]);
    expect(readdirSync(dir).some((n) => n.startsWith("activity.json.corrupt-"))).toBeTrue();
  });
});
