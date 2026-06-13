// Per-session grill transcript: .otacon/<id>/transcript.json holds every
// agent question and the user's answer (DESIGN.md §8) — distinct from
// user-question threads (threads.json), because the Interview panel and the
// threads rail are different surfaces with different lifecycles, and the
// transcript ships with the approved artifact while threads stay review
// exhaust. Same storage posture as the rest of the daemon: atomic writes,
// corrupt files quarantined and rebuilt empty, never fatal.
import { existsSync } from "node:fs";
import { quarantineCorruptFile, readJsonOr, stringify, writeFileAtomic } from "./store.js";
function isAnswer(raw) {
    const answer = raw;
    if (typeof answer !== "object" || answer === null)
        return false;
    if (typeof answer.answeredAt !== "string")
        return false;
    if (answer.choice !== undefined && typeof answer.choice !== "string")
        return false;
    if (answer.choices !== undefined &&
        !(Array.isArray(answer.choices) && answer.choices.every((c) => typeof c === "string"))) {
        return false;
    }
    return answer.text === undefined || typeof answer.text === "string";
}
// Every entry is validated, not just the envelope (same argument as
// threads.ts): a JSON-valid file with a corrupt entry would otherwise flow a
// non-entry into the answers endpoint (500) and the Interview panel.
function isEntry(raw) {
    const entry = raw;
    if (typeof entry !== "object" || entry === null)
        return false;
    if (typeof entry.id !== "string" || typeof entry.question !== "string")
        return false;
    if (typeof entry.askedAt !== "string")
        return false;
    if (entry.options !== undefined &&
        !(Array.isArray(entry.options) && entry.options.every((o) => typeof o === "string"))) {
        return false;
    }
    if (entry.recommend !== undefined && typeof entry.recommend !== "string")
        return false;
    if (entry.multi !== undefined && typeof entry.multi !== "boolean")
        return false;
    return entry.answer === undefined || isAnswer(entry.answer);
}
function parseTranscript(raw) {
    const file = raw;
    const valid = typeof file === "object" &&
        file !== null &&
        file.version === 1 &&
        Array.isArray(file.entries) &&
        file.entries.every(isEntry);
    return valid ? file : undefined;
}
/** All entries, oldest first. Missing file = no transcript yet; corrupt = quarantined, []. */
export function readTranscript(path) {
    if (!existsSync(path))
        return [];
    const file = parseTranscript(readJsonOr(path));
    if (!file) {
        quarantineCorruptFile(path, "grill transcript");
        return [];
    }
    return file.entries;
}
/** Durably append one asked question (otacon ask). */
export function appendEntry(path, entry) {
    const file = { version: 1, entries: [...readTranscript(path), entry] };
    writeFileAtomic(path, stringify(file));
}
/**
 * Record the user's answer on a transcript entry; returns the updated entry,
 * or undefined when no question with that id exists. Re-answering overwrites
 * — at-least-once delivery makes a duplicate answer legitimate, and the newer
 * one wins (same posture as threads.ts answerQuestion).
 */
export function answerEntry(path, id, answer) {
    const entries = readTranscript(path);
    const entry = entries.find((e) => e.id === id);
    if (!entry)
        return undefined;
    entry.answer = answer;
    writeFileAtomic(path, stringify({ version: 1, entries }));
    return { ...entry };
}
//# sourceMappingURL=transcript.js.map