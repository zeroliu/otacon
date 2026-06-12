// Cross-layer types shared by the daemon and the CLI.
// Wire shapes (EventPayload) follow DESIGN.md §6 exactly.

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
  pendingEvents: number;
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
    };

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
  counters: { batch: number; thread: number; question: number; eventSeq: number };
}

export type LintSeverity = "error" | "warning";

export interface LintIssue {
  rule: "L1" | "L2" | "L6";
  code: string;
  severity: LintSeverity;
  message: string;
  /** 1-based. */
  line?: number;
  /** Section slug or "phase-<n>". */
  section?: string;
  budget?: number;
  actual?: number;
}

export interface LintResult {
  ok: boolean;
  errors: LintIssue[];
  warnings: LintIssue[];
}
