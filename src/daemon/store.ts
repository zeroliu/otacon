// Global session registry, per-session daemon state, and revision snapshots
// (DESIGN.md §7, §12). All state is plain JSON written atomically — temp file +
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
import type { LintIssue, RegistryFile, RegistrySession, SessionStateFile } from "../shared/types.js";

let tmpSerial = 0;
let quarantineSerial = 0;

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
  const file = raw as RegistryFile;
  const valid =
    typeof file === "object" &&
    file !== null &&
    file.version === 1 &&
    typeof file.sessions === "object" &&
    file.sessions !== null;
  return valid ? file : undefined;
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
function recoverRevision(repo: string, id: string): number {
  let max = 0;
  try {
    for (const name of readdirSync(paths.sessionDir(repo, id))) {
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
function recoverCounters(repo: string, id: string): SessionStateFile["counters"] {
  const counters = { batch: 0, thread: 0, question: 0, eventSeq: 0 };
  const see = (key: keyof typeof counters, raw: unknown, re: RegExp): void => {
    const match = typeof raw === "string" ? re.exec(raw) : null;
    if (match) counters[key] = Math.max(counters[key], Number(match[1]));
  };
  const threadsRaw = readJsonOr(paths.threadsPath(repo, id)) as { threads?: unknown[] } | undefined;
  for (const t of Array.isArray(threadsRaw?.threads) ? threadsRaw.threads : []) {
    const thread = t as { id?: unknown; batch?: unknown };
    see("thread", thread?.id, /^t(\d+)$/);
    see("question", thread?.id, /^q(\d+)$/);
    see("batch", thread?.batch, /^b(\d+)$/);
  }
  // Agent grill questions share the q counter with user-question threads.
  const transcriptRaw = readJsonOr(paths.transcriptPath(repo, id)) as
    | { entries?: unknown[] }
    | undefined;
  for (const e of Array.isArray(transcriptRaw?.entries) ? transcriptRaw.entries : []) {
    see("question", (e as { id?: unknown })?.id, /^q(\d+)$/);
  }
  const eventsRaw = readJsonOr(paths.eventsPath(repo, id)) as { events?: unknown[] } | undefined;
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
  /** Absolute repo root (DECISIONS.md "`.otacon/` lives at the git repo root"). */
  repo: string;
  branch?: string;
  quick?: boolean;
}

/**
 * Owns `$OTACON_HOME/registry.json` plus each session's `.otacon/<id>/` state in
 * its repo. Event seqs and the b/t/q stable ids are minted here (bumpCounter)
 * so they survive queue drains and daemon restarts.
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
    // Sessions registered there are forgotten (their .otacon/ dirs survive for
    // manual recovery); the alternative is a daemon that can never boot again.
    quarantineCorruptFile(this.registryFile, "session registry");
    this.registry = { version: 1, sessions: {} };
    this.flushRegistry();
  }

  listSessions(): RegistrySession[] {
    return Object.values(this.registry.sessions).map((s) => ({ ...s }));
  }

  getSession(id: string): RegistrySession | undefined {
    const session = this.registry.sessions[id];
    return session ? { ...session } : undefined;
  }

  createSession(input: CreateSessionInput): RegistrySession {
    const id = this.mintId();
    const now = new Date().toISOString();
    const session: RegistrySession = {
      id,
      title: input.title,
      repo: input.repo,
      branch: input.branch ?? "",
      quick: input.quick ?? false,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    // State files first, registry entry last: the registry is the commit point.
    // A crash in between leaves an orphan .otacon/<id>/ dir (harmless), never a
    // registered session whose state files are missing (wedged forever).
    const state: SessionStateFile = {
      id,
      revision: 0,
      lastReviewedRevision: 0,
      counters: { batch: 0, thread: 0, question: 0, eventSeq: 0 },
    };
    writeFileAtomic(paths.sessionStatePath(input.repo, id), stringify(state));
    writeFileAtomic(paths.eventsPath(input.repo, id), stringify({ version: 1, events: [] }));
    this.registry.sessions[id] = session;
    this.flushRegistry();
    return { ...session };
  }

  updateSession(
    id: string,
    patch: Partial<Pick<RegistrySession, "title" | "status" | "prUrl">>,
  ): RegistrySession {
    const session = this.require(id);
    Object.assign(session, patch);
    session.updatedAt = new Date().toISOString();
    this.flushRegistry();
    return { ...session };
  }

  /**
   * Remove a session from the registry (otacon clean, DESIGN.md §12); the
   * .otacon/<id>/ dir in its repo is the CLI's to archive afterwards.
   */
  deleteSession(id: string): RegistrySession {
    const session = this.require(id);
    delete this.registry.sessions[id];
    this.flushRegistry();
    return { ...session };
  }

  /**
   * Hard-remove a session's working dir `.otacon/<id>/` (the UI deleting a
   * *pending* session, DESIGN.md §12): permanent, no archive — for a session
   * with no committed artifact. `repo` is passed explicitly because the caller
   * deregisters first, so require() would already throw. Idempotent: a missing
   * dir is fine (force).
   */
  removeSessionDir(repo: string, id: string): void {
    rmSync(paths.sessionDir(repo, id), { recursive: true, force: true });
  }

  /**
   * Archive a session's working dir `.otacon/<id>/` → `.otacon/archive/<id>/`
   * in its repo (numeric suffix on name collision); returns the destination, or
   * null when there was no dir. The recoverable counterpart to removeSessionDir,
   * for a session whose plan is committed (approved): `otacon clean` and the
   * UI's delete of an approved session both archive through here. `repo` is
   * passed explicitly because the caller deregisters first (require() throws).
   */
  archiveSessionDir(repo: string, id: string): string | null {
    const source = paths.sessionDir(repo, id);
    if (!existsSync(source)) return null;
    const base = join(paths.otaconDir(repo), "archive");
    mkdirSync(base, { recursive: true });
    let dest = join(base, id);
    for (let n = 2; existsSync(dest); n++) dest = join(base, `${id}-${n}`);
    renameSync(source, dest);
    return dest;
  }

  readState(id: string): SessionStateFile {
    const session = this.require(id);
    const path = paths.sessionStatePath(session.repo, id);
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
      revision: recoverRevision(session.repo, id),
      lastReviewedRevision: 0,
      counters: recoverCounters(session.repo, id),
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
    const session = this.require(id);
    const state = this.readState(id);
    if (n > state.lastReviewedRevision) {
      state.lastReviewedRevision = Math.min(n, state.revision);
      writeFileAtomic(paths.sessionStatePath(session.repo, id), stringify(state));
    }
    return state.lastReviewedRevision;
  }

  /**
   * Arm a deferred approval (comment & approve, DESIGN.md §6, §12): the session
   * has flipped to `finalizing`, and the agent's next clean `submit` finalizes,
   * carrying the `implement` choice and the swept comment-thread ids. Persisted
   * on session.json (not the registry) — daemon-owned detail, like the counters.
   */
  setPendingApproval(id: string, pendingApproval: { implement: boolean; threads: string[] }): void {
    const session = this.require(id);
    const state = this.readState(id);
    state.pendingApproval = pendingApproval;
    writeFileAtomic(paths.sessionStatePath(session.repo, id), stringify(state));
  }

  /** Disarm the deferred approval once it has finalized (or been force-escaped). */
  clearPendingApproval(id: string): void {
    const session = this.require(id);
    const state = this.readState(id);
    if (state.pendingApproval === undefined) return;
    delete state.pendingApproval;
    writeFileAtomic(paths.sessionStatePath(session.repo, id), stringify(state));
  }

  /** Increment one daemon-owned counter (DESIGN.md §6 stable ids) and persist it. */
  bumpCounter(id: string, key: keyof SessionStateFile["counters"]): number {
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
    const session = this.require(id);
    const state = this.readState(id);
    for (const key of Object.keys(by) as (keyof SessionStateFile["counters"])[]) {
      state.counters[key] += by[key] ?? 0;
    }
    writeFileAtomic(paths.sessionStatePath(session.repo, id), stringify(state));
    return { ...state.counters };
  }

  /**
   * Store the next revision snapshot r<N>.md plus the lint warnings it was
   * accepted with (r<N>.warnings.json — the UI's L6 badges; DESIGN.md §12)
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
    writeFileAtomic(paths.revisionPath(session.repo, id, state.revision), content);
    writeFileAtomic(
      paths.revisionWarningsPath(session.repo, id, state.revision),
      stringify(warnings),
    );
    if (changelog !== undefined && changelog.trim() !== "") {
      writeFileAtomic(paths.revisionChangelogPath(session.repo, id, state.revision), changelog);
    }
    writeFileAtomic(paths.sessionStatePath(session.repo, id), stringify(state));
    session.updatedAt = new Date().toISOString();
    this.flushRegistry();
    return state.revision;
  }

  readRevision(id: string, n: number): string {
    const session = this.require(id);
    return readFileSync(paths.revisionPath(session.repo, id, n), "utf8");
  }

  /** The changelog submitted with r<n>.md; null when none was (r1, typically). */
  readRevisionChangelog(id: string, n: number): string | null {
    const session = this.require(id);
    try {
      return readFileSync(paths.revisionChangelogPath(session.repo, id, n), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Warnings recorded with r<n>.md. Missing or corrupt files read as [] — the
   * badges are presentation metadata, never worth quarantine machinery.
   */
  readRevisionWarnings(id: string, n: number): LintIssue[] {
    const session = this.require(id);
    const raw = readJsonOr(paths.revisionWarningsPath(session.repo, id, n));
    return Array.isArray(raw) ? (raw as LintIssue[]) : [];
  }

  /** Where this session's SessionQueue persists — for the daemon to wire queues. */
  eventsPath(id: string): string {
    return paths.eventsPath(this.require(id).repo, id);
  }

  /** Where this session's review threads persist (src/daemon/threads.ts). */
  threadsPath(id: string): string {
    return paths.threadsPath(this.require(id).repo, id);
  }

  /** Where this session's grill transcript persists (src/daemon/transcript.ts). */
  transcriptPath(id: string): string {
    return paths.transcriptPath(this.require(id).repo, id);
  }

  /** Where this session's live-activity feed persists (src/daemon/activity.ts). */
  activityPath(id: string): string {
    return paths.activityPath(this.require(id).repo, id);
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
