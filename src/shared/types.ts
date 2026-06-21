// Cross-layer types shared by the daemon and the CLI.
// Wire shapes (EventPayload) follow review loop and daemon API exactly.

import type { QuestionSpec } from "./question-spec.js";

export type { QuestionSpec };

export type SessionStatus =
  | "draft"
  | "in_review"
  | "revising"
  | "finalizing"
  | "approved"
  | "implementing"
  | "implemented"
  | "implement_failed";

export const SESSION_STATUSES: readonly SessionStatus[] = [
  "draft",
  "in_review",
  "revising",
  "finalizing",
  "approved",
  "implementing",
  "implemented",
  "implement_failed",
];

/**
 * The terminal states (approval and archive lifecycle status machine): a session here is *over* —
 * every mutating verb refuses (app.ts `sessionEnded`), and the CLI's pointer
 * rules stop resolving it implicitly. `implementing` is deliberately NOT here:
 * it re-opens progress/ask/wait/answer while the agent builds the approved plan.
 * `finalizing` is likewise NOT here: a send-to-agent approve (comment & approve)
 * defers the finalize while the agent folds the open comments in, so its next
 * `submit` must still mutate the session. The single source of truth — the app
 * guard and the CLI resolver both derive from this, so they can never disagree
 * about what "over" means.
 */
export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  "approved",
  "implemented",
  "implement_failed",
];

/** One entry in ~/.otacon/registry.json. */
export interface RegistrySession {
  id: string;
  title: string;
  /** Absolute repo root at start time. */
  repo: string;
  /** Git branch at start time; "" when none. */
  branch: string;
  quick: boolean;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /**
   * The PR the agent opened for the implemented plan (`otacon implement-done
   * --pr`); absent until a build finishes. Persists in registry.json and flows
   * to SessionSummary so the home card can surface the link (approval and archive lifecycle).
   */
  prUrl?: string;
}

export interface RegistryFile {
  version: 1;
  sessions: Record<string, RegistrySession>;
}

/** Registry entry plus live detail — what the web UI renders (SSE snapshot/session frames). */
export interface SessionSummary extends RegistrySession {
  revision: number;
  lastReviewedRevision: number;
  pendingEvents: number;
  /**
   * Unanswered agent grill questions (transcript entries without an answer) —
   * the index's "questions pending" chip derives from this (review UI),
   * never from a stored status.
   */
  openQuestions: number;
  /**
   * The newest progress note (review loop and daemon API `otacon progress`); absent until the
   * agent narrates. The `draft` chip reads it (latest note, falling back to
   * "agent working"); the full feed lives on the per-session activity stream.
   */
  latestActivity?: ActivityNote;
  /**
   * Epoch-ms of the agent's last contact this daemon lifetime (any mutating CLI
   * call or `wait` park) — ephemeral, in-memory only; absent until first
   * contact (a fresh daemon shows offline until the agent calls again, which is
   * correct). The UI derives live/offline from its recency, so the daemon needs
   * no timer.
   */
  lastContactAt?: number;
  /** True while the agent is parked in `otacon wait` (a live long-poll connection). */
  parked: boolean;
}

/**
 * One entry in a session's append-only activity feed (review loop and daemon API) — a
 * timestamped progress note the agent emits with `otacon progress`. `text` is
 * length-capped server-side so a long note never bloats payloads or fails.
 */
export interface ActivityNote {
  /** ISO timestamp the daemon stamped on receipt. */
  at: string;
  text: string;
}

/** .otacon/<id>/activity.json — the capped, newest-last progress feed (approval and archive lifecycle). */
export interface ActivityFile {
  version: 1;
  notes: ActivityNote[];
}

/** W3C-annotation-style anchor; null anchor on an event item = whole-plan. */
export interface Anchor {
  section: string;
  exact?: string;
  prefix?: string;
  suffix?: string;
}

export interface CommentItem {
  thread: string;
  anchor: Anchor | null;
  body: string;
}

