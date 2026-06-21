// Per-session thread persistence: .otacon/<id>/threads.json holds every
// comment and question thread so the review UI's rail can render the whole
// conversation on any load (threaded review and revision, approval and archive lifecycle) — the event queue drains, so
// it cannot be the rail's source. Same storage posture as the rest of the
// daemon: atomic writes, corrupt files quarantined and rebuilt empty, never
// fatal (DECISIONS.md "Threads: one threads.json per session").

import { existsSync } from "node:fs";
import type { Anchor, Thread, ThreadsFile } from "../shared/types.js";
import { relocateAnchor } from "./anchor.js";
import type { PlanUnit } from "./diff.js";
import { segmentPlan } from "./diff.js";
import { quarantineCorruptFile, readJsonOr, stringify, writeFileAtomic } from "./store.js";

type CommentThread = Extract<Thread, { kind: "comment" }>;
type QuestionThread = Extract<Thread, { kind: "question" }>;
type AnsweredThread = QuestionThread & { answer: NonNullable<QuestionThread["answer"]> };

function isAnchor(raw: unknown): raw is Anchor | null {
  if (raw === null) return true;
  const anchor = raw as Anchor;
  return typeof anchor === "object" && typeof anchor.section === "string";
}

/** The reviewer-close stamp (`resolved`) on either thread variant; absent = open. */
function isResolved(raw: unknown): boolean {
  if (raw === undefined) return true;
  const resolved = raw as { revision: unknown; at: unknown };
  return (
    typeof resolved === "object" &&
    resolved !== null &&
    typeof resolved.revision === "number" &&
    typeof resolved.at === "string"
  );
}

function isThread(raw: unknown): raw is Thread {
  const thread = raw as Thread & {
    resolution?: unknown; // legacy field — tolerated, normalized to `reply` on read
  };
  if (typeof thread !== "object" || thread === null) return false;
  if (typeof thread.id !== "string" || typeof thread.body !== "string") return false;
  if (typeof thread.createdAt !== "string" || !isAnchor(thread.anchor)) return false;
  if (thread.anchorState !== undefined && thread.anchorState !== "orphaned") return false;
  if (thread.kind === "comment") {
    if (typeof thread.batch !== "string") return false;
    if (thread.replyTo !== undefined && typeof thread.replyTo !== "string") return false;
    if (!isResolved(thread.resolved)) return false;
    // A leftover legacy `resolution` (an old-code in-flight session, normalized
    // to `reply` in normalizeThread) is tolerated with the new `reply` shape.
    const reply = thread.reply ?? (thread.resolution as CommentThread["reply"] | undefined);
    if (reply === undefined) return true;
    return (
      typeof reply === "object" &&
      reply !== null &&
      typeof reply.body === "string" &&
      typeof reply.revision === "number" &&
      // accept either the new `repliedAt` or the legacy `resolvedAt`
      (typeof (reply as { repliedAt?: unknown }).repliedAt === "string" ||
        typeof (reply as unknown as { resolvedAt?: unknown }).resolvedAt === "string")
    );
  }
  if (thread.kind === "question") {
    if (thread.replyTo !== undefined && typeof thread.replyTo !== "string") return false;
    if (!isResolved(thread.resolved)) return false;
    const { answer } = thread;
    if (answer === undefined) return true;
    return (
      typeof answer === "object" &&
      answer !== null &&
      typeof answer.body === "string" &&
      typeof answer.answeredAt === "string"
    );
  }
  return false;
}

/**
 * Read-path normalization: an in-flight session written by the pre-Phase-2 code
 * stores the agent's response as `resolution: {body, revision, resolvedAt}`. Map
 * it onto the current `reply: {body, revision, repliedAt}` so the old session is
 * never quarantined (and the rest of the daemon only ever sees `reply`).
 */
