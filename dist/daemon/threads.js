// Per-session thread persistence: .otacon/<id>/threads.json holds every
// comment and question thread so the review UI's rail can render the whole
// conversation on any load (DESIGN.md §9, §12) — the event queue drains, so
// it cannot be the rail's source. Same storage posture as the rest of the
// daemon: atomic writes, corrupt files quarantined and rebuilt empty, never
// fatal (DECISIONS.md "Threads: one threads.json per session").
import { existsSync } from "node:fs";
import { relocateAnchor } from "./anchor.js";
import { segmentPlan } from "./diff.js";
import { quarantineCorruptFile, readJsonOr, stringify, writeFileAtomic } from "./store.js";
function isAnchor(raw) {
    if (raw === null)
        return true;
    const anchor = raw;
    return typeof anchor === "object" && typeof anchor.section === "string";
}
function isThread(raw) {
    const thread = raw;
    if (typeof thread !== "object" || thread === null)
        return false;
    if (typeof thread.id !== "string" || typeof thread.body !== "string")
        return false;
    if (typeof thread.createdAt !== "string" || !isAnchor(thread.anchor))
        return false;
    if (thread.anchorState !== undefined && thread.anchorState !== "orphaned")
        return false;
    if (thread.kind === "comment") {
        if (typeof thread.batch !== "string")
            return false;
        const { resolution } = thread;
        if (resolution === undefined)
            return true;
        return (typeof resolution === "object" &&
            resolution !== null &&
            typeof resolution.body === "string" &&
            typeof resolution.revision === "number" &&
            typeof resolution.resolvedAt === "string");
    }
    if (thread.kind === "question") {
        const { answer } = thread;
        if (answer === undefined)
            return true;
        return (typeof answer === "object" &&
            answer !== null &&
            typeof answer.body === "string" &&
            typeof answer.answeredAt === "string");
    }
    return false;
}
// Every element is validated, not just the envelope: a JSON-valid file with a
// corrupt element would otherwise flow a non-Thread into answerQuestion (500)
// and the rail (render crash) — exactly the "never fatal" failures quarantine
// exists to absorb.
function parseThreads(raw) {
    const file = raw;
    const valid = typeof file === "object" &&
        file !== null &&
        file.version === 1 &&
        Array.isArray(file.threads) &&
        file.threads.every(isThread);
    return valid ? file : undefined;
}
/** All threads, oldest first. Missing file = no threads yet; corrupt = quarantined, []. */
export function readThreads(path) {
    if (!existsSync(path))
        return [];
    const file = parseThreads(readJsonOr(path));
    if (!file) {
        quarantineCorruptFile(path, "threads file");
        return [];
    }
    return file.threads;
}
/** Durably append new threads (a comment batch's items, or one question). */
export function appendThreads(path, threads) {
    const file = { version: 1, threads: [...readThreads(path), ...threads] };
    writeFileAtomic(path, stringify(file));
}
/**
 * Record the agent's answer on a question thread; returns the updated thread,
 * or undefined when no question with that id exists (comment ids included —
 * comments are resolved via resubmit, never answered). Re-answering
 * overwrites: at-least-once delivery means the agent may legitimately answer
 * the same question twice, and the newer text is the better one.
 */
export function answerQuestion(path, id, body) {
    const threads = readThreads(path);
    const thread = threads.find((t) => t.id === id && t.kind === "question");
    if (!thread)
        return undefined;
    const answer = { body, answeredAt: new Date().toISOString() };
    thread.answer = answer;
    writeFileAtomic(path, stringify({ version: 1, threads }));
    return { ...thread, answer };
}
/**
 * Apply an accepted revision to the threads file, in one read + one atomic
 * write: record the resolution replies on their comment threads (lint L5 has
 * already vouched for them; re-resolving overwrites — at-least-once), then
 * re-locate every thread's anchor in the new plan (DESIGN.md §4) — lost or
 * ambiguous quotes turn anchorState "orphaned", re-found ones recover.
 * Returns the threads that changed, for the daemon's SSE `thread` upserts.
 */
export function applyRevisionToThreads(path, opts) {
    const threads = readThreads(path);
    if (threads.length === 0)
        return [];
    const changed = new Map();
    const resolvedAt = new Date().toISOString();
    // Segment the new plan once for the whole pass (lazily — a rail of
    // whole-plan threads never needs it), not per anchored thread.
    let units;
    for (const thread of threads) {
        if (thread.kind === "comment" && opts.replies[thread.id] !== undefined) {
            thread.resolution = {
                body: opts.replies[thread.id],
                revision: opts.revision,
                resolvedAt,
            };
            changed.set(thread.id, thread);
        }
        if (thread.anchor === null)
            continue; // whole-plan threads have no place to lose
        const result = relocateAnchor(thread.anchor, opts.plan, (units ??= segmentPlan(opts.plan)));
        if (result.state === "orphaned") {
            if (thread.anchorState !== "orphaned") {
                thread.anchorState = "orphaned";
                changed.set(thread.id, thread);
            }
        }
        else {
            const moved = JSON.stringify(result.anchor) !== JSON.stringify(thread.anchor);
            if (thread.anchorState === "orphaned" || moved) {
                delete thread.anchorState;
                thread.anchor = result.anchor;
                changed.set(thread.id, thread);
            }
        }
    }
    if (changed.size > 0) {
        writeFileAtomic(path, stringify({ version: 1, threads }));
    }
    return [...changed.values()];
}
/** Comment threads with their resolved state — the daemon's L5 context input. */
export function commentThreadStates(path) {
    return readThreads(path)
        .filter((t) => t.kind === "comment")
        .map((t) => ({ id: t.id, resolved: t.resolution !== undefined }));
}
//# sourceMappingURL=threads.js.map