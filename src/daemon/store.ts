// Global session registry, per-session daemon state, and revision snapshots
// (session registry and switcher, approval and archive lifecycle). All state is plain JSON written atomically — temp file +
// rename — so a crash can never leave a half-written file (DECISIONS.md
// "Storage: plain JSON files, not SQLite"). A file that is corrupt anyway
// (manual edit, disk fault) is quarantined, never fatal: it is renamed aside
// and the daemon continues with a fresh structure (DECISIONS.md "Corrupt state
// files are quarantined, not fatal") — a permanently wedged daemon is worse
// than one recoverable file.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as paths from "../shared/paths.js";
import { parsePullRequestMetadata, REVIEW_SESSION_STATUSES } from "../shared/review.js";
import type {
  PullRequestMetadata,
  ReviewCompletionSummary,
  ReviewStartAction,
} from "../shared/review.js";
import type {
  LintIssue,
  PlanRegistrySession,
  RegistryFile,
  RegistrySession,
  ReviewRegistrySession,
  SessionStateFile,
} from "../shared/types.js";
import { SESSION_STATUSES } from "../shared/types.js";

let tmpSerial = 0;
let quarantineSerial = 0;

function exactIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/** Atomic write: temp file in the destination directory (created if needed) + rename. */
export function writeFileAtomic(path: string, data: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${process.pid}-${tmpSerial++}`);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Canonical on-disk JSON formatting for all otacon state files. */
export function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Move a corrupt state file aside to `<name>.corrupt-<timestamp>` (atomic
 * rename), log to stderr, and let the caller continue with a fresh structure.
 * The serial suffix keeps two quarantines in the same millisecond from
 * overwriting each other.
 */
export function quarantineCorruptFile(path: string, what: string): string {
  const aside = `${path}.corrupt-${Date.now()}-${quarantineSerial++}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    // The file vanished (deleted out from under us mid-recovery) or the rename
    // itself failed. Quarantine exists to keep the daemon alive — moving the
    // evidence aside must never become the new fatal path; the caller's fresh
    // rebuild overwrites whatever is (or is not) left at `path`.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `otacond: ${what} at ${path} is corrupt and could not be moved aside (${message}); continuing with fresh state\n`,
    );
    return aside;
  }
  process.stderr.write(
    `otacond: ${what} at ${path} is corrupt; moved it to ${aside} and continuing with fresh state\n`,
  );
  return aside;
}

export function readJsonOr(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined; // unreadable or not JSON — caller quarantines
  }
}

function parseRegistry(raw: unknown): RegistryFile | undefined {
  const file = raw as { version?: unknown; sessions?: unknown };
  const valid =
    typeof file === "object" &&
    file !== null &&
    file.version === 1 &&
    typeof file.sessions === "object" &&
    file.sessions !== null;
  if (!valid) return undefined;
  const sessions: Record<string, RegistrySession> = {};
  for (const [id, value] of Object.entries(file.sessions as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) return undefined;
    const stored = value as Record<string, unknown>;
    // Registry v1 predates the discriminant. Decode, don't rewrite: a legacy
    // entry remains byte-for-byte untouched until some later mutation flushes.
    const kind = stored.kind ?? "plan";
    if (kind !== "plan" && kind !== "review") return undefined;
    if (
      stored.id !== id || typeof stored.title !== "string" || typeof stored.repo !== "string" ||
      typeof stored.branch !== "string" || typeof stored.quick !== "boolean" ||
      (stored.socratic !== undefined && typeof stored.socratic !== "boolean") ||
      typeof stored.createdAt !== "string" || typeof stored.updatedAt !== "string"
    ) return undefined;
    if (kind === "plan") {
      if (!SESSION_STATUSES.includes(stored.status as never)) return undefined;
    } else {
      if (!REVIEW_SESSION_STATUSES.includes(stored.status as never)) {
        return undefined;
      }
      const review = stored.review as Record<string, unknown> | undefined;
      const head = review?.head as Record<string, unknown> | undefined;
      const pullRequest = parsePullRequestMetadata(review?.pullRequest);
      const completions = review?.completions;
      const parsedCompletions = Array.isArray(completions)
        ? completions.filter((completion): completion is ReviewCompletionSummary => validReviewCompletion(completion, id))
        : undefined;
      const latestCompletion = parsedCompletions?.at(-1);
      if (
        pullRequest === undefined || typeof head !== "object" || head === null ||
        head.sha !== pullRequest.headSha || head.ref !== pullRequest.headRef ||
        head.repository !== pullRequest.headRepository || typeof head.capturedAt !== "string" ||
        !Number.isInteger(review?.revision) || (review?.revision as number) < 1 ||
        (completions !== undefined && (!Array.isArray(completions) ||
          parsedCompletions?.length !== completions.length ||
          parsedCompletions.some((completion, index) => index > 0 &&
            (completion.eventSeq <= parsedCompletions[index - 1]!.eventSeq ||
             Date.parse(completion.completedAt) < Date.parse(parsedCompletions[index - 1]!.completedAt))))) ||
        (stored.status === "done" && (latestCompletion === undefined ||
          latestCompletion.headRevision !== review?.revision || latestCompletion.headSha !== head.sha))
      ) return undefined;
    }
    sessions[id] = {
      ...stored,
      kind,
      // `socratic` was added after registry v1 shipped. Normalize the absent
      // legacy field in memory just like the missing session discriminant; the
      // file is not rewritten until a later real mutation flushes the registry.
      socratic: stored.socratic ?? false,
    } as unknown as RegistrySession;
  }
  return { version: 1, sessions };
}

