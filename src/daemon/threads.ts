// Per-session thread persistence: .otacon/<id>/threads.json holds every
// comment and question thread so the review UI's rail can render the whole
// conversation on any load (DESIGN.md §9, §12) — the event queue drains, so
// it cannot be the rail's source. Same storage posture as the rest of the
// daemon: atomic writes, corrupt files quarantined and rebuilt empty, never
// fatal (DECISIONS.md "Threads: one threads.json per session").

import { existsSync } from "node:fs";
import type { Anchor, Thread, ThreadsFile } from "../shared/types.js";
import { quarantineCorruptFile, readJsonOr, stringify, writeFileAtomic } from "./store.js";

type QuestionThread = Extract<Thread, { kind: "question" }>;
type AnsweredThread = QuestionThread & { answer: NonNullable<QuestionThread["answer"]> };

function isAnchor(raw: unknown): raw is Anchor | null {
  if (raw === null) return true;
  const anchor = raw as Anchor;
  return typeof anchor === "object" && typeof anchor.section === "string";
}

function isThread(raw: unknown): raw is Thread {
  const thread = raw as Thread;
  if (typeof thread !== "object" || thread === null) return false;
  if (typeof thread.id !== "string" || typeof thread.body !== "string") return false;
  if (typeof thread.createdAt !== "string" || !isAnchor(thread.anchor)) return false;
  if (thread.kind === "comment") return typeof thread.batch === "string";
  if (thread.kind === "question") {
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
  return valid ? file : undefined;
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
