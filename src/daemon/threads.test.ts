import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "../shared/types.js";
import { answerQuestion, appendThreads, readThreads } from "./threads.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otacon-threads-"));
  path = join(dir, "threads.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const comment = (id: string, batch = "b1"): Thread => ({
  id,
  kind: "comment",
  batch,
  anchor: { section: "phase-1", exact: "RS256" },
  body: `comment ${id}`,
  createdAt: "2026-06-13T00:00:00.000Z",
});

const question = (id: string): Thread => ({
  id,
  kind: "question",
  anchor: null,
  body: `question ${id}`,
  createdAt: "2026-06-13T00:00:00.000Z",
});

describe("readThreads / appendThreads", () => {
  test("a missing file reads as no threads", () => {
    expect(readThreads(path)).toEqual([]);
  });

  test("appends accumulate in order and round-trip", () => {
    appendThreads(path, [comment("t1"), comment("t2")]);
    appendThreads(path, [question("q1")]);
    const threads = readThreads(path);
    expect(threads.map((t) => t.id)).toEqual(["t1", "t2", "q1"]);
    expect(threads[0]).toEqual(comment("t1"));
  });

  test("a corrupt file is quarantined and reads as empty, never throws", () => {
    writeFileSync(path, "{nope");
    expect(readThreads(path)).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith("threads.json.corrupt-"))).toBe(true);
    // The store keeps working after quarantine.
    appendThreads(path, [comment("t1")]);
    expect(readThreads(path)).toHaveLength(1);
  });

  test("a wrong-shape file is corrupt too", () => {
    writeFileSync(path, JSON.stringify({ version: 2, threads: "x" }));
    expect(readThreads(path)).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith("threads.json.corrupt-"))).toBe(true);
  });

  test("a JSON-valid file with a corrupt element is quarantined, not served", () => {
    // The envelope parses fine — the elements must be validated too, or a
    // null/garbage thread reaches answerQuestion (500) and the rail (crash).
    writeFileSync(path, JSON.stringify({ version: 1, threads: [null] }));
    expect(readThreads(path)).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith("threads.json.corrupt-"))).toBe(true);
  });

  test("element validation rejects wrong field types and unknown kinds", () => {
    const bad = [
      { ...comment("t1"), body: 7 }, // body must be a string
      { ...comment("t1"), kind: "review" }, // unknown kind
      { ...question("q1"), answer: { body: "x" } }, // answer missing answeredAt
      { ...comment("t1"), anchor: { exact: "x" } }, // anchor needs a section
    ];
    for (const thread of bad) {
      writeFileSync(path, JSON.stringify({ version: 1, threads: [thread] }));
      expect(readThreads(path)).toEqual([]);
    }
    // And a valid file with every shape passes untouched.
    const good = [comment("t1"), question("q1"), { ...question("q2"), answer: { body: "a", answeredAt: "2026-06-13T00:00:00.000Z" } }];
    writeFileSync(path, JSON.stringify({ version: 1, threads: good }));
    expect(readThreads(path)).toEqual(good as Thread[]);
  });
});

describe("answerQuestion", () => {
  test("records the answer on the question thread, durably", () => {
    appendThreads(path, [comment("t1"), question("q1")]);
    const updated = answerQuestion(path, "q1", "because RS256 allows key rotation");
    expect(updated?.kind).toBe("question");
    expect(updated?.kind === "question" && updated.answer?.body).toBe(
      "because RS256 allows key rotation",
    );
    const onDisk = readThreads(path).find((t) => t.id === "q1");
    expect(onDisk?.kind === "question" && onDisk.answer?.body).toBe(
      "because RS256 allows key rotation",
    );
    // Comment thread untouched.
    expect(readThreads(path).find((t) => t.id === "t1")).toEqual(comment("t1"));
  });

  test("unknown ids and comment ids return undefined without writing", () => {
    appendThreads(path, [comment("t1"), question("q1")]);
    const before = readFileSync(path, "utf8");
    expect(answerQuestion(path, "q9", "x")).toBeUndefined();
    expect(answerQuestion(path, "t1", "x")).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("re-answering overwrites (at-least-once duplicates are a shrug)", () => {
    appendThreads(path, [question("q1")]);
    answerQuestion(path, "q1", "first");
    const updated = answerQuestion(path, "q1", "second");
    expect(updated?.kind === "question" && updated.answer?.body).toBe("second");
  });
});
