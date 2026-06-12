// Same-origin client for the daemon's HTTP API + SSE streams (DESIGN.md §6).
// Every stream opens with a `snapshot` frame, so these hooks never race a
// fetch against the event feed; an EventSource reconnect re-syncs the same way
// (DECISIONS.md "UI live updates: in-process Notifier, snapshot-first SSE").

import { useEffect, useMemo, useState } from "react";
import type {
  LintIssue,
  RevisionPayload,
  SessionStatus,
  SessionSummary,
} from "../../src/shared/types";

export type { LintIssue, RevisionPayload, SessionStatus, SessionSummary };

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
  missing: boolean;
  connected: boolean;
}

export function useSession(id: string): SessionDetail {
  const [session, setSession] = useState<LiveSession>();
  const [missing, setMissing] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setSession(undefined);
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
          on<{ session: SessionSummary }>(source, "snapshot", (data) => setSession(data.session));
          on<{ session: SessionSummary }>(source, "session", (data) =>
            setSession({ ...data.session, changedAt: Date.now() }),
          );
          on<{ session: string; revision: number }>(source, "revision", (data) =>
            setSession((prev) => (prev ? { ...prev, revision: data.revision, changedAt: Date.now() } : prev)),
          );
          on<{ session: string; pending: number }>(source, "queue", (data) =>
            setSession((prev) => (prev ? { ...prev, pendingEvents: data.pending } : prev)),
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

  return { session, missing, connected };
}

/**
 * The stored revision `n` (markdown + the warnings it was accepted with).
 * Re-fetches when `n` bumps — the session stream's `revision` frame drives
 * that — while keeping the previous payload rendered, so a live update swaps
 * content without a loading flash. Failed fetches retry; recovery from a
 * daemon restart is automatic.
 */
export function useRevision(id: string, n: number): RevisionPayload | undefined {
  const [payload, setPayload] = useState<RevisionPayload>();

  useEffect(() => {
    if (n < 1) {
      setPayload(undefined);
      return;
    }
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (): void => {
      fetch(`/api/sessions/${id}/revisions/${n}`, { headers: { accept: "application/json" } })
        .then((res) => {
          if (!res.ok) throw new Error(`revision fetch failed: ${res.status}`);
          return res.json() as Promise<RevisionPayload>;
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
  }, [id, n]);

  return payload;
}