function normalizeThread(thread: Thread): Thread {
  const legacy = thread as Thread & {
    resolution?: { body: string; revision: number; resolvedAt: string };
  };
  if (thread.kind === "comment" && thread.reply === undefined && legacy.resolution !== undefined) {
    const { body, revision, resolvedAt } = legacy.resolution;
    thread.reply = { body, revision, repliedAt: resolvedAt };
    delete legacy.resolution;
  }
  return thread;
}

// Every element is validated, not just the envelope: a JSON-valid file with a
// corrupt element would otherwise flow a non-Thread into answerQuestion (500)
// and the rail (render crash) — exactly the "never fatal" failures quarantine
// exists to absorb.
function parseThreads(raw: unknown): ThreadsFile | undefined {
  const file = raw as ThreadsFile;
  const valid =
    typeof file === "object" &&
    file !== null &&
    file.version === 1 &&
    Array.isArray(file.threads) &&
    file.threads.every(isThread);
  // Normalize the legacy `resolution` field to `reply` post-validation, so an
  // in-flight old-code session reads (and re-writes) as the current shape.
  return valid ? { ...file, threads: file.threads.map(normalizeThread) } : undefined;
}

/** All threads, oldest first. Missing file = no threads yet; corrupt = quarantined, []. */
export function readThreads(path: string): Thread[] {
  if (!existsSync(path)) return [];
  const file = parseThreads(readJsonOr(path));
  if (!file) {
    quarantineCorruptFile(path, "threads file");
    return [];
  }
  return file.threads;
}

/** Durably append new threads (a comment batch's items, or one question). */
export function appendThreads(path: string, threads: Thread[]): void {
  const file: ThreadsFile = { version: 1, threads: [...readThreads(path), ...threads] };
  writeFileAtomic(path, stringify(file));
}

/**
 * Record the agent's answer on a question thread; returns the updated thread,
 * or undefined when no question with that id exists (comment ids included —
 * comments are resolved via resubmit, never answered). Re-answering
 * overwrites: at-least-once delivery means the agent may legitimately answer
 * the same question twice, and the newer text is the better one.
 */
export function answerQuestion(path: string, id: string, body: string): AnsweredThread | undefined {
  const threads = readThreads(path);
  const thread = threads.find(
    (t): t is QuestionThread => t.id === id && t.kind === "question",
  );
  if (!thread) return undefined;
  const answer = { body, answeredAt: new Date().toISOString() };
  thread.answer = answer;
  writeFileAtomic(path, stringify({ version: 1, threads } satisfies ThreadsFile));
  return { ...thread, answer };
}

/**
 * Apply an accepted revision to the threads file, in one read + one atomic
 * write: record the agent's replies on their comment threads (lint L5 has
 * already vouched for them; re-replying overwrites — at-least-once) — a reply is
 * a *response*, not a close (the reviewer closes via resolveThread) — then
 * re-locate every thread's anchor in the new plan (plan structure, lint, and anchoring) — lost or
 * ambiguous quotes turn anchorState "orphaned", re-found ones recover.
 * Returns the threads that changed, for the daemon's SSE `thread` upserts.
 */
export function applyRevisionToThreads(
  path: string,
  opts: { plan: string; replies: Record<string, string>; revision: number },
): Thread[] {
  const threads = readThreads(path);
  if (threads.length === 0) return [];
  const changed = new Map<string, Thread>();
  const repliedAt = new Date().toISOString();
  // Segment the new plan once for the whole pass (lazily — a rail of
  // whole-plan threads never needs it), not per anchored thread.
  let units: PlanUnit[] | undefined;

  for (const thread of threads) {
    if (thread.kind === "comment" && opts.replies[thread.id] !== undefined) {
      thread.reply = {
        body: opts.replies[thread.id] as string,
        revision: opts.revision,
        repliedAt,
      };
      changed.set(thread.id, thread);
    }
    if (thread.anchor === null) continue; // whole-plan threads have no place to lose
    const result = relocateAnchor(thread.anchor, opts.plan, (units ??= segmentPlan(opts.plan)));
    if (result.state === "orphaned") {
      if (thread.anchorState !== "orphaned") {
        thread.anchorState = "orphaned";
        changed.set(thread.id, thread);
      }
    } else {
      const moved = JSON.stringify(result.anchor) !== JSON.stringify(thread.anchor);
      if (thread.anchorState === "orphaned" || moved) {
        delete thread.anchorState;
        thread.anchor = result.anchor;
        changed.set(thread.id, thread);
      }
    }
  }

  if (changed.size > 0) {
    writeFileAtomic(path, stringify({ version: 1, threads } satisfies ThreadsFile));
  }
  return [...changed.values()];
}

