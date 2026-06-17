// Same-origin client for the daemon's HTTP API + SSE streams (DESIGN.md §6).
// Every stream opens with a `snapshot` frame, so these hooks never race a
// fetch against the event feed; an EventSource reconnect re-syncs the same way
// (DECISIONS.md "UI live updates: in-process Notifier, snapshot-first SSE").

import { useEffect, useMemo, useState } from "react";
import type { ConfigField, ScopeFieldError, ScopeValues } from "../shared/config";
import type {
  ActivityNote,
  Anchor,
  DiffHunk,
  DiffPayload,
  GrillAnswer,
  LintIssue,
  RevisionPayload,
  SectionDiff,
  SessionStatus,
  SessionSummary,
  Thread,
  TranscriptEntry,
} from "../shared/types";

export type { ConfigField, ScopeFieldError, ScopeValues };

export type {
  ActivityNote,
  Anchor,
  DiffHunk,
  DiffPayload,
  GrillAnswer,
  LintIssue,
  RevisionPayload,
  SectionDiff,
  SessionStatus,
  SessionSummary,
  Thread,
  TranscriptEntry,
};

/**
 * Newest progress notes the client keeps live (DESIGN.md §6). The daemon caps
 * the feed (config; default 20) and the snapshot reflects that — this is a
 * generous client safety bound so a tuned-up server cap still renders in full.
 */
const ACTIVITY_VIEW_CAP = 60;

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
    // Terminal: the session left the registry (clean or a UI delete) — drop its card.
    on<{ session: string }>(source, "removed", (data) => {
      setById((prev) => {
        if (!prev.has(data.session)) return prev;
        const next = new Map(prev);
        next.delete(data.session);
        return next;
      });
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
  /** The grill transcript, oldest first; live over `grill` frames (DESIGN.md §8). */
  transcript: TranscriptEntry[];
  /** The live-activity feed, oldest first; live over `activity` frames (DESIGN.md §6). */
  activity: ActivityNote[];
  missing: boolean;
  /** True once a `removed` frame lands: the session was cleaned/archived or deleted. */
  cleaned: boolean;
  connected: boolean;
}

/** Upsert frames (thread, grill) carry the full item: replace by id, or append. */
function upsertById<T extends { id: string }>(prev: T[], item: T): T[] {
  const at = prev.findIndex((x) => x.id === item.id);
  if (at === -1) return [...prev, item];
  const next = [...prev];
  next[at] = item;
  return next;
}

export function useSession(id: string): SessionDetail {
  const [session, setSession] = useState<LiveSession>();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [activity, setActivity] = useState<ActivityNote[]>([]);
  const [missing, setMissing] = useState(false);
  const [cleaned, setCleaned] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setSession(undefined);
    setThreads([]);
    setTranscript([]);
    setActivity([]);
    setMissing(false);
    setCleaned(false);
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
          // Threads and the transcript ride the snapshot (no separate fetch to
          // race) and arrive as upserts after that: an existing id is the
          // agent's answer (thread) or the user's answer (grill) landing.
          on<{
            session: SessionSummary;
            threads?: Thread[];
            transcript?: TranscriptEntry[];
            activity?: ActivityNote[];
          }>(source, "snapshot", (data) => {
            setSession(data.session);
            setThreads(data.threads ?? []);
            setTranscript(data.transcript ?? []);
            setActivity(data.activity ?? []);
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
            setThreads((prev) => upsertById(prev, thread)),
          );
          on<{ session: string; entry: TranscriptEntry }>(source, "grill", ({ entry }) =>
            setTranscript((prev) => upsertById(prev, entry)),
          );
          // Append-only feed: trim to the client view cap so a long session
          // can't grow it without bound (DESIGN.md §6).
          on<{ session: string; note: ActivityNote }>(source, "activity", ({ note }) =>
            setActivity((prev) => [...prev, note].slice(-ACTIVITY_VIEW_CAP)),
          );
          // Terminal: this session left the registry (clean/archive or a delete).
          // Close the stream — a reconnect would 404-loop against the deregistered
          // id — and let the screen render its closed state.
          on<{ session: string }>(source, "removed", () => {
            setCleaned(true);
            source?.close();
            setConnected(false);
          });
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

  return { session, threads, transcript, activity, missing, cleaned, connected };
}

const PRESENCE_HEARTBEAT_MS = 20_000;

/**
 * Report this session's review visibility to the daemon (DESIGN.md §6), so a
 * desktop banner is suppressed only while the user is actually looking. POSTs
 * {visible:true} when visible and on a ~20s heartbeat, {visible:false} on
 * visibilitychange→hidden, and a sendBeacon false on unload (the daemon's ~45s
 * TTL covers a crash that skips the unload ping). A hidden/backgrounded tab
 * keeps its SSE stream open but stops being "watched", so banners fire again.
 */
export function usePresence(id: string): void {
  useEffect(() => {
    const url = `/api/sessions/${id}/presence`;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const send = (visible: boolean): void => {
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visible }),
        keepalive: true,
      }).catch(() => undefined);
    };
    const stopHeartbeat = (): void => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    const sync = (): void => {
      if (document.visibilityState === "visible") {
        send(true);
        if (heartbeat === undefined) heartbeat = setInterval(() => send(true), PRESENCE_HEARTBEAT_MS);
      } else {
        stopHeartbeat();
        send(false);
      }
    };
    // sendBeacon survives page teardown where a keepalive fetch can still race.
    const onUnload = (): void => {
      navigator.sendBeacon?.(
        url,
        new Blob([JSON.stringify({ visible: false })], { type: "application/json" }),
      );
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pagehide", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pagehide", onUnload);
      stopHeartbeat();
      send(false); // leaving this screen un-suppresses immediately
    };
  }, [id]);
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
 * Post a follow-up question on an existing conversation (DESIGN.md §9): a new
 * linked question that inherits the root's anchor. `rootId` is the conversation
 * root the rail groups on; the new turn folds in over the `thread` SSE frame.
 */