export type EventPayload =
  // `final:true` is the **comment & approve** fold-in batch:
  // the reviewer approved while comments were open and chose "Send to agent", so
  // this batch re-delivers every still-open comment thread for one solo pass —
  // the agent's next clean `submit` finalizes the plan (it gets `approved`, which
  // may carry `implement:true`), instead of returning to in_review. Absent on an
  // ordinary comment batch.
  | { event: "comments"; session: string; batch: string; items: CommentItem[]; final?: true }
  | {
      event: "question";
      session: string;
      id: string;
      anchor: Anchor | null;
      body: string;
      /** Root question id this follows up on (threaded review and revision); absent on a root question. */
      replyTo?: string;
    }
  | {
      event: "answer";
      session: string;
      question: string;
      choice?: string;
      choices?: string[];
      text?: string;
      /** True when this overwrites an already-answered question (a revision); absent on a first answer. */
      revised?: boolean;
      /** The pre-overwrite answer's content (no `answeredAt`); present only alongside `revised`. */
      prior?: { choice?: string; choices?: string[]; text?: string };
    }
  // The approval wake-up. `home` is the absolute canonical
  // copy under `~/.otacon/sessions/<id>/`. `path` is the copy the agent acts on:
  // on **Save** (no `implement`) the repo-relative project copy under `plans.dir`,
  // which the agent reports before it stops; on **Implement** (`implement:true`)
  // `path` equals `home` and the agent builds from it.
  | { event: "approved"; session: string; path: string; home: string; implement?: true }
  // Terminal: the reviewer deleted a pending (non-approved) session from the UI
  // The daemon wakes the parked agent with this so its
  // `wait` loop stops cleanly instead of 404ing on a later call; there is no
  // artifact path.
  | { event: "deleted"; session: string };

/**
 * One review thread, persisted in .otacon/<id>/threads.json (threaded review and revision).
 * Comment threads come from comment batches (one per item) and gain a `reply`
 * from the agent's resolutions on resubmit (lint L5) — that reply is a *response*,
 * not a close; question threads gain an `answer` when the agent runs `otacon
 * answer`. A conversation root closes only when the **reviewer** sets `resolved`
 * (the new Resolve verb), which doubles as the comment-withdraw path: a resolved
 * comment no longer owes a reply (L5 skips it) and no longer counts unresolved at
 * approve. A follow-up question is its own thread linked to the root by `replyTo`
 * (threaded review and revision): it inherits the root's anchor, so a whole
 * conversation groups, jumps, and orphans as one unit. `anchorState` "orphaned"
 * means re-anchoring lost the quote in the current revision; absent = anchored.
 */
export type Thread =
  | {
      id: string; // t<n>
      kind: "comment";
      batch: string; // b<n>
      anchor: Anchor | null;
      anchorState?: "orphaned";
      body: string;
      createdAt: string;
      /** The agent's response, landed on resubmit (lint L5); not a close. */
      reply?: { body: string; revision: number; repliedAt: string };
      /** The reviewer closed this thread (Resolve verb); lives on the root. */
      resolved?: { revision: number; at: string };
    }
  | {
      id: string; // q<n>
      kind: "question";
      anchor: Anchor | null;
      anchorState?: "orphaned";
      body: string;
      createdAt: string;
      /** Root question id this follows up on; absent on a root question. */
      replyTo?: string;
      answer?: { body: string; answeredAt: string };
      /** The reviewer closed this conversation (Resolve verb); lives on the root. */
      resolved?: { revision: number; at: string };
    };

/**
 * The agent-written revision-accompaniment document (resolutions.json,
 * submitted with a revision: `threads` maps comment-thread ids to the agent's
 * replies (lint L5); `changelog` is the agent's summary of the revision (required on
 * revisions ≥ 2, threaded review and revision layer 1).
 */
export interface Resolutions {
  changelog?: string;
  threads?: Record<string, string>;
}

export interface ThreadsFile {
  version: 1;
  threads: Thread[];
}

/** The user's answer to an agent grill question (POST /api/sessions/:id/answers). */
export interface GrillAnswer {
  /** The chosen option (single-choice questions). */
  choice?: string;
  /** The chosen options (questions asked with --multi). */
  choices?: string[];
  /** Free text — the whole answer on optionless questions, extra context otherwise. */
  text?: string;
  answeredAt: string;
}

/**
 * One grill Q&A, persisted in .otacon/<id>/transcript.json (interview questions) —
 * distinct from user-question threads (threads.json); ids share the q counter
 * so citations (`D3 ← q7`, lint L3) and deep links are one unambiguous space.
 * The asked shape is the `QuestionSpec` the agent posted, plus the minted id,
 * timestamp, and (once answered) the user's answer.
 */
