// Cross-layer types shared by the daemon and the CLI.
// Wire shapes (EventPayload) follow DESIGN.md §6 exactly.

import type { QuestionSpec } from "./question-spec.js";

export type { QuestionSpec };

export type SessionStatus = "draft" | "in_review" | "revising" | "approved";

export const SESSION_STATUSES: readonly SessionStatus[] = [
  "draft",
  "in_review",
  "revising",
  "approved",
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
   * the index's "questions pending" chip derives from this (DESIGN.md §10),
   * never from a stored status.
   */
  openQuestions: number;
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
  | { event: "comments"; session: string; batch: string; items: CommentItem[] }
  | {
      event: "question";
      session: string;
      id: string;
      anchor: Anchor | null;
      body: string;
    }
  | {
      event: "answer";
      session: string;
      question: string;
      choice?: string;
      choices?: string[];
      text?: string;
    }
  | { event: "approved"; session: string; path: string };

/**
 * One review thread, persisted in .otacon/<id>/threads.json (DESIGN.md §9).
 * Comment threads come from comment batches (one per item) and gain a
 * `resolution` from the agent's resolutions on resubmit (lint L5); question
 * threads gain an `answer` when the agent runs `otacon answer`. `anchorState`
 * "orphaned" means re-anchoring lost the quote in the current revision
 * (DESIGN.md §4 orphaned tray); absent = anchored.
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
      resolution?: { body: string; revision: number; resolvedAt: string };
    }
  | {
      id: string; // q<n>
      kind: "question";
      anchor: Anchor | null;
      anchorState?: "orphaned";
      body: string;
      createdAt: string;
      answer?: { body: string; answeredAt: string };
    };

/**
 * The agent-written revision-accompaniment document (resolutions.json,
 * DESIGN.md §6): `threads` maps comment-thread ids to resolution replies
 * (lint L5); `changelog` is the agent's summary of the revision (required on
 * revisions ≥ 2, DESIGN.md §9 layer 1).
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
 * One grill Q&A, persisted in .otacon/<id>/transcript.json (DESIGN.md §8) —
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
 * (ui/src/plan/plan-view.tsx), so they can never disagree about what a
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
   * default baseline (DESIGN.md §9 layer 3). Monotonic.
   */
  lastReviewedRevision: number;
  counters: { batch: number; thread: number; question: number; eventSeq: number };
}

export type LintSeverity = "error" | "warning";

export interface LintIssue {
  rule: "L1" | "L2" | "L3" | "L5" | "L6";
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
 * screen renders the L6 entries as badges on Details blocks (DESIGN.md §5, §10).
 */
export interface RevisionPayload {
  session: string;
  revision: number;
  markdown: string;
  warnings: LintIssue[];
  /** The agent's changelog for this revision (DESIGN.md §9 layer 1); null on r1. */
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

/** GET /api/sessions/:id/diff?from=&to= (DESIGN.md §6). from=0 = empty plan. */
export interface DiffPayload {
  session: string;
  from: number;
  to: number;
  sections: SectionDiff[];
}