export function postFollowup(id: string, rootId: string, body: string): Promise<boolean> {
  return post202(`/api/sessions/${id}/questions`, { replyTo: rootId, body });
}

/** The user's side of a grill question (DESIGN.md §8): chip choice(s) and/or text. */
export interface AnswerDraft {
  question: string;
  choice?: string;
  choices?: string[];
  text?: string;
}

/** Answer an agent grill question; the card settles via the `grill` SSE frame. */
export function postAnswer(id: string, draft: AnswerDraft): Promise<boolean> {
  return post202(`/api/sessions/${id}/answers`, draft);
}

/**
 * The approve outcome (DESIGN.md §6 step 6, §12): a finalize-now success carries
 * the saved `path` (Save = the project copy, Implement = the home copy) plus the
 * absolute `home` archive path, so the note is honest about every place the plan
 * landed; a **comment & approve** success carries `finalizing:true` instead (no
 * artifact yet — the agent's fold-in submit writes it, and the SSE `finalizing`
 * frame drives the screen). E_UNRESOLVED_THREADS carries `unresolved` (the warn
 * count) and `openComments` (whether *Send to agent* has anything to fold in).
 */
export type ApproveResult =
  | { ok: true; path: string; home: string; revision: number }
  | { ok: true; finalizing: true }
  | { ok: false; code: string; message?: string; unresolved?: number; openComments?: number };

/** The three approve modes, folded into the POST body (DESIGN.md §6, §12). */
export interface ApproveOptions {
  /** Carry past the unresolved-threads warning, force-dropping the open threads. */
  force?: boolean;
  /** Approve & Implement: finalize, then keep the agent building. */
  implement?: boolean;
  /** Comment & approve: defer the finalize, handing open comments to the agent. */
  sendOpenComments?: boolean;
}

/**
 * Approve the plan (DESIGN.md §6 step 6, §12). `implement:true` is the Approve &
 * Implement variant: the daemon finalizes the artifact exactly as a plain
 * approve, then flips the session to `implementing` (not over) and wakes the
 * agent with `implement:true` to build it. `sendOpenComments:true` is comment &
 * approve: the daemon defers the finalize (status `finalizing`) and hands the
 * agent the open comments to fold in — its next clean submit finalizes, carrying
 * the implement choice. `force` carries past the unresolved-threads warning.
 */
