// Global session registry, per-session daemon state, and revision snapshots
// (DESIGN.md §7, §12). All state is plain JSON written atomically — temp file +
// rename — so a crash can never leave a half-written file (DECISIONS.md
// "Storage: plain JSON files, not SQLite"). A file that is corrupt anyway
// (manual edit, disk fault) is quarantined, never fatal: it is renamed aside
// and the daemon continues with a fresh structure (DECISIONS.md "Corrupt state
// files are quarantined, not fatal") — a permanently wedged daemon is worse
// than one recoverable file.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as paths from "../shared/paths.js";
import type { RegistryFile, RegistrySession, SessionStateFile } from "../shared/types.js";

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
  renameSync(path, aside);
  process.stderr.write(
    `otacond: ${what} at ${path} is corrupt; moved it to ${aside} and continuing with fresh state\n`,
  );
  return aside;
}

function readJsonOr(path: string): unknown {
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
  return valid ? file : undefined;
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
    patch: Partial<Pick<RegistrySession, "title" | "status">>,
  ): RegistrySession {
    const session = this.require(id);
    Object.assign(session, patch);
    session.updatedAt = new Date().toISOString();
    this.flushRegistry();
    return { ...session };
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
    // plan history — restarting at r1 would overwrite them); counters restart
    // at 0, so post-quarantine b/t/q ids and seqs can repeat — detectable
    // duplicates, per the at-least-once contract (DECISIONS.md "Corrupt state
    // files are quarantined, not fatal").
    const state: SessionStateFile = {
      id,
      revision: recoverRevision(session.repo, id),
      counters: { batch: 0, thread: 0, question: 0, eventSeq: 0 },
    };
    writeFileAtomic(path, stringify(state));
    return state;
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

  /** Store the next revision snapshot r<N>.md (DESIGN.md §12); returns N. */
  saveRevision(id: string, content: string): number {
    const session = this.require(id);
    const state = this.readState(id);
    state.revision += 1;
    writeFileAtomic(paths.revisionPath(session.repo, id, state.revision), content);
    writeFileAtomic(paths.sessionStatePath(session.repo, id), stringify(state));
    session.updatedAt = new Date().toISOString();
    this.flushRegistry();
    return state.revision;
  }

  readRevision(id: string, n: number): string {
    const session = this.require(id);
    return readFileSync(paths.revisionPath(session.repo, id, n), "utf8");
  }

  /** Where this session's SessionQueue persists — for the daemon to wire queues. */
  eventsPath(id: string): string {
    return paths.eventsPath(this.require(id).repo, id);
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