/**
 * Set or clear the reviewer's close on a thread (the Resolve verb), in one read +
 * one atomic write: `resolved:true` stamps `{revision, at}` (pass the session's
 * current revision in), `false` clears it. Returns the updated thread, or
 * undefined when no thread with that id exists. Mirrors answerQuestion — at-least-
 * once delivery makes a duplicate resolve a shrug (re-stamps the same close).
 */
export function resolveThread(
  path: string,
  id: string,
  resolved: boolean,
  revision: number,
): Thread | undefined {
  const threads = readThreads(path);
  const thread = threads.find((t) => t.id === id);
  if (!thread) return undefined;
  if (resolved) thread.resolved = { revision, at: new Date().toISOString() };
  else delete thread.resolved;
  writeFileAtomic(path, stringify({ version: 1, threads } satisfies ThreadsFile));
  return thread;
}

/**
 * The reviewer-resolved comment conversation ROOTS — a comment thread carrying
 * `resolved` is a root (the Resolve verb lands on the root), so its id is what a
 * follow-up turn keys on. Resolving the root withdraws every turn of the
 * conversation at once.
 */
function resolvedCommentRoots(threads: Thread[]): Set<string> {
  return new Set(
    threads
      .filter((t): t is CommentThread => t.kind === "comment" && t.resolved !== undefined)
      .map((t) => t.id),
  );
}

/**
 * Per-comment-turn states L5 needs to skip a turn — the daemon's L5 context
 * input, one entry per comment thread (root or follow-up): `replied` (this turn
 * has an agent response) and `resolved` (the turn's CONVERSATION ROOT is
 * reviewer-closed). Resolving the root withdraws all its turns from L5 at once,
 * because a follow-up keys its `resolved` on `replyTo ?? id`. L5 demands a reply
 * only for a turn that is neither replied nor (root-)resolved.
 */
export function commentThreadStates(
  path: string,
): { id: string; replied: boolean; resolved: boolean }[] {
  const threads = readThreads(path);
  const resolvedRootIds = resolvedCommentRoots(threads);
  return threads
    .filter((t): t is CommentThread => t.kind === "comment")
    .map((t) => ({
      id: t.id,
      replied: t.reply !== undefined,
      resolved: resolvedRootIds.has(t.replyTo ?? t.id),
    }));
}

/**
 * The comment turns still owed a response — no agent `reply` on this turn AND the
 * turn's conversation root is not reviewer-`resolved` (a resolved/withdrawn
 * conversation owes nothing). This is what a **comment & approve** fold-in
 * sweeps: each is re-delivered to the agent in the `final:true` comments batch
 * and replayed into the committed `## Review notes`. Pure over an already-read
 * thread list so the approve handler reads disk once. Open *questions* are not
 * swept — they are answered via `otacon answer`, never folded into the plan, and
 * an open one at approve still drops as today.
 */
export function openCommentThreads(threads: Thread[]): CommentThread[] {
  const resolvedRootIds = resolvedCommentRoots(threads);
  return threads.filter(
    (t): t is CommentThread =>
      t.kind === "comment" &&
      t.reply === undefined &&
      !resolvedRootIds.has(t.replyTo ?? t.id),
  );
}
