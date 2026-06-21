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
  openCommentThreads,
  readThreads,
  resolveThread,
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
  test("records replies on comment threads and reports them changed", () => {
    appendThreads(path, [comment("t1"), comment("t2"), question("q1")]);
    const changed = applyRevisionToThreads(path, {
      plan: PLAN,
      replies: { t1: "tightened the goal" },
      revision: 2,
    });
    expect(changed.map((t) => t.id)).toContain("t1");
    const t1 = readThreads(path).find((t) => t.id === "t1");
    expect(t1?.kind === "comment" && t1.reply).toMatchObject({
      body: "tightened the goal",
      revision: 2,
    });
    // A reply is a response, not a close — the reviewer's `resolved` stays absent.
    expect(t1?.kind === "comment" && t1.resolved).toBeUndefined();
    // t2 has no reply and its anchor still resolves — untouched on disk.
    const t2 = readThreads(path).find((t) => t.id === "t2");
    expect(t2?.kind === "comment" && t2.reply).toBeUndefined();
    expect(t2?.anchorState).toBeUndefined();
  });

  test("re-replying overwrites the reply (at-least-once duplicates)", () => {
    appendThreads(path, [comment("t1")]);
    applyRevisionToThreads(path, { plan: PLAN, replies: { t1: "first" }, revision: 2 });
    applyRevisionToThreads(path, { plan: PLAN, replies: { t1: "second" }, revision: 3 });
    const t1 = readThreads(path).find((t) => t.id === "t1");
    expect(t1?.kind === "comment" && t1.reply).toMatchObject({ body: "second", revision: 3 });
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
  test("lists comment threads with replied + resolved flags; questions excluded", () => {
    appendThreads(path, [comment("t1"), comment("t2"), comment("t3"), question("q1")]);
    applyRevisionToThreads(path, { plan: PLAN, replies: { t2: "done" }, revision: 2 });
    resolveThread(path, "t3", true, 2);
    expect(commentThreadStates(path)).toEqual([
      { id: "t1", replied: false, resolved: false }, // open: owes a reply
      { id: "t2", replied: true, resolved: false }, // agent responded, not closed
      { id: "t3", replied: false, resolved: true }, // reviewer-withdrawn, no reply
    ]);
    expect(commentThreadStates(join(dir, "missing.json"))).toEqual([]);
  });
});

