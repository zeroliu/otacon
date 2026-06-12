// Global session registry, per-session daemon state, and revision snapshots
// (DESIGN.md §7, §12). All state is plain JSON written atomically — temp file +
// rename — so a crash can never leave a half-written file (DECISIONS.md
// "Storage: plain JSON files, not SQLite").

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as paths from "../shared/paths.js";
import type { RegistryFile, RegistrySession, SessionStateFile } from "../shared/types.js";

let tmpSerial = 0;

/** Atomic write: temp file in the destination directory (created if needed) + rename. */
export function writeFileAtomic(path: string, data: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${process.pid}-${tmpSerial++}`);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`corrupt ${what}: ${path}`, { cause });
  }
}

function parseRegistry(raw: unknown, path: string): RegistryFile {
  const file = raw as RegistryFile;
  if (
    typeof file !== "object" ||
    file === null ||
    file.version !== 1 ||
    typeof file.sessions !== "object" ||
    file.sessions === null
  ) {
    throw new Error(`corrupt registry: ${path}`);
  }
  return file;
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
    this.registry = existsSync(this.registryFile)
      ? parseRegistry(readJson(this.registryFile, "registry"), this.registryFile)
      : { version: 1, sessions: {} };
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
    this.registry.sessions[id] = session;
    this.flushRegistry();
    const state: SessionStateFile = {
      id,
      revision: 0,
      counters: { batch: 0, thread: 0, question: 0, eventSeq: 0 },
    };
    writeFileAtomic(paths.sessionStatePath(input.repo, id), stringify(state));
    writeFileAtomic(paths.eventsPath(input.repo, id), stringify({ version: 1, events: [] }));
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
    return readJson(path, "session state") as SessionStateFile;
  }

  /** Increment one daemon-owned counter (DESIGN.md §6 stable ids) and persist it. */
  bumpCounter(id: string, key: keyof SessionStateFile["counters"]): number {
    const session = this.require(id);
    const state = this.readState(id);
    state.counters[key] += 1;
    writeFileAtomic(paths.sessionStatePath(session.repo, id), stringify(state));
    return state.counters[key];
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
