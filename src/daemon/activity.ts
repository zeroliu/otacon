// Per-session live-activity feed: .otacon/<id>/activity.json holds the agent's
// recent `otacon progress` notes (review loop and daemon API) — the append-only telemetry the
// review UI watches while the agent researches and drafts. Append-only and
// capped to the newest N (config), so it stays small and the feed never grows
// without bound. Same storage posture as the queue/transcript readers: atomic
// writes, corrupt files quarantined and rebuilt empty, never fatal.

import { existsSync } from "node:fs";
import type { ActivityFile, ActivityNote } from "../shared/types.js";
import { quarantineCorruptFile, readJsonOr, stringify, writeFileAtomic } from "./store.js";

function isNote(raw: unknown): raw is ActivityNote {
  const note = raw as ActivityNote;
  return (
    typeof note === "object" &&
    note !== null &&
    typeof note.at === "string" &&
    typeof note.text === "string"
  );
}

// Every note is validated, not just the envelope (same argument as
// transcript.ts): a JSON-valid file with a corrupt note would otherwise flow a
// non-note into the chip and the activity log.
function parseActivity(raw: unknown): ActivityFile | undefined {
  const file = raw as ActivityFile;
  const valid =
    typeof file === "object" &&
    file !== null &&
    file.version === 1 &&
    Array.isArray(file.notes) &&
    file.notes.every(isNote);
  return valid ? file : undefined;
}

/** All notes, oldest first (already capped). Missing file = none yet; corrupt = quarantined, []. */
export function readActivity(path: string): ActivityNote[] {
  if (!existsSync(path)) return [];
  const file = parseActivity(readJsonOr(path));
  if (!file) {
    quarantineCorruptFile(path, "activity feed");
    return [];
  }
  return file.notes;
}

/** The newest note (the chip's source), or undefined when the feed is empty. */
export function latestNote(path: string): ActivityNote | undefined {
  const notes = readActivity(path);
  return notes[notes.length - 1];
}

/**
 * Durably append one note, keeping only the newest `cap` (older notes drop off
 * the front); returns the appended note. `at` is passed in so the route owns
 * the single clock read alongside its other timestamps.
 */
export function appendActivity(
  path: string,
  text: string,
  cap: number,
  at: string,
): ActivityNote {
  const note: ActivityNote = { at, text };
  const notes = [...readActivity(path), note];
  const capped = cap > 0 && notes.length > cap ? notes.slice(notes.length - cap) : notes;
  writeFileAtomic(path, stringify({ version: 1, notes: capped } satisfies ActivityFile));
  return note;
}