describe("resolveThread", () => {
  test("sets `resolved` (carrying the revision) and reports the thread changed", () => {
    appendThreads(path, [comment("t1"), comment("t2")]);
    const updated = resolveThread(path, "t1", true, 4);
    expect(updated?.kind === "comment" && updated.resolved).toMatchObject({ revision: 4 });
    expect(updated?.kind === "comment" && typeof updated.resolved?.at).toBe("string");
    const onDisk = readThreads(path).find((t) => t.id === "t1");
    expect(onDisk?.kind === "comment" && onDisk.resolved?.revision).toBe(4);
    // t2 untouched.
    expect(readThreads(path).find((t) => t.id === "t2")).toEqual(comment("t2"));
  });

  test("clears `resolved` on reopen (false)", () => {
    appendThreads(path, [comment("t1")]);
    resolveThread(path, "t1", true, 2);
    const reopened = resolveThread(path, "t1", false, 3);
    expect(reopened?.kind === "comment" && reopened.resolved).toBeUndefined();
    expect(readThreads(path).find((t) => t.id === "t1")?.kind === "comment").toBe(true);
    const onDisk = readThreads(path).find((t) => t.id === "t1");
    expect(onDisk?.kind === "comment" && onDisk.resolved).toBeUndefined();
  });

  test("resolves a question conversation root too", () => {
    appendThreads(path, [question("q1")]);
    const updated = resolveThread(path, "q1", true, 2);
    expect(updated?.kind === "question" && updated.resolved?.revision).toBe(2);
  });

  test("an unknown id returns undefined without writing", () => {
    appendThreads(path, [comment("t1")]);
    const before = readFileSync(path, "utf8");
    expect(resolveThread(path, "t9", true, 2)).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("openCommentThreads", () => {
  test("excludes replied and reviewer-resolved comments; keeps the bare open ones", () => {
    appendThreads(path, [comment("t1"), comment("t2"), comment("t3"), question("q1")]);
    applyRevisionToThreads(path, { plan: PLAN, replies: { t2: "done" }, revision: 2 });
    resolveThread(path, "t3", true, 2);
    const open = openCommentThreads(readThreads(path));
    expect(open.map((t) => t.id)).toEqual(["t1"]); // t2 replied, t3 resolved, q1 a question
  });

  test("a replied-then-resolved comment is also excluded", () => {
    appendThreads(path, [comment("t1")]);
    applyRevisionToThreads(path, { plan: PLAN, replies: { t1: "addressed" }, revision: 2 });
    resolveThread(path, "t1", true, 2);
    expect(openCommentThreads(readThreads(path))).toEqual([]);
  });
});

describe("thread validation of comment fields", () => {
  test("reply, resolved, and anchorState round-trip; bad shapes quarantine", () => {
    const closed: Thread = {
      ...(comment("t1") as Extract<Thread, { kind: "comment" }>),
      anchorState: "orphaned",
      reply: { body: "done", revision: 2, repliedAt: "2026-06-13T00:00:00.000Z" },
      resolved: { revision: 3, at: "2026-06-14T00:00:00.000Z" },
    };
    writeFileSync(path, JSON.stringify({ version: 1, threads: [closed] }));
    expect(readThreads(path)).toEqual([closed]);

    for (const bad of [
      { ...comment("t1"), anchorState: "lost" },
      { ...comment("t1"), reply: { body: "done" } },
      { ...comment("t1"), reply: { body: 7, revision: 2, repliedAt: "x" } },
      { ...comment("t1"), resolved: { revision: 2 } }, // resolved needs `at`
      { ...comment("t1"), resolved: { revision: "x", at: "y" } }, // revision must be a number
    ]) {
      writeFileSync(path, JSON.stringify({ version: 1, threads: [bad] }));
      expect(readThreads(path)).toEqual([]);
    }
  });

  test("a legacy `resolution` field loads (not quarantined) and reads back as `reply`", () => {
    // A pre-Phase-2 session stored the agent's response as `resolution:
    // {body, revision, resolvedAt}`. Read-normalization maps it onto `reply`.
    const legacy = {
      ...comment("t1"),
      resolution: { body: "addressed it", revision: 2, resolvedAt: "2026-06-13T00:00:00.000Z" },
    };
    writeFileSync(path, JSON.stringify({ version: 1, threads: [legacy] }));
    const t1 = readThreads(path).find((t) => t.id === "t1");
    expect(t1?.kind === "comment" && t1.reply).toEqual({
      body: "addressed it",
      revision: 2,
      repliedAt: "2026-06-13T00:00:00.000Z",
    });
    // The legacy field is dropped on the normalized read.
    expect(t1 && "resolution" in t1).toBe(false);
    // commentThreadStates sees the normalized reply (replied=true).
    expect(commentThreadStates(path)).toEqual([{ id: "t1", replied: true, resolved: false }]);
  });

  test("a legacy `resolution` thread re-writes as `reply` on disk (no dangling legacy field)", () => {
    // Any write-through path reads (and so normalizes) first, so the next atomic
    // write must persist `reply` and leave NO `resolution` behind on disk.
    const legacy = {
      ...comment("t1"),
      resolution: { body: "addressed it", revision: 2, resolvedAt: "2026-06-13T00:00:00.000Z" },
    };
    writeFileSync(path, JSON.stringify({ version: 1, threads: [legacy] }));
    resolveThread(path, "t1", true, 3); // a reviewer close triggers the re-write
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
      threads: Record<string, unknown>[];
    };
    const stored = onDisk.threads.find((t) => t.id === "t1");
    expect(stored && "resolution" in stored).toBe(false);
    expect(stored?.reply).toEqual({
      body: "addressed it",
      revision: 2,
      repliedAt: "2026-06-13T00:00:00.000Z",
    });
    expect(stored?.resolved).toMatchObject({ revision: 3 });
  });

  test("a follow-up question's replyTo round-trips; a non-string replyTo quarantines", () => {
    const followup: Thread = { ...(question("q2") as Extract<Thread, { kind: "question" }>), replyTo: "q1" };
    writeFileSync(path, JSON.stringify({ version: 1, threads: [question("q1"), followup] }));
    expect(readThreads(path)).toEqual([question("q1"), followup]);

    writeFileSync(path, JSON.stringify({ version: 1, threads: [{ ...question("q2"), replyTo: 7 }] }));
    expect(readThreads(path)).toEqual([]);
  });
});
