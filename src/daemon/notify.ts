// In-process pub/sub bridging daemon state changes to the web UI's SSE
// streams (review UI "UI updates over SSE"). One daemon process owns all
// state, so an EventEmitter is the entire bus (DECISIONS.md "UI live updates:
// in-process Notifier, snapshot-first SSE, no replay").

import { EventEmitter } from "node:events";
import type {
  ActivityNote,
  SessionSummary,
  StreamEvent,
  Thread,
  TranscriptEntry,
  PublicReviewThread,
} from "../shared/types.js";
import type { ReviewQuizPublicState } from "../shared/review-quiz.js";

/**
 * One UI event: `type` becomes the SSE event name, `session` is the routing
 * key per-session streams filter on, `data` the JSON frame body. A `thread`
 * frame carries the full thread — both a new thread (comment/question posted)
 * and an updated one (the agent's answer landing); the UI upserts by id. A
 * `grill` frame is the transcript's equivalent: a question asked, or an
 * existing entry gaining its answer. An `activity` frame carries one new
 * progress note for the per-session activity log (the chip rides `session`
 * frames' `latestActivity` instead). A `stream` frame carries one or more new
 * normalized live-activity events (the automatic, cross-agent activity stream)
 * — newest last, coalesced/batched ok; the UI appends them to its stream view
 * by `seq`. A `removed` frame is terminal: the session left the registry
 * (otacon clean) — the index drops its card and an open review screen flips to
 * its cleaned state (approval and archive lifecycle).
 */
export type UiEvent =
  | { type: "session"; session: string; data: { session: SessionSummary } }
  | { type: "removed"; session: string; data: { session: string } }
  | {
      type: "revision";
      session: string;
      data: { session: string; revision: number; changelog: string | null };
    }
  | { type: "queue"; session: string; data: { session: string; pending: number } }
  | { type: "quiz"; session: string; data: { session: string; quiz: ReviewQuizPublicState } }
  | { type: "thread"; session: string; data: { session: string; thread: Thread | PublicReviewThread } }
  | { type: "grill"; session: string; data: { session: string; entry: TranscriptEntry } }
  | { type: "activity"; session: string; data: { session: string; note: ActivityNote } }
  | { type: "stream"; session: string; data: { session: string; events: StreamEvent[] } };

export class Notifier {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open SSE stream; the default 10-listener warning is noise.
    this.emitter.setMaxListeners(0);
  }

  publish(event: UiEvent): void {
    this.emitter.emit("event", event);
  }

  /** Returns the unsubscribe function. */
  subscribe(listener: (event: UiEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }
}
