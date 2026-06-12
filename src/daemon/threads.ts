// Per-session thread persistence: .otacon/<id>/threads.json holds every
// comment and question thread so the review UI's rail can render the whole
// conversation on any load (DESIGN.md §9, §12) — the event queue drains, so
// it cannot be the rail's source. Same storage posture as the rest of the
// daemon: atomic writes, corrupt files quarantined and rebuilt empty, never
// fatal (DECISIONS.md "Threads: one threads.json per session").

import { existsSync, readFileSync } from "node:fs";
import type { Thread, ThreadsFile } from "../shared/types.js";
import { quarantineCorruptFile, stringify, writeFileAtomic } from "./store.js";

function parseThreads(raw: unknown): ThreadsFile | undefined {
  const file = raw as ThreadsFile;
  const valid =
    typeof file === "object" &&
    file !== null &&
    file.version === 1 &&
    Array.isArray(file.threads);
  return valid ? file : undefined;
}

/** All threads, oldest first. Missing file = no threads yet; corrupt = quarantined, []. */
export function readThreads(path: string): Thread[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  const file = parseThreads(raw);
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
export function answerQuestion(path: string, id: string, body: string): Thread | undefined {
  const threads = readThreads(path);
  const thread = threads.find((t) => t.id === id && t.kind === "question");
  if (!thread || thread.kind !== "question") return undefined;
  thread.answer = { body, answeredAt: new Date().toISOString() };
  writeFileAtomic(path, stringify({ version: 1, threads } satisfies ThreadsFile));
  return thread;
}