export interface TranscriptEntry extends QuestionSpec {
  id: string; // q<n>
  askedAt: string;
  answer?: GrillAnswer;
}

export interface TranscriptFile {
  version: 1;
  entries: TranscriptEntry[];
}

/**
 * The decision-citation grammar: `← q7` or `← q7, q9`; `<-` accepted alongside
 * `←` (models emit both arrows). Global: an entry can carry several citation
 * clauses ("… ← q1; revisit ← q9"). The single source of truth for both lint
 * L3 (src/daemon/linter/rules.ts) and the UI's deep-link transform
 * (src/ui/plan/plan-view.tsx), so they can never disagree about what a
 * citation is. The captured ids MUST stay `q\d+`-only: the UI injects them
 * into markup attributes pre-sanitize and relies on that charset.
 */
export const CITATION_RE = /(?:←|<-)\s*(q\d+(?:\s*,\s*q\d+)*)/g;

/** {"event":"timeout"} is synthesized at response time and never queued. */
export interface QueuedEvent {
  seq: number;
  queuedAt: string;
  payload: EventPayload;
}

export interface EventsFile {
  version: 1;
  events: QueuedEvent[];
}

/** .otacon/<id>/session.json — daemon-owned detail state and id counters. */
export interface SessionStateFile {
  id: string;
  revision: number;
  /**
   * Highest revision the user has actually reviewed (0 = never): set when a
   * comment batch is flushed and via POST /reviewed; the diff endpoint's
   * default baseline (threaded review and revision layer 3). Monotonic.
   */
  lastReviewedRevision: number;
  counters: { batch: number; thread: number; question: number; eventSeq: number };
  /**
   * A deferred approval armed by **comment & approve**: the
   * reviewer approved with open comments and chose "Send to agent", so the
   * session sits in `finalizing` until the agent's next clean `submit`, which
   * then finalizes instead of returning to in_review. `implement` carries the
   * Save vs Implement choice through that defer; `threads` is the swept
   * comment-thread ids, replayed into the `## Review notes` section once the
   * agent has resolved them. Absent on a session not finalizing.
   */
  pendingApproval?: { implement: boolean; threads: string[] };
}

export type LintSeverity = "error" | "warning";

export interface LintIssue {
  rule: "L1" | "L2" | "L3" | "L5" | "L6" | "L7" | "L8";
  code: string;
  severity: LintSeverity;
  message: string;
  /** 1-based. */
  line?: number;
  /** Section slug or "phase-<n>". */
  section?: string;
  /** Thread id an L5 issue is about. */
  thread?: string;
  budget?: number;
  actual?: number;
}

export interface LintResult {
  ok: boolean;
  errors: LintIssue[];
  warnings: LintIssue[];
}

/**
 * JSON variant of GET /api/sessions/:id/revisions/:n (Accept: application/json).
 * `warnings` are the lint warnings the revision was accepted with — the review
 * screen renders the L6 entries as badges on Details blocks (lint severity, review UI).
 */
export interface RevisionPayload {
  session: string;
  revision: number;
  markdown: string;
  warnings: LintIssue[];
  /** The agent's changelog for this revision (threaded review and revision layer 1); null on r1. */
  changelog: string | null;
}

/** One line of a diff hunk. */
export interface DiffLine {
  op: "context" | "add" | "del";
  text: string;
}

/** Unified-diff-style hunk; line numbers are 1-based within the section unit. */
export interface DiffHunk {
  fromStart: number;
  fromCount: number;
  toStart: number;
  toCount: number;
  lines: DiffLine[];
}

/**
 * Diff status for one plan unit (section slug or "phase-<n>"). Unchanged
 * sections carry no hunks; added/removed ones carry their full body as
 * add/del lines so the UI renders every status uniformly.
 */
export interface SectionDiff {
  id: string;
  title: string;
  status: "added" | "removed" | "changed" | "unchanged";
  hunks: DiffHunk[];
}

/** GET /api/sessions/:id/diff?from=&to= (review loop and daemon API). from=0 = empty plan. */
export interface DiffPayload {
  session: string;
  from: number;
  to: number;
  sections: SectionDiff[];
}
