// Same-origin client for the daemon's HTTP API + SSE streams (DESIGN.md §6).
// Every stream opens with a `snapshot` frame, so these hooks never race a
// fetch against the event feed; an EventSource reconnect re-syncs the same way
// (DECISIONS.md "UI live updates: in-process Notifier, snapshot-first SSE").

import { useEffect, useMemo, useState } from "react";
import type {
  Anchor,
  DiffHunk,
  DiffPayload,
  LintIssue,
  RevisionPayload,
  SectionDiff,
  SessionStatus,
  SessionSummary,
  Thread,
} from "../../src/shared/types";

export type {
  Anchor,
  DiffHunk,
  DiffPayload,
  LintIssue,
  RevisionPayload,
  SectionDiff,
  SessionStatus,
  SessionSummary,
  Thread,
};

/** A summary plus the client-side "this card just changed" timestamp. */
export interface LiveSession extends SessionSummary {
  changedAt?: number;
}

type SessionMap = ReadonlyMap<string, LiveSession>;

function on<T>(source: EventSource, type: string, handler: (data: T) => void): void {
  source.addEventListener(type, (event) => {
    handler(JSON.parse((event as MessageEvent<string>).data) as T);
  });
}

function patch(prev: SessionMap, id: string, fields: Partial<LiveSession>): SessionMap {
  const existing = prev.get(id);
  if (!existing) return prev;
  return new Map(prev).set(id, { ...existing, ...fields, changedAt: Date.now() });
}

export function useSessions(): { sessions: LiveSession[]; connected: boolean } {
  const [byId, setById] = useState<SessionMap>(new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false); // EventSource retries on its own
    on<{ sessions: SessionSummary[] }>(source, "snapshot", ({ sessions }) => {
      setById(new Map(sessions.map((s) => [s.id, s])));
    });
    on<{ session: SessionSummary }>(source, "session", ({ session }) => {
      setById((prev) =>
        new Map(prev).set(session.id, { ...session, changedAt: prev.has(session.id) ? Date.now() : undefined }),
      );
    });
    on<{ session: string; revision: number }>(source, "revision", (data) => {
      setById((prev) => patch(prev, data.session, { revision: data.revision }));
    });
    on<{ session: string; pending: number }>(source, "queue", (data) => {
      setById((prev) => patch(prev, data.session, { pendingEvents: data.pending }));
    });
    return () => source.close();
  }, []);

  const sessions = useMemo(
    () => [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [byId],
  );
  return { sessions, connected };
}

export interface SessionDetail {
  session?: LiveSession;
  /** Review threads, oldest first; live over the stream's `thread` frames. */
  threads: Thread[];
  missing: boolean;
  connected: boolean;
}

export function useSession(id: string): SessionDetail {
  const [session, setSession] = useState<LiveSession>();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [missing, setMissing] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setSession(undefined);
    setThreads([]);
    setMissing(false);
    setConnected(false);
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    // Probe first: an unknown id should say so instead of retrying a 404 stream
    // forever. A failed probe retries — fetch() has no EventSource-style
    // auto-reconnect, and without one a daemon restart would strand this
    // screen on "connecting…" until a manual reload.
    const probe = (): void => {
      fetch(`/api/sessions/${id}`)
        .then((res) => {
          if (disposed) return;
          if (res.status === 404) {
            setMissing(true);
            return;
          }
          if (!res.ok) {
            retry = setTimeout(probe, 2000);
            return;
          }
          source = new EventSource(`/api/sessions/${id}/stream`);
          source.onopen = () => setConnected(true);
          source.onerror = () => setConnected(false);
          // Threads ride the snapshot (no separate fetch to race) and arrive
          // as upserts after that: an existing id is the agent's answer landing.
          on<{ session: SessionSummary; threads?: Thread[] }>(source, "snapshot", (data) => {
            setSession(data.session);
            setThreads(data.threads ?? []);
          });
          on<{ session: SessionSummary }>(source, "session", (data) =>
            setSession({ ...data.session, changedAt: Date.now() }),
          );
          on<{ session: string; revision: number }>(source, "revision", (data) =>
            setSession((prev) => (prev ? { ...prev, revision: data.revision, changedAt: Date.now() } : prev)),
          );
          on<{ session: string; pending: number }>(source, "queue", (data) =>
            setSession((prev) => (prev ? { ...prev, pendingEvents: data.pending } : prev)),
          );
          on<{ session: string; thread: Thread }>(source, "thread", ({ thread }) =>
            setThreads((prev) => {
              const at = prev.findIndex((t) => t.id === thread.id);
              if (at === -1) return [...prev, thread];
              const next = [...prev];
              next[at] = thread;
              return next;
            }),
          );
        })
        .catch(() => {
          // daemon unreachable: keep probing so recovery is automatic
          if (!disposed) retry = setTimeout(probe, 2000);
        });
    };
    probe();
    return () => {
      disposed = true;
      if (retry !== undefined) clearTimeout(retry);
      source?.close();
    };
  }, [id]);

  return { session, threads, missing, connected };
}