function validReviewCompletion(raw: unknown, session: string): raw is ReviewCompletionSummary {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  const expected = ["version", "session", "completedAt", "reportRevision", "headRevision", "headSha", "forced", "unresolved", "eventSeq", "wake"].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index]) ||
      value.version !== 1 || value.session !== session || !exactIso(value.completedAt) ||
      !Number.isSafeInteger(value.reportRevision) ||
      (value.reportRevision as number) < 1 || !Number.isSafeInteger(value.headRevision) ||
      (value.headRevision as number) < 1 || typeof value.headSha !== "string" ||
      !/^[0-9a-f]{40}$/i.test(value.headSha) || typeof value.forced !== "boolean" ||
      !Number.isSafeInteger(value.eventSeq) || (value.eventSeq as number) < 1 ||
      (value.wake !== "pending" && value.wake !== "queued") || typeof value.unresolved !== "object" ||
      value.unresolved === null || Array.isArray(value.unresolved)) return false;
  const unresolved = value.unresolved as Record<string, unknown>;
  return Object.keys(unresolved).sort().join(",") === "conversations,quizzes" &&
    Number.isSafeInteger(unresolved.conversations) && (unresolved.conversations as number) >= 0 &&
    Number.isSafeInteger(unresolved.quizzes) && (unresolved.quizzes as number) >= 0;
}

function parseState(raw: unknown): SessionStateFile | undefined {
  const file = raw as SessionStateFile;
  const counters = file?.counters;
  const valid =
    typeof file === "object" &&
    file !== null &&
    typeof file.id === "string" &&
    typeof file.revision === "number" &&
    typeof counters === "object" &&
    counters !== null &&
    typeof counters.batch === "number" &&
    typeof counters.thread === "number" &&
    typeof counters.question === "number" &&
    typeof counters.eventSeq === "number";
  if (!valid) return undefined;
  // Pre-M3 state files lack the field; a hand-edited/restored file may carry a
  // non-integer or a value beyond the current revision, which would poison the
  // diff endpoint's default baseline (400 on a parameterless GET, or a 500 via
  // readRevision(1.5)). Defaulting/clamping beats quarantining either way.
  const reviewed = file.lastReviewedRevision as unknown;
  file.lastReviewedRevision =
    typeof reviewed === "number" && Number.isInteger(reviewed) && reviewed > 0
      ? Math.min(reviewed, file.revision)
      : 0;
  // The deferred-approval flag (comment & approve) is optional — pre-feature and
  // most live files lack it. A malformed value would otherwise flow a bad
  // implement flag / thread list into the finalize path; drop anything that
  // isn't the exact shape rather than quarantine the whole (recoverable) file.
  const pending = file.pendingApproval as unknown;
  if (
    typeof pending === "object" &&
    pending !== null &&
    typeof (pending as { implement?: unknown }).implement === "boolean" &&
    Array.isArray((pending as { threads?: unknown }).threads) &&
    (pending as { threads: unknown[] }).threads.every((t) => typeof t === "string")
  ) {
    file.pendingApproval = pending as SessionStateFile["pendingApproval"];
  } else {
    delete file.pendingApproval;
  }
  return file;
}

