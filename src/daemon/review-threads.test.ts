import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewThread } from "../shared/types.js";
import {
  createReviewThread,
  publicReviewThreads,
  readReviewThreads,
  requestReviewCodeAction,
  respondToReviewThread,
  ReviewThreadConflictError,
  updateReviewCodeAction,
} from "./review-threads.js";

let dir = "";
let path = "";

const question = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "q1",
  surface: "review",
  intent: "question",
  anchor: { section: "background", exact: "moving target", prefix: "a ", suffix: " report" },
  body: "What makes it move?",
  createdAt: "2026-07-15T10:00:00.000Z",
  identity: { session: "otc_review", reportRevision: 2, headRevision: 1, headSha: "a".repeat(40) },
  idempotencyKey: "create-q1",
  ...overrides,
});

const comment = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  ...question(),
  id: "t1",
  intent: "comment",
  body: "Keep this boundary explicit.",
  idempotencyKey: "create-t1",
  remember: { scope: "project" },
  ...overrides,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otacon-review-threads-"));
  path = join(dir, "threads.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("review thread persistence", () => {
  test("persists a strict v2 envelope and projects away the retry key", () => {
    createReviewThread(path, question());
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 2, threads: [{ id: "q1" }] });
    expect(publicReviewThreads(path)[0]).not.toHaveProperty("idempotencyKey");
    expect(publicReviewThreads(path)[0]?.anchor).toEqual(question().anchor);
  });

  test("dedupes an exact create but rejects reuse for different work", () => {
    expect(createReviewThread(path, question()).repeated).toBe(false);
    expect(createReviewThread(path, question({ createdAt: "2026-07-15T10:00:01.000Z", id: "q9" })).repeated).toBe(true);
    expect(() => createReviewThread(path, question({ body: "different" }))).toThrow(ReviewThreadConflictError);
    expect(readReviewThreads(path)).toHaveLength(1);
  });

  test("quarantines malformed entries instead of leaking them into the SSE", () => {
    writeFileSync(path, JSON.stringify({ version: 2, threads: [{ ...question(), anchor: { section: "background" } }] }));
    expect(readReviewThreads(path)).toEqual([]);
    expect(readdirSync(dir).some((name) => name.startsWith("threads.json.corrupt-"))).toBe(true);
  });

  test("quarantines mixed or unexpected session identity instead of crossing review boundaries", () => {
    writeFileSync(path, JSON.stringify({
      version: 2,
      threads: [question(), comment({ identity: { ...comment().identity, session: "otc_other1" } })],
    }));
    expect(readReviewThreads(path)).toEqual([]);

    path = join(dir, "unexpected-session.json");
    writeFileSync(path, JSON.stringify({ version: 2, threads: [question()] }));
    expect(publicReviewThreads(path, "otc_other1")).toEqual([]);
  });

  test("rejects unknown nested fields, malformed timestamps, identities, and oversized input", () => {
    const cases = [
      { ...question(), unexpected: true },
      { ...question(), createdAt: "2026-07-15" },
      { ...question(), identity: { ...question().identity, session: "not-a-session" } },
      { ...question(), identity: { ...question().identity, headSha: "abc" } },
      { ...question(), anchor: { ...question().anchor, surprise: "x" } },
      { ...question(), remember: { scope: "project", surprise: true } },
      { ...question(), body: "x".repeat(20_001) },
      { ...comment(), response: { body: "done", respondedAt: "2026-07-15T10:01:00.000Z", reportRevision: 2 } },
      { ...comment(), saved: { scope: "project", savedAt: "2026-07-15T10:01:00.000Z" } },
      { ...comment(), codeAction: { status: "working", requestedAt: "2026-07-15T10:01:00.000Z", updatedAt: "2026-07-15T10:00:30.000Z" } },
    ];
    for (const [index, raw] of cases.entries()) {
      writeFileSync(path, JSON.stringify({ version: 2, threads: [raw] }));
      expect(readReviewThreads(path)).toEqual([]);
      path = join(dir, `threads-${index}.json`);
    }
  });

  test("records a response and only acknowledges the requested memory scope", () => {
    createReviewThread(path, comment());
    const result = respondToReviewThread(path, "t1", {
      body: "Clarified in the next report.",
      reportRevision: 3,
      saved: { scope: "project", updated: true },
    }, "2026-07-15T10:10:00.000Z");
    expect(result.thread).toMatchObject({
      response: { body: "Clarified in the next report.", reportRevision: 3 },
      saved: { scope: "project" },
    });
    expect(respondToReviewThread(path, "t1", {
      body: "Clarified in the next report.", reportRevision: 3, saved: { scope: "project", updated: true },
    }, "2026-07-15T10:11:00.000Z").repeated).toBe(true);
    expect(() => respondToReviewThread(path, "t1", {
      body: "Clarified in the next report.", reportRevision: 3, saved: { scope: "user", updated: true },
    }, "2026-07-15T10:12:00.000Z")).toThrow(/scope/);
  });

  test("never shows a memory receipt without the agent acknowledgement", () => {
    createReviewThread(path, comment());
    expect(publicReviewThreads(path)[0]).not.toHaveProperty("saved");
  });

  test("questions cannot conduct code changes; comments transition idempotently", () => {
    createReviewThread(path, question());
    createReviewThread(path, comment());
    expect(() => requestReviewCodeAction(path, "q1", "2026-07-15T10:20:00.000Z")).toThrow(/Comment/);
    expect(requestReviewCodeAction(path, "t1", "2026-07-15T10:20:00.000Z").repeated).toBe(false);
    expect(requestReviewCodeAction(path, "t1", "2026-07-15T10:21:00.000Z").repeated).toBe(true);
    expect(updateReviewCodeAction(path, "t1", { status: "working" }, "2026-07-15T10:22:00.000Z").thread.codeAction?.status).toBe("working");
    expect(updateReviewCodeAction(path, "t1", { status: "completed", message: "pushed abc" }, "2026-07-15T10:23:00.000Z").thread.codeAction).toMatchObject({ status: "completed", message: "pushed abc" });
    expect(() => updateReviewCodeAction(path, "t1", { status: "failed" }, "2026-07-15T10:24:00.000Z")).toThrow(/terminal/);
  });

  test("question answers reject report revisions and comments require one", () => {
    createReviewThread(path, question());
    createReviewThread(path, comment());
    expect(() => respondToReviewThread(path, "q1", { body: "answer", reportRevision: 3 }, "2026-07-15T10:00:00.000Z")).toThrow(/cannot claim/);
    expect(() => respondToReviewThread(path, "t1", { body: "response" }, "2026-07-15T10:00:00.000Z")).toThrow(/must identify/);
  });
});