/** A drawer item not yet flushed to the daemon (DESIGN.md §9 batching). */
export interface CommentDraft {
  anchor: Anchor | null;
  body: string;
}

/** POST a JSON payload; resolves true only on the daemon's 202 accept. */
async function post202(path: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.status === 202;
  } catch {
    return false;
  }
}

/** Flush comment drafts as one batch; resolves false when the POST failed. */
export function postComments(id: string, items: CommentDraft[]): Promise<boolean> {
  return post202(`/api/sessions/${id}/comments`, { items });
}

/** Fire a question instantly (DESIGN.md §9); the answer arrives as a thread frame. */
export function postQuestion(id: string, anchor: Anchor | null, body: string): Promise<boolean> {
  return post202(`/api/sessions/${id}/questions`, { anchor, body });
}

/**
 * Mark a revision reviewed (DESIGN.md §9 layer 3) — the banner's dismiss and
 * the explicit "mark reviewed" both land here. The daemon answers with a
 * session SSE frame carrying the moved baseline, so callers need no local
 * state: banner visibility and gutter markers are derived from the summary.
 */
export async function postReviewed(id: string, revision?: number): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${id}/reviewed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(revision === undefined ? {} : { revision }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * GET `path` as JSON, retrying every 2s on failure (recovery from a daemon
 * restart is automatic), with responses for an abandoned path ignored. The
 * previous payload stays rendered while the next one is in flight, so a live
 * update swaps content without a loading flash; `null` clears it.
 */
function usePolledJson<T>(path: string | null): T | undefined {
  const [payload, setPayload] = useState<T>();

  useEffect(() => {
    if (path === null) {
      setPayload(undefined);
      return;
    }
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (): void => {
      fetch(path, { headers: { accept: "application/json" } })
        .then((res) => {
          if (!res.ok) throw new Error(`fetch failed: ${res.status} ${path}`);
          return res.json() as Promise<T>;
        })
        .then((data) => {
          if (live) setPayload(data);
        })
        .catch(() => {
          if (live) retry = setTimeout(load, 2000);
        });
    };
    load();
    return () => {
      live = false;
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [path]);

  return payload;
}

/**
 * The structural diff `from` → `to` (DESIGN.md §6). One payload drives both
 * the diff view's hunks and the clean view's gutter markers, so it is fetched
 * whenever a plan exists. Refetches when either endpoint moves (a new
 * revision over SSE, a baseline pick, a dismiss moving last-reviewed).
 */
export function useDiff(id: string, from: number, to: number): DiffPayload | undefined {
  return usePolledJson<DiffPayload>(
    to < 1 ? null : `/api/sessions/${id}/diff?from=${from}&to=${to}`,
  );
}

/**
 * The stored revision `n` (markdown + the warnings it was accepted with).
 * Re-fetches when `n` bumps — the session stream's `revision` frame drives
 * that.
 */
export function useRevision(id: string, n: number): RevisionPayload | undefined {
  return usePolledJson<RevisionPayload>(n < 1 ? null : `/api/sessions/${id}/revisions/${n}`);
}
