import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "../shared/types.js";
import {
  answerQuestion,
  appendThreads,
  applyRevisionToThreads,
  commentThreadStates,
  readThreads,
} from "./threads.js";

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

const PLAN = `---
title: t
session: otc_test01
revision: 2
status: in_review
created: 2026-06-13
---

## Summary

Ship it.

## Decisions

- D1: RS256 over HS256 ← q1

## Phases

### Phase 1 — Build

Goal: Use RS256 for signing.
Files:
- a.ts
Verification: tests

## Risks

- r1

## Open Questions
`;

describe("applyRevisionToThreads", () => {
  test("records resolutions on comment threads and reports them changed", () => {
    appendThreads(path, [comment("t1"), comment("t2"), question("q1")]);
    const changed = applyRevisionToThreads(path, {
      plan: PLAN,
      replies: { t1: "tightened the goal" },
      revision: 2,
    });
    expect(changed.map((t) => t.id)).toContain("t1");
    const t1 = readThreads(path).find((t) => t.id === "t1");
    expect(t1?.kind === "comment" && t1.resolution).toMatchObject({
      body: "tightened the goal",
      revision: 2,
    });
    // t2 has no reply and its anchor still resolves — untouched on disk.
    const t2 = readThreads(path).find((t) => t.id === "t2");
    expect(t2?.kind === "comment" && t2.resolution).toBeUndefined();
    expect(t2?.anchorState).toBeUndefined();
  });

  test("re-resolving overwrites the reply (at-least-once duplicates)", () => {
    appendThreads(path, [comment("t1")]);
    applyRevisionToThreads(path, { plan: PLAN, replies: { t1: "first" }, revision: 2 });
    applyRevisionToThreads(path, { plan: PLAN, replies: { t1: "second" }, revision: 3 });
    const t1 = readThreads(path).find((t) => t.id === "t1");
    expect(t1?.kind === "comment" && t1.resolution).toMatchObject({ body: "second", revision: 3 });
  });

  test("a lost quote orphans the thread; a reappearing one recovers it", () => {
    appendThreads(path, [comment("t1")]); // quotes "RS256" in phase-1
    const withoutQuote = PLAN.replaceAll("RS256", "ES256");
    let changed = applyRevisionToThreads(path, { plan: withoutQuote, replies: {}, revision: 2 });
    expect(changed.map((t) => t.id)).toEqual(["t1"]);
    expect(readThreads(path)[0]?.anchorState).toBe("orphaned");

    // The next revision restores the text — the thread leaves the tray.
    changed = applyRevisionToThreads(path, { plan: PLAN, replies: {}, revision: 3 });
    expect(changed.map((t) => t.id)).toEqual(["t1"]);
    expect(readThreads(path)[0]?.anchorState).toBeUndefined();
  });

  test("question threads re-anchor too; whole-plan threads never orphan", () => {
    appendThreads(path, [
      { ...question("q1"), anchor: { section: "phase-1", exact: "RS256" } },
      question("q2"), // anchor: null
    ]);
    const changed = applyRevisionToThreads(path, {
      plan: PLAN.replaceAll("RS256", "ES256"),
      replies: {},
      revision: 2,
    });
    expect(changed.map((t) => t.id)).toEqual(["q1"]);
    expect(readThreads(path).find((t) => t.id === "q1")?.anchorState).toBe("orphaned");
    expect(readThreads(path).find((t) => t.id === "q2")?.anchorState).toBeUndefined();
  });

  test("a moved quote rewrites the anchor's section and reports the thread", () => {
    appendThreads(path, [comment("t1")]); // anchored in phase-1, quotes "RS256"
    const moved = PLAN.replace("Goal: Use RS256 for signing.", "Goal: Use Ed25519 for signing.");
    const changed = applyRevisionToThreads(path, { plan: moved, replies: {}, revision: 2 });
    expect(changed.map((t) => t.id)).toEqual(["t1"]);
    const t1 = readThreads(path).find((t) => t.id === "t1");
    expect(t1?.anchor?.section).toBe("decisions"); // the only remaining "RS256"
    expect(t1?.anchorState).toBeUndefined();
  });

  test("no threads, or nothing changed: no write, empty result", () => {
    expect(applyRevisionToThreads(path, { plan: PLAN, replies: {}, revision: 2 })).toEqual([]);
    appendThreads(path, [comment("t1")]);
    const before = readFileSync(path, "utf8");
    expect(applyRevisionToThreads(path, { plan: PLAN, replies: {}, revision: 2 })).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("commentThreadStates", () => {
  test("lists comment threads with resolved flags; questions excluded", () => {
    appendThreads(path, [comment("t1"), comment("t2"), question("q1")]);
    applyRevisionToThreads(path, { plan: PLAN, replies: { t2: "done" }, revision: 2 });
    expect(commentThreadStates(path)).toEqual([
      { id: "t1", resolved: false },
      { id: "t2", resolved: true },
    ]);
    expect(commentThreadStates(join(dir, "missing.json"))).toEqual([]);
  });
});

describe("thread validation of M3 fields", () => {
  test("resolution and anchorState round-trip; bad shapes quarantine", () => {
    const resolved: Thread = {
      ...(comment("t1") as Extract<Thread, { kind: "comment" }>),
      anchorState: "orphaned",
      resolution: { body: "done", revision: 2, resolvedAt: "2026-06-13T00:00:00.000Z" },
    };
    writeFileSync(path, JSON.stringify({ version: 1, threads: [resolved] }));
    expect(readThreads(path)).toEqual([resolved]);

    for (const bad of [
      { ...comment("t1"), anchorState: "lost" },
      { ...comment("t1"), resolution: { body: "done" } },
      { ...comment("t1"), resolution: { body: 7, revision: 2, resolvedAt: "x" } },
    ]) {
      writeFileSync(path, JSON.stringify({ version: 1, threads: [bad] }));
      expect(readThreads(path)).toEqual([]);
    }
  });
});