export async function postApprove(id: string, opts: ApproveOptions = {}): Promise<ApproveResult> {
  try {
    const request: { force?: true; implement?: true; sendOpenComments?: true } = {};
    if (opts.force) request.force = true;
    if (opts.implement) request.implement = true;
    if (opts.sendOpenComments) request.sendOpenComments = true;
    const res = await fetch(`/api/sessions/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = (await res.json()) as {
      path?: string;
      home?: string;
      revision?: number;
      finalizing?: boolean;
      unresolved?: number;
      openComments?: number;
      error?: { code?: string; message?: string };
    };
    if (res.ok && body.finalizing === true) {
      return { ok: true, finalizing: true };
    }
    if (res.ok && typeof body.path === "string") {
      return { ok: true, path: body.path, home: body.home ?? "", revision: body.revision ?? 0 };
    }
    return {
      ok: false,
      code: body.error?.code ?? "E_INTERNAL",
      message: body.error?.message,
      unresolved: body.unresolved,
      openComments: body.openComments,
    };
  } catch {
    return { ok: false, code: "E_UNREACHABLE" };
  }
}

/**
 * The delete outcome (DESIGN.md §6, §12): success is the 200; a failure carries
 * the daemon's own error code/message so the sheet can tell a real server fault
 * (a registry-flush throw → 500) apart from an unreachable daemon, instead of
 * blaming the network for either.
 */
export type DeleteResult = { ok: true } | { ok: false; code: string; message?: string };

/**
 * Permanently delete a pending (non-approved) session (DESIGN.md §6, §12): the
 * daemon hard-removes its working state and publishes the `removed` frame both
 * session hooks already handle, so callers need no local teardown — the card
 * drops / the screen closes off that frame. Resolves ok only on the 200.
 */
export async function postDelete(id: string): Promise<DeleteResult> {
  try {
    const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    return { ok: false, code: body.error?.code ?? "E_INTERNAL", message: body.error?.message };
  } catch {
    return { ok: false, code: "E_UNREACHABLE" };
  }
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

/** One scope's target file path and its sparse, currently-set overrides. */
export interface ConfigScope {
  path: string;
  values: ScopeValues;
  /** The absolute repo this project scope writes under — project scopes only. */
  repo?: string;
}

/** The three config scopes, in file-overlay precedence (low → high, §16). */
export type ConfigScopeName = "user" | "project" | "project.local";

/**
 * GET /api/config payload (DESIGN.md §6 config surface): the full field schema
 * plus each scope's target path and current values. `user` is always present;
 * `project` (team-shared) and `project.local` (personal) only when an absolute
 * `repo` was supplied.
 */
export interface ConfigPayload {
  schema: ConfigField[];
  scopes: { user: ConfigScope; project?: ConfigScope; "project.local"?: ConfigScope };
}

export interface ConfigState extends Partial<ConfigPayload> {
  loading: boolean;
  error: boolean;
  reload: () => void;
}

/**
 * Load the config schema + scopes for the Settings screen. Plain fetch on mount
 * and whenever `repo` changes — config is a flat document, not a stream, so no
 * EventSource (unlike the session hooks). The `repo` query param is omitted when
 * absent, so the daemon answers with the user scope alone. `reload` re-fetches
 * (Phase 4 calls it after a save); responses for a superseded request are
 * dropped so a fast scope/repo switch can't land stale data.
 */
export function useConfig(repo?: string): ConfigState {
  const [payload, setPayload] = useState<ConfigPayload>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(false);
    const url = repo ? `/api/config?repo=${encodeURIComponent(repo)}` : "/api/config";
    fetch(url, { headers: { accept: "application/json" } })
      .then((res) => {
        if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
        return res.json() as Promise<ConfigPayload>;
      })
      .then((data) => {
        if (!live) return;
        setPayload(data);
        setLoading(false);
      })
      .catch(() => {
        if (!live) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [repo, nonce]);

  return { schema: payload?.schema, scopes: payload?.scopes, loading, error, reload };
}

/**
 * The save outcome for POST /api/config (DESIGN.md §6 config surface). Success
 * echoes the persisted sparse values; 422 carries per-field validation errors
 * the Settings screen renders inline; 400/network carries a top-level error.
 */
export type SaveConfigResult =
  | { ok: true; values: ScopeValues }
  | { ok: false; status: number; fieldErrors?: ScopeFieldError[]; error?: { code: string; message: string } };

/**
 * Persist a scope's overrides (DESIGN.md §6): POSTs the sparse `values` to
 * /api/config, which REPLACES the scope file — so `values` must be the complete
 * desired override set (see settings-form.buildPayload). Parses the daemon's
 * 200 / 422 / 400 into a discriminated result; an unreachable daemon or a
 * non-JSON body lands as a status-0 error so the screen can message it.
 */
export async function saveConfig(
  scope: ConfigScopeName,
  repo: string | undefined,
  values: ScopeValues,
): Promise<SaveConfigResult> {
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(repo === undefined ? { scope, values } : { scope, repo, values }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      values?: ScopeValues;
      fieldErrors?: ScopeFieldError[];
      error?: { code?: string; message?: string };
    };
    if (res.ok && body.values) return { ok: true, values: body.values };
    if (res.status === 422) return { ok: false, status: 422, fieldErrors: body.fieldErrors ?? [] };
    return {
      ok: false,
      status: res.status,
      error: {
        code: body.error?.code ?? "E_INTERNAL",
        message: body.error?.message ?? "save failed",
      },
    };
  } catch {
    return { ok: false, status: 0, error: { code: "E_UNREACHABLE", message: "couldn't reach otacond" } };
  }
}