/** Highest r<N>.md snapshot on disk — the revision counter's source of truth. */
function recoverRevision(id: string): number {
  let max = 0;
  try {
    for (const name of readdirSync(paths.sessionDir(id))) {
      const match = /^r(\d+)\.md$/.exec(name);
      if (match) max = Math.max(max, Number(match[1]));
    }
  } catch {
    // no session dir yet — revision 0
  }
  return max;
}

/**
 * High-water scan of threads.json and events.json so rebuilt counters never
 * re-mint a live id (DECISIONS.md "Quarantine counter recovery") — duplicate
 * thread ids would cross-wire resolutions now that threads carry state. Reads
 * loosely (no thread validation): a half-corrupt file should still surrender
 * every id it can.
 */
function recoverCounters(id: string): SessionStateFile["counters"] {
  const counters = { batch: 0, thread: 0, question: 0, eventSeq: 0 };
  const see = (key: keyof typeof counters, raw: unknown, re: RegExp): void => {
    const match = typeof raw === "string" ? re.exec(raw) : null;
    if (match) counters[key] = Math.max(counters[key], Number(match[1]));
  };
  const threadsRaw = readJsonOr(paths.threadsPath(id)) as { threads?: unknown[] } | undefined;
  for (const t of Array.isArray(threadsRaw?.threads) ? threadsRaw.threads : []) {
    const thread = t as { id?: unknown; batch?: unknown };
    see("thread", thread?.id, /^t(\d+)$/);
    see("question", thread?.id, /^q(\d+)$/);
    see("batch", thread?.batch, /^b(\d+)$/);
  }
  // Agent grill questions share the q counter with user-question threads.
  const transcriptRaw = readJsonOr(paths.transcriptPath(id)) as
    | { entries?: unknown[] }
    | undefined;
  for (const e of Array.isArray(transcriptRaw?.entries) ? transcriptRaw.entries : []) {
    see("question", (e as { id?: unknown })?.id, /^q(\d+)$/);
  }
  const eventsRaw = readJsonOr(paths.eventsPath(id)) as { events?: unknown[] } | undefined;
  for (const e of Array.isArray(eventsRaw?.events) ? eventsRaw.events : []) {
    const event = e as { seq?: unknown; payload?: { batch?: unknown; id?: unknown; items?: unknown[] } };
    if (typeof event?.seq === "number") {
      counters.eventSeq = Math.max(counters.eventSeq, event.seq);
    }
    see("batch", event?.payload?.batch, /^b(\d+)$/);
    see("question", event?.payload?.id, /^q(\d+)$/);
    for (const item of Array.isArray(event?.payload?.items) ? event.payload.items : []) {
      see("thread", (item as { thread?: unknown })?.thread, /^t(\d+)$/);
    }
  }
  return counters;
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

export interface CreateSessionInput {
  title: string;
  /** The user's verbatim request, trimmed; absent/empty stores no prompt field. */
  prompt?: string;
  /** Absolute repo root (DECISIONS.md "`.otacon/` lives at the git repo root"). */
  repo: string;
  branch?: string;
  quick?: boolean;
  socratic?: boolean;
}

export interface StartReviewInput {
  repo: string;
  branch?: string;
  pullRequest: PullRequestMetadata;
  force?: boolean;
}

export interface StartReviewResult {
  action: ReviewStartAction;
  session: ReviewRegistrySession;
}

/**
 * Owns `$OTACON_HOME/registry.json` plus each session's working state in the
 * home store (`~/.otacon/sessions/<id>/`). Event seqs and the b/t/q stable ids
 * are minted here (bumpCounter) so they survive queue drains and daemon
 * restarts.
 */
export class Store {
  private readonly registryFile: string;
  private registry: RegistryFile;

  constructor() {
    this.registryFile = paths.registryPath();
    if (!existsSync(this.registryFile)) {
      this.registry = { version: 1, sessions: {} };
      return;
    }
    const parsed = parseRegistry(readJsonOr(this.registryFile));
    if (parsed) {
      this.registry = parsed;
      return;
    }
    // Sessions registered there are forgotten (their ~/.otacon/sessions/<id>/
    // dirs survive for manual recovery); the alternative is a daemon that can
    // never boot again.
    quarantineCorruptFile(this.registryFile, "session registry");
    this.registry = { version: 1, sessions: {} };
    this.flushRegistry();
  }

  listSessions(): RegistrySession[] {
    return Object.values(this.registry.sessions).map((s) => structuredClone(s));
  }

  getSession(id: string): RegistrySession | undefined {
    const session = this.registry.sessions[id];
    return session ? structuredClone(session) : undefined;
  }

  createSession(input: CreateSessionInput): PlanRegistrySession {
    const id = this.mintId();
    const now = new Date().toISOString();
    const session: PlanRegistrySession = {
      kind: "plan",
      id,
      title: input.title,
      repo: input.repo,
      branch: input.branch ?? "",
      quick: input.quick ?? false,
      socratic: input.socratic ?? false,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    // Only write the prompt field when one was captured: a whitespace-only or
    // absent request leaves the field off entirely, like other optionals.
    if (typeof input.prompt === "string" && input.prompt.trim() !== "") {
      session.prompt = input.prompt.trim();
    }
    // State files first, registry entry last: the registry is the commit point.
    // A crash in between leaves an orphan ~/.otacon/sessions/<id>/ dir
    // (harmless), never a registered session whose state files are missing
    // (wedged forever).
    const state: SessionStateFile = {
      id,
      revision: 0,
      lastReviewedRevision: 0,
      counters: { batch: 0, thread: 0, question: 0, eventSeq: 0 },
    };
    writeFileAtomic(paths.sessionStatePath(id), stringify(state));
    writeFileAtomic(paths.eventsPath(id), stringify({ version: 1, events: [] }));
    this.registry.sessions[id] = session;
    this.flushRegistry();
    return structuredClone(session);
  }

  findReviewSession(
    repository: PullRequestMetadata["identity"]["repository"],
    number: number,
  ): ReviewRegistrySession | undefined {
    const found = Object.values(this.registry.sessions)
      .filter((session): session is ReviewRegistrySession =>
        session.kind === "review" &&
        session.review.pullRequest.identity.repository === repository &&
        session.review.pullRequest.identity.number === number,
      )
      .reverse()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return found ? structuredClone(found) : undefined;
  }

  /** Atomic create/reuse/head-refresh boundary for canonical PR identity. */
  startReviewSession(input: StartReviewInput): StartReviewResult {
    const identity = input.pullRequest.identity;
    const existing = input.force === true
      ? undefined
      : this.findReviewSession(identity.repository, identity.number);
    if (existing !== undefined) {
      if (existing.review.head.sha === input.pullRequest.headSha) {
        return {
          action: existing.status === "done" ? "reused-complete" : "reused",
          session: this.refreshReviewHead(existing.id, input.pullRequest),
        };
      }
      return {
        action: existing.status === "done" ? "reopened-changed" : "revised",
        session: this.refreshReviewHead(existing.id, input.pullRequest),
      };
    }

    const id = this.mintId();
    const now = new Date().toISOString();
    const session: ReviewRegistrySession = {
      kind: "review",
      id,
      title: `#${identity.number} ${input.pullRequest.title}`,
      repo: input.repo,
      branch: input.branch ?? "",
      quick: false,
      socratic: false,
      status: "working",
      createdAt: now,
      updatedAt: now,
      prUrl: input.pullRequest.url,
      prState: input.pullRequest.state,
      review: {
        pullRequest: structuredClone(input.pullRequest),
        head: {
          sha: input.pullRequest.headSha,
          ref: input.pullRequest.headRef,
          repository: input.pullRequest.headRepository,
          capturedAt: now,
        },
        revision: 1,
      },
    };
    // The dedicated review store owns report/state files. Session creation only
    // creates its queue here; plan session.json is never created or repurposed.
    writeFileAtomic(paths.eventsPath(id), stringify({ version: 1, events: [] }));
    this.registry.sessions[id] = session;
    this.flushRegistry();
    return { action: "created", session: structuredClone(session) };
  }

  refreshReviewHead(id: string, pullRequest: PullRequestMetadata): ReviewRegistrySession {
    const session = this.require(id);
    if (session.kind !== "review") throw new Error(`session ${id} is not a review`);
    if (session.review.pullRequest.identity.key !== pullRequest.identity.key) {
      throw new Error("cannot change a review session's canonical pull request identity");
    }
    const sameHead = session.review.head.sha === pullRequest.headSha;
    if (sameHead && JSON.stringify(session.review.pullRequest) === JSON.stringify(pullRequest)) {
      return structuredClone(session);
    }
    const now = new Date().toISOString();
    session.title = `#${pullRequest.identity.number} ${pullRequest.title}`;
    if (!sameHead) session.status = "working";
    session.updatedAt = now;
    session.prUrl = pullRequest.url;
    session.prState = pullRequest.state;
    session.review = {
      ...session.review,
      pullRequest: structuredClone(pullRequest),
      head: {
        sha: pullRequest.headSha,
        ref: pullRequest.headRef,
        repository: pullRequest.headRepository,
        capturedAt: now,
      },
      revision: sameHead ? session.review.revision : session.review.revision + 1,
    };
    this.flushRegistry();
    return structuredClone(session);
  }

  updateSession(
    id: string,
    patch: Partial<Pick<RegistrySession, "title" | "status" | "prUrl" | "prState" | "impl">>,
  ): RegistrySession {
    const session = this.require(id);
    if (patch.status !== undefined) {
      if (session.kind === "review" && patch.status === "done") {
        throw new Error("review Done must persist a completion baseline");
      }
      const valid = session.kind === "plan"
        ? SESSION_STATUSES.includes(patch.status as never)
        : REVIEW_SESSION_STATUSES.includes(patch.status as never);
      if (!valid) throw new Error(`invalid ${session.kind} status: ${patch.status}`);
    }
    if (session.kind === "review" && patch.impl !== undefined) {
      throw new Error("review sessions cannot own plan implementation worktrees");
    }
    Object.assign(session, patch);
    session.updatedAt = new Date().toISOString();
    this.flushRegistry();
    return structuredClone(session);
  }

  /** Commit one immutable Done baseline and its reserved terminal event seq. */
  completeReviewSession(id: string, completion: ReviewCompletionSummary): ReviewRegistrySession {
    const session = this.require(id);
    if (session.kind !== "review") throw new Error(`session ${id} is not a review`);
    const existing = session.review.completions?.at(-1);
    if (session.status === "done") {
      if (existing !== undefined) return structuredClone(session);
      throw new Error(`done review ${id} has no completion baseline`);
    }
    if (!validReviewCompletion(completion, id) || completion.wake !== "pending" ||
        completion.headRevision !== session.review.revision || completion.headSha !== session.review.head.sha) {
      throw new Error("review completion does not match the current session/head");
    }
    session.status = "done";
    session.updatedAt = completion.completedAt;
    session.review.completions = [...(session.review.completions ?? []), structuredClone(completion)];
    this.flushRegistry();
    return structuredClone(session);
  }

  /** Mark the reserved terminal wake durable before allowing queue dispatch. */
  markReviewCompletionQueued(id: string, eventSeq: number): ReviewRegistrySession {
    const session = this.require(id);
    if (session.kind !== "review") throw new Error(`session ${id} is not a review`);
    const completion = session.review.completions?.at(-1);
    if (completion === undefined || completion.eventSeq !== eventSeq) {
      throw new Error(`review ${id} has no completion for event ${eventSeq}`);
    }
    if (completion.wake === "queued") return structuredClone(session);
    completion.wake = "queued";
    this.flushRegistry();
    return structuredClone(session);
  }

  /**
   * Remove a session from the registry (otacon clean, approval and archive lifecycle); its home
   * dir `~/.otacon/sessions/<id>/` is the CLI's/daemon's to remove afterwards.
   */
  deleteSession(id: string): RegistrySession {
    const session = this.require(id);
    delete this.registry.sessions[id];
    this.flushRegistry();
    return structuredClone(session);
  }

  /**
   * Permanently remove a session's home dir `~/.otacon/sessions/<id>/` (UI delete
   * and `otacon clean`, all statuses): no archive, nothing recoverable from
   * otacon itself. The durable copies are the Save copy under `plans.dir` and
   * (for Implement plans) the PR. Called after the caller deregisters, so it
   * takes the id directly. Idempotent: a missing dir is fine (force).
   */
  removeSessionDir(id: string): void {
    rmSync(paths.sessionDir(id), { recursive: true, force: true });
  }

  readState(id: string): SessionStateFile {
    this.require(id);
    const path = paths.sessionStatePath(id);
    if (existsSync(path)) {
      const parsed = parseState(readJsonOr(path));
      if (parsed && parsed.id === id) return parsed;
      quarantineCorruptFile(path, `session state for ${id}`);
    }
    // Rebuild: revision comes from the r<N>.md snapshots (they are the actual
    // plan history — restarting at r1 would overwrite them); counters from a
    // high-water scan of threads.json and events.json, so rebuilt counters
    // cannot mint duplicate live ids (DECISIONS.md "Quarantine counter
    // recovery"). lastReviewedRevision restarts at 0 — the diff baseline
    // degrades to "previous revision", which the user can re-select.
    const state: SessionStateFile = {
      id,
      revision: recoverRevision(id),
      lastReviewedRevision: 0,
      counters: recoverCounters(id),
    };
    writeFileAtomic(path, stringify(state));
    return state;
  }

  /**
   * Record that the user has reviewed revision n (a comment-batch flush, or
   * the UI's explicit mark-reviewed). Monotonic: the stored value never moves
   * backwards — older baselines stay reachable via the diff endpoint's ?from=.
   */
  markReviewed(id: string, n: number): number {
    const state = this.readState(id); // throws on unknown id
    if (n > state.lastReviewedRevision) {
      state.lastReviewedRevision = Math.min(n, state.revision);
      writeFileAtomic(paths.sessionStatePath(id), stringify(state));
    }
    return state.lastReviewedRevision;
  }

  /**
   * Arm a deferred approval (comment & approve): the session
   * has flipped to `finalizing`, and the agent's next clean `submit` finalizes,
   * carrying the `implement` choice and the swept comment-thread ids. Persisted
   * on session.json (not the registry) — daemon-owned detail, like the counters.
   */
  setPendingApproval(id: string, pendingApproval: { implement: boolean; threads: string[] }): void {
    const state = this.readState(id); // throws on unknown id
    state.pendingApproval = pendingApproval;
    writeFileAtomic(paths.sessionStatePath(id), stringify(state));
  }

  /** Disarm the deferred approval once it has finalized (or been force-escaped). */
  clearPendingApproval(id: string): void {
    const state = this.readState(id); // throws on unknown id
    if (state.pendingApproval === undefined) return;
    delete state.pendingApproval;
    writeFileAtomic(paths.sessionStatePath(id), stringify(state));
  }

  /** Increment one daemon-owned counter (review loop and daemon API stable ids) and persist it. */
  bumpCounter(id: string, key: keyof SessionStateFile["counters"]): number {
    const session = this.require(id);
    if (session.kind === "review") {
      if (key !== "eventSeq") throw new Error(`review sessions do not own the ${key} plan counter`);
      const path = paths.reviewEventSeqPath(id);
      let current = 0;
      try {
        const raw = readFileSync(path, "utf8").trim();
        if (!/^\d+$/.test(raw)) throw new Error("invalid review event sequence");
        current = Number(raw);
      } catch (error) {
        if (existsSync(path)) throw error;
      }
      const next = current + 1;
      writeFileAtomic(path, `${next}\n`);
      return next;
    }
    return this.bumpCounters(id, { [key]: 1 })[key];
  }

  /**
   * Increment several counters in one read + one atomic write (a comment batch
   * mints N thread ids, a batch id, and an event seq together); returns the
   * updated counter values.
   */
  bumpCounters(
    id: string,
    by: Partial<Record<keyof SessionStateFile["counters"], number>>,
  ): SessionStateFile["counters"] {
    const state = this.readState(id); // throws on unknown id
    for (const key of Object.keys(by) as (keyof SessionStateFile["counters"])[]) {
      state.counters[key] += by[key] ?? 0;
    }
    writeFileAtomic(paths.sessionStatePath(id), stringify(state));
    return { ...state.counters };
  }

  /**
   * Store the next revision snapshot r<N>.md plus the lint warnings it was
   * accepted with (r<N>.warnings.json — the UI's L6 badges; approval and archive lifecycle)
   * and the agent's changelog when one accompanied it (r<N>.changelog.md);
   * returns N.
   */
  saveRevision(
    id: string,
    content: string,
    warnings: LintIssue[] = [],
    changelog?: string,
  ): number {
    const session = this.require(id);
    const state = this.readState(id);
    state.revision += 1;
    writeFileAtomic(paths.revisionPath(id, state.revision), content);
    writeFileAtomic(
      paths.revisionWarningsPath(id, state.revision),
      stringify(warnings),
    );
    if (changelog !== undefined && changelog.trim() !== "") {
      writeFileAtomic(paths.revisionChangelogPath(id, state.revision), changelog);
    }
    writeFileAtomic(paths.sessionStatePath(id), stringify(state));
    session.updatedAt = new Date().toISOString();
    this.flushRegistry();
    return state.revision;
  }

  readRevision(id: string, n: number): string {
    this.require(id); // throws on unknown id
    return readFileSync(paths.revisionPath(id, n), "utf8");
  }

  /** The changelog submitted with r<n>.md; null when none was (r1, typically). */
  readRevisionChangelog(id: string, n: number): string | null {
    this.require(id); // throws on unknown id
    try {
      return readFileSync(paths.revisionChangelogPath(id, n), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Warnings recorded with r<n>.md. Missing or corrupt files read as [] — the
   * badges are presentation metadata, never worth quarantine machinery.
   */
  readRevisionWarnings(id: string, n: number): LintIssue[] {
    this.require(id); // throws on unknown id
    const raw = readJsonOr(paths.revisionWarningsPath(id, n));
    return Array.isArray(raw) ? (raw as LintIssue[]) : [];
  }

  /** Where this session's SessionQueue persists — for the daemon to wire queues. */
  eventsPath(id: string): string {
    this.require(id); // throws on unknown id
    return paths.eventsPath(id);
  }

  /** Where this session's review threads persist (src/daemon/threads.ts). */
  threadsPath(id: string): string {
    this.require(id); // throws on unknown id
    return paths.threadsPath(id);
  }

  /** Where this session's grill transcript persists (src/daemon/transcript.ts). */
  transcriptPath(id: string): string {
    this.require(id); // throws on unknown id
    return paths.transcriptPath(id);
  }

  /** Where this session's live-activity feed persists (src/daemon/activity.ts). */
  activityPath(id: string): string {
    this.require(id); // throws on unknown id
    return paths.activityPath(id);
  }

  /** Where this session's normalized live-activity stream persists (src/daemon/capture/stream-store.ts). */
  streamPath(id: string): string {
    this.require(id); // throws on unknown id
    return paths.streamPath(id);
  }

  private require(id: string): RegistrySession {
    const session = this.registry.sessions[id];
    if (!session) throw new Error(`unknown session: ${id}`);
    return session;
  }

  /** `otc_` + 6 base36 chars, collision-checked (DECISIONS.md "Session ids"). */
  private mintId(): string {
    for (let attempt = 0; attempt < 64; attempt++) {
      let suffix = "";
      for (const byte of randomBytes(6)) suffix += BASE36[byte % 36];
      const id = `otc_${suffix}`;
      if (!(id in this.registry.sessions)) return id;
    }
    throw new Error("could not mint a unique session id");
  }

  private flushRegistry(): void {
    writeFileAtomic(this.registryFile, stringify(this.registry));
  }
}
