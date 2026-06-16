// otacond's HTTP surface (DESIGN.md §6 "HTTP API sketch"), as a Hono app
// factory so tests drive it via app.request() with no socket.
//
// Long-poll delivery honors at-least-once (DECISIONS.md "SessionQueue API"):
// an event is acked with queue.flush(event) only once the response bytes are
// out. Under @hono/node-server the env carries the Node ServerResponse
// (`outgoing`), whose "close" event fires exactly once per response —
// writableFinished there distinguishes delivered (ack) from client-aborted
// (requeue). Accessing c.req.raw.signal materializes node-server's lazy
// AbortController, so a client that drops a *parked* poll aborts the signal
// and the waiter is canceled without consuming anything.

import { Hono } from "hono";
import type { Context } from "hono";
import type { ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import {
  CONFIG_SCHEMA,
  loadConfig,
  readScopeValues,
  validateScopeInput,
} from "../shared/config.js";
import type { ScopeValues } from "../shared/config.js";
import {
  globalConfigPath,
  otaconPort,
  repoConfigPath,
  repoLocalConfigPath,
} from "../shared/paths.js";
import { parseQuestionSpec } from "../shared/question-spec.js";
import { TERMINAL_STATUSES } from "../shared/types.js";
import type {
  Anchor,
  CommentItem,
  DiffPayload,
  EventPayload,
  GrillAnswer,
  QuestionSpec,
  QueuedEvent,
  RegistrySession,
  Resolutions,
  RevisionPayload,
  SessionSummary,
  Thread,
  TranscriptEntry,
} from "../shared/types.js";
import { VERSION } from "../shared/version.js";
import { appendActivity, latestNote, readActivity } from "./activity.js";
import type { ReviewNote } from "./approve.js";
import { composeArtifact, localDate, pickHomePath, pickProjectRelPath } from "./approve.js";
import type { DesktopNotifier } from "./desktop-notify.js";
import { createDesktopNotifier } from "./desktop-notify.js";
import { diffPlans } from "./diff.js";
import { lint } from "./linter/index.js";
import { Notifier } from "./notify.js";
import { Presence } from "./presence.js";
import type { ParkHandle } from "./queue.js";
import { SessionQueue } from "./queue.js";
import type { Store } from "./store.js";
import { writeFileAtomic } from "./store.js";
import {
  answerQuestion,
  appendThreads,
  applyRevisionToThreads,
  commentThreadStates,
  openCommentThreads,
  readThreads,
} from "./threads.js";
import { answerEntry, appendEntries, appendEntry, readTranscript } from "./transcript.js";
import { registerUiRoutes } from "./ui.js";

/** Provided by @hono/node-server; absent under app.request() in tests. */
export interface NodeBindings {
  outgoing?: ServerResponse;
}

export interface AppOptions {
  store: Store;
  /** Invoked once POST /api/shutdown's response is out; main.ts exits in it. */
  onShutdown?: () => void;
  /** Test override: where the built SPA lives (null = no UI). Default: resolved next to the module. */
  uiDir?: string | null;
  /** Test override for the SSE heartbeat interval. */
  sseHeartbeatMs?: number;
  /** Test override: visibility tracker (default: a fresh Presence with the 45s TTL). */
  presence?: Presence;
  /** Test override: the desktop notify sink (default: the real macOS notifier, a no-op off darwin). */
  notify?: DesktopNotifier;
}

type AppContext = Context<{ Bindings: NodeBindings }>;

/** Hard ceiling on ?wait= (seconds); agents ask for 540 under their 600s Bash cap. */
const MAX_WAIT_SECONDS = 600;

const badRequest = (c: AppContext, message: string) =>
  c.json({ error: { code: "E_BAD_REQUEST", message } }, 400);
const notFound = (c: AppContext, message: string) =>
  c.json({ error: { code: "E_NOT_FOUND", message } }, 404);
const timeoutEvent = (c: AppContext) => c.json({ event: "timeout" });
// A session in a terminal state is over (DESIGN.md §6, §12 status machine):
// every state-mutating verb refuses — the CLI's pointer rules guard its side,
// but curl/UI/--session calls must hit the same wall. Each route checks *after*
// its body await (see sessionEnded in createApp): a pre-await snapshot goes
// stale when a concurrent approve lands while the bytes stream in. (Note
// `implementing` is non-terminal — it deliberately re-opens the mutating verbs
// while the agent builds the approved plan, so it does NOT trip this wall.)
const sessionOver = (c: AppContext, id: string) =>
  c.json(
    { error: { code: "E_SESSION_OVER", message: `session ${id} is over (terminal)` } },
    409,
  );
// `implementing` is non-terminal so it slips past sessionOver, but a build is
// under way: submit would clobber the approved plan, and a re-approve would
// re-write the artifact. Both verbs refuse with this shared 409.
const alreadyImplementing = (c: AppContext, id: string) =>
  c.json(
    { error: { code: "E_ALREADY_IMPLEMENTING", message: `session ${id} is already implementing` } },
    409,
  );
// `finalizing` is non-terminal (the agent's fold-in submit must still mutate),
// but it is a locked window: only that solo fold-in pass may touch the session.
// A reviewer comment here would clobber the status back to `revising` while
// `pendingApproval` stayed armed (a later clean submit would then silently
// finalize) and hand the agent an un-swept thread that wedges L5. Refuse it.
const alreadyFinalizing = (c: AppContext, id: string) =>
  c.json(
    {
      error: {
        code: "E_ALREADY_FINALIZING",
        message: `session ${id} is finalizing; the agent is folding in comments`,
      },
    },
    409,
  );

async function readJsonBody(c: AppContext): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await c.req.json();
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** null/undefined = whole-plan; otherwise require {section} and keep known keys only. */
function parseAnchor(raw: unknown): Anchor | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return undefined;
  const { section, exact, prefix, suffix } = raw as Record<string, unknown>;
  if (typeof section !== "string" || section === "") return undefined;
  const anchor: Anchor = { section };
  if (typeof exact === "string") anchor.exact = exact;
  if (typeof prefix === "string") anchor.prefix = prefix;
  if (typeof suffix === "string") anchor.suffix = suffix;
  return anchor;
}

/**
 * Validate the submit body's `resolutions` (DESIGN.md §6): an object with
 * only `changelog` (string) and `threads` (string → string). Strict — an
 * unknown key is a typo that would silently drop resolutions, so it refuses.
 * undefined/null = none provided ({}); any other bad shape = undefined.
 */
function parseResolutions(raw: unknown): Resolutions | undefined {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Resolutions = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "changelog" && typeof value === "string") {
      out.changelog = value;
    } else if (key === "threads" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Null-prototype: JSON.parse can hand us an own "__proto__" key, and
      // assigning it onto a plain object silently drops it — the strict shape
      // must surface it to L5 (E_UNKNOWN_THREAD) instead.
      const threads: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [id, reply] of Object.entries(value as Record<string, unknown>)) {
        if (typeof reply !== "string") return undefined;
        threads[id] = reply;
      }
      out.threads = threads;
    } else {
      return undefined;
    }
  }
  return out;
}

/** Build a transcript entry from a validated spec and its minted q<n> id. */
function entryFromSpec(id: string, spec: QuestionSpec, askedAt: string): TranscriptEntry {
  // `spec` is already normalized (no absent/false keys), so spreading it is the
  // whole asked shape — keep this in lockstep with QuestionSpec, not field-wise.
  return { id, ...spec, askedAt };
}

/** True when the Origin header names this daemon itself (the M2 web UI). */
function sameOrigin(origin: string, host: string | undefined): boolean {
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false; // opaque origins ("null") and garbage are foreign
  }
}

export function createApp(options: AppOptions): Hono<{ Bindings: NodeBindings }> {
  const { store } = options;

  // One queue instance per session for the daemon's lifetime — every request
  // must park on / enqueue into the same in-memory waiter list, and the
  // SessionQueue constructor re-reads disk (it would resurrect unacked
  // in-flight events if constructed per request).
  const queues = new Map<string, SessionQueue>();
  const queueFor = (id: string): SessionQueue => {
    let queue = queues.get(id);
    if (!queue) {
      queue = new SessionQueue(store.eventsPath(id));
      queues.set(id, queue);
    }
    return queue;
  };

  const sessionFor = (c: AppContext) => store.getSession(c.req.param("id") ?? "");

  // Mutating routes call this after their last await: reading the request
  // body yields, and a concurrent approve can flip the session mid-read — a
  // status captured before the await would let the stale handler mutate (or
  // re-approve) an ended session. Everything from this re-check to the state
  // writes is synchronous, so the answer cannot rot again. Gates on the
  // terminal set (TERMINAL_STATUSES), so an `implementing` session — which
  // re-opens the mutating verbs — sails through.
  const sessionEnded = (id: string): boolean => {
    const status = store.getSession(id)?.status;
    return status !== undefined && TERMINAL_STATUSES.includes(status);
  };

  // Agent presence (DESIGN.md §6): ephemeral, in-memory liveness only — the
  // epoch-ms of each session's last agent contact. Every mutating verb and each
  // `wait` park bumps it; the summary exposes it (plus `parked`) and the UI
  // derives live/offline from its recency, so the daemon needs no timer. A
  // restart starts empty (offline until the next call), which is correct.
  const lastContact = new Map<string, number>();
  const bumpContact = (id: string): void => {
    lastContact.set(id, Date.now());
  };

  // UI pub/sub (DECISIONS.md "UI live updates"): every state mutation below
  // publishes, and the SSE routes in ui.ts fan the events out to browsers.
  const notifier = new Notifier();
  const summarize = (session: RegistrySession): SessionSummary => {
    const state = store.readState(session.id);
    return {
      ...session,
      revision: state.revision,
      lastReviewedRevision: state.lastReviewedRevision,
      pendingEvents: queueFor(session.id).size,
      openQuestions: readTranscript(store.transcriptPath(session.id)).filter(
        (e) => e.answer === undefined,
      ).length,
      latestActivity: latestNote(store.activityPath(session.id)),
      lastContactAt: lastContact.get(session.id),
      parked: queueFor(session.id).waiterCount > 0,
    };
  };
  const publishSession = (session: RegistrySession): void =>
    notifier.publish({ type: "session", session: session.id, data: { session: summarize(session) } });
  const publishQueue = (id: string, pending: number): void =>
    notifier.publish({ type: "queue", session: id, data: { session: id, pending } });
  const publishThread = (id: string, thread: Thread): void =>
    notifier.publish({ type: "thread", session: id, data: { session: id, thread } });
  const publishGrill = (id: string, entry: TranscriptEntry): void =>
    notifier.publish({ type: "grill", session: id, data: { session: id, entry } });

  // Desktop attention banners (DESIGN.md §6). Presence tracks which sessions
  // have a *visible* review open; the notify sink fires the native macOS banner
  // (a no-op off darwin). Both are injectable for tests.
  const presence = options.presence ?? new Presence();
  const notify = options.notify ?? createDesktopNotifier();

  /**
   * Fire a desktop banner for an attention moment unless the user is already
   * watching this session's review (presence) or has disabled them (config,
   * loaded fresh per session.repo so a repo override applies). The whole thing
   * is wrapped: a spawn or config error must never break the submit/ask response
   * — it is swallowed to stderr (DESIGN.md §13: zero-API-spend untouched; this
   * is a local OS call).
   */
  const maybeNotify = (
    session: RegistrySession,
    moment:
      | { kind: "question"; text: string }
      | { kind: "questions"; count: number }
      | { kind: "revision"; revision: number },
  ): void => {
    try {
      if (!loadConfig(session.repo).notifications.desktop) return;
      if (presence.isWatched(session.id)) return;
      const message =
        moment.kind === "revision"
          ? `Revision r${moment.revision} ready for review`
          : moment.kind === "questions"
            ? `${moment.count} questions need your answer`
            : moment.text.length > 80
              ? `${moment.text.slice(0, 79)}…`
              : moment.text;
      notify({
        title: session.title,
        message,
        url: `http://127.0.0.1:${otaconPort()}/s/${session.id}`,
      });
    } catch (error) {
      process.stderr.write(
        `otacond: desktop notification failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };

  /** Respond with the event; ack only after the bytes are out (see header comment). */
  function respondEvent(c: AppContext, queue: SessionQueue, event: QueuedEvent): Response {
    const session = event.payload.session;
    const outgoing = c.env?.outgoing;
    if (!outgoing) {
      queue.flush(event); // app.request() test path: no socket to wait on
      publishQueue(session, queue.size);
    } else if (outgoing.destroyed || outgoing.closed) {
      // Client vanished before we built the response. The closed check matters:
      // once "close" has fired, a listener added below would never run and the
      // event would sit unacked-unrequeued in the in-flight list until restart.
      queue.requeue(event);
    } else {
      outgoing.once("close", () => {
        if (outgoing.writableFinished) queue.flush(event);
        else queue.requeue(event);
        publishQueue(session, queue.size);
      });
    }
    return c.json(event.payload);
  }

  /**
   * Finalize an approval (DESIGN.md §6 step 6/7, §12). Otacon never git-commits
   * the plan; it only writes the composed artifact (with the comment-&-approve
   * `## Review notes` when `reviewNotes` are present). It ALWAYS writes the
   * canonical home copy (`~/.otacon/sessions/<id>/`, the permanent archive).
   * On **Save** (implement=false) it ALSO writes a project copy under the repo's
   * configured `plans.dir`, and the event `path` points there. On **Implement**
   * (implement=true) it writes home only, and `path` equals `home`. The home
   * write is the crash-safe finalize point — file(s) before the status flip.
   * Then flip the session to `approved` or `implementing`, disarm any deferred
   * approval, and queue the `approved` wake-up. Shared by plain/force approve and
   * the deferred fold-in submit so the artifact and event shapes are identical on
   * every path. Returns the event's `path` and absolute `home`.
   */
  const finalizeApproval = (
    session: RegistrySession,
    opts: { revision: number; markdown: string; implement: boolean; reviewNotes?: ReviewNote[] },
  ): { path: string; home: string } => {
    const artifact = composeArtifact(opts.markdown, {
      revision: opts.revision,
      entries: readTranscript(store.transcriptPath(session.id)),
      reviewNotes: opts.reviewNotes,
    });
    const date = localDate();
    const home = pickHomePath(session.id, session.title, date);
    writeFileAtomic(home, artifact);
    // Save writes a project copy and reports it; Implement builds from home, so
    // nothing is written into the project and `path` is the home copy.
    let path = home;
    if (!opts.implement) {
      const plansDir = loadConfig(session.repo).plans.dir;
      const relPath = pickProjectRelPath(session.repo, plansDir, session.title, date);
      writeFileAtomic(join(session.repo, relPath), artifact);
      path = relPath;
    }
    const updated = store.updateSession(session.id, {
      status: opts.implement ? "implementing" : "approved",
    });
    // Disarm after the flip: a crash between them leaves a stale flag on an
    // already-terminal/building session (harmless — no further submit finalizes),
    // never a finalizing session that lost its flag (which would re-open review).
    store.clearPendingApproval(session.id);
    const payload: EventPayload = opts.implement
      ? { event: "approved", session: session.id, path, home, implement: true }
      : { event: "approved", session: session.id, path, home };
    queueFor(session.id).enqueue(payload, store.bumpCounter(session.id, "eventSeq"));
    publishSession(updated); // after the enqueue, so the summary carries the fresh pending count
    return { path, home };
  };

  const app = new Hono<{ Bindings: NodeBindings }>();

  // Loopback binding doesn't stop a malicious webpage from firing fetch() at
  // 127.0.0.1 (no-cors requests are delivered even though the response is
  // opaque). Browsers always attach Origin to cross-origin POSTs; the CLI and
  // curl send none, and the M2 web UI is same-origin — so a foreign Origin on
  // a state-changing call is refused (DECISIONS.md "Foreign-Origin requests").
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && origin !== undefined && !sameOrigin(origin, c.req.header("host"))) {
      return c.json(
        { error: { code: "E_FORBIDDEN", message: "cross-origin requests are refused" } },
        403,
      );
    }
    await next();
  });

  app.onError((error, c) =>
    c.json({ error: { code: "E_INTERNAL", message: error.message } }, 500),
  );
  app.notFound((c) =>
    c.json(
      { error: { code: "E_NOT_FOUND", message: `no route: ${c.req.method} ${c.req.path}` } },
      404,
    ),
  );

  app.get("/api/health", (c) =>
    c.json({ app: "otacond", version: VERSION, pid: process.pid }),
  );

  // The Settings UI's config surface (DESIGN.md §6). GET returns the full
  // schema plus each scope's current sparse, coerced values. The `user` scope
  // (~/.otacon/config.json) is always present; the project scopes only when an
  // absolute `repo` is named — User config needs no repo, so an absent/empty/
  // non-absolute `repo` omits them (matching the isAbsolute guard POST applies
  // to the write). `project` is the committed <repo>/.otacon/config.json;
  // `project.local` is the gitignored <repo>/.otacon/config.local.json override.
  app.get("/api/config", (c) => {
    const repo = c.req.query("repo");
    const scopes: Record<string, { path: string; values: ScopeValues; repo?: string }> = {
      user: { path: globalConfigPath(), values: readScopeValues(globalConfigPath()) },
    };
    if (repo !== undefined && repo !== "" && isAbsolute(repo)) {
      const projectPath = repoConfigPath(repo);
      const localPath = repoLocalConfigPath(repo);
      scopes.project = { path: projectPath, values: readScopeValues(projectPath), repo };
      scopes["project.local"] = { path: localPath, values: readScopeValues(localPath), repo };
    }
    return c.json({ schema: CONFIG_SCHEMA, scopes });
  });

  // POST replaces one scope file with the sanitized sparse values
  // (DECISIONS.md "Config POST replaces"). A field the UI cleared is absent
  // from `values` and so is dropped from the file — it reverts to inherited.
  // `scope` must be "user", "project", or "project.local"; both project scopes
  // require a `repo` (400 otherwise). Validation failures return 422 with
  // per-field errors and write nothing. The same-origin guard above (covering
  // every non-GET /api/*) protects this mutating call.
  app.post("/api/config", async (c) => {
    const body = (await readJsonBody(c)) ?? {};
    const { scope, repo } = body;
    if (scope !== "user" && scope !== "project" && scope !== "project.local") {
      return badRequest(c, 'scope must be "user", "project", or "project.local"');
    }
    let path: string;
    if (scope === "user") {
      path = globalConfigPath();
    } else {
      if (typeof repo !== "string" || !isAbsolute(repo)) {
        return badRequest(c, "project scope requires an absolute repo path");
      }
      path = scope === "project" ? repoConfigPath(repo) : repoLocalConfigPath(repo);
    }
    const result = validateScopeInput(body.values);
    if (result.errors.length > 0) {
      return c.json({ fieldErrors: result.errors }, 422);
    }
    // Replace, don't merge: writeFileAtomic mkdir -p's the parent, so the
    // already-present .otacon/ (or a missing ~/.otacon/) is handled either way.
    writeFileAtomic(path, JSON.stringify(result.values, null, 2));
    return c.json({ values: result.values });
  });

  app.post("/api/shutdown", (c) => {
    // Fire the hook only once the response is out (or the client is already
    // gone): main.ts exits the process in it, and a timing guess would race
    // the response flush.
    const outgoing = c.env?.outgoing;
    if (outgoing && !outgoing.destroyed && !outgoing.closed) {
      outgoing.once("close", () => options.onShutdown?.());
    } else {
      options.onShutdown?.();
    }
    return c.json({ ok: true });
  });

  app.get("/api/sessions", (c) => c.json({ sessions: store.listSessions() }));

  app.post("/api/sessions", async (c) => {
    const body = (await readJsonBody(c)) ?? {};
    const { title, repo, branch, quick } = body;
    if (typeof title !== "string" || title.trim() === "") {
      return badRequest(c, "title must be a non-empty string");
    }
    if (typeof repo !== "string" || !isAbsolute(repo)) {
      return badRequest(c, "repo must be an absolute path");
    }
    if (branch !== undefined && typeof branch !== "string") {
      return badRequest(c, "branch must be a string");
    }
    if (quick !== undefined && typeof quick !== "boolean") {
      return badRequest(c, "quick must be a boolean");
    }
    const session = store.createSession({ title, repo, branch, quick });
    publishSession(session);
    return c.json(session, 201);
  });

  app.get("/api/sessions/:id", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    return c.json(summarize(session));
  });

  // DELETE removes a session from the registry, status-branched on whether its
  // plan is already preserved (DESIGN.md §6, §12). **Terminal** (approved, plus
  // implemented/implement_failed once a build finishes): its plan + transcript
  // are in the home archive (~/.otacon/sessions/<id>/, never touched here), so the
  // working dir is *archived* to .otacon/archive/ (recoverable) — `otacon clean`
  // and the UI's delete of an
  // over session both take this path. Gated on TERMINAL_STATUSES so this split
  // agrees with the UI's `over` (which passes `approved={isOver(status)}` to the
  // confirm sheet) — otherwise an `implemented` delete would promise archival
  // and silently hard-delete. **Non-terminal** (draft/in_review/revising, and a
  // live `implementing` build): the working dir is *hard-removed* (permanent),
  // and any parked agent is woken with a terminal `deleted` event so its `wait`
  // loop stops cleanly. Both publish the same terminal `removed` frame; the
  // response carries `archivedTo` (the archive path, or null for a hard-delete).
  app.delete("/api/sessions/:id", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const queue = queueFor(session.id);
    const pendingEvents = queue.size;
    let archivedTo: string | null = null;
    if (TERMINAL_STATUSES.includes(session.status)) {
      // Deregister first — it can throw (registry flush), and an early queue
      // eviction would orphan in-flight ack tracking for a session that is in
      // fact still registered. Close the evicted instance before the move so a
      // late in-flight ack cannot recreate .otacon/<id>/ next to the archive.
      store.deleteSession(session.id);
      queue.close();
      queues.delete(session.id);
      archivedTo = store.archiveSessionDir(session.repo, session.id);
    } else {
      // Wake any parked agent BEFORE deregistering so its respondEvent still
      // resolves against a registered session; closeWith sets the queue closed
      // first, so the hard-remove below can't be recreated by a late ack. Then
      // deregister and permanently drop the working dir (no committed value).
      queue.closeWith({ event: "deleted", session: session.id });
      queues.delete(session.id);
      store.deleteSession(session.id);
      store.removeSessionDir(session.repo, session.id);
    }
    // Terminal frame: the index and switcher drop the session live, and an
    // open review tab flips to its closed state instead of error-limbo.
    notifier.publish({ type: "removed", session: session.id, data: { session: session.id } });
    return c.json({ ok: true, session: session.id, repo: session.repo, pendingEvents, archivedTo });
  });

  app.get("/api/sessions/:id/events", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const queue = queueFor(session.id);
    // Any events call is the agent on the line; bump presence before deciding
    // whether to park (covers the fast-path and wait=0 drains too).
    bumpContact(session.id);
    const raw = Number(c.req.query("wait") ?? "0");
    const waitSeconds = Number.isFinite(raw)
      ? Math.min(Math.max(raw, 0), MAX_WAIT_SECONDS)
      : 0;

    // Fast path and parking are one synchronous block: no enqueue can slip
    // between this take() and park() (DECISIONS.md "SessionQueue: synchronous").
    const immediate = queue.take();
    if (immediate) return respondEvent(c, queue, immediate);
    if (waitSeconds === 0) return timeoutEvent(c);

    const signal = c.req.raw.signal; // materializes node-server's AbortController
    // node-server only aborts that controller if it existed when the socket's
    // "close" fired. A client that vanished before this handler ran would
    // otherwise park a zombie waiter for the full wait window.
    const outgoing = c.env?.outgoing;
    if (signal.aborted || outgoing?.destroyed || outgoing?.closed) return timeoutEvent(c);
    return new Promise<Response>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let handle: ParkHandle | undefined;
      const settle = (response: Response) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        handle?.cancel();
        signal.removeEventListener("abort", onAbort);
        // Leaving the park flips `parked` (the waiter is gone): broadcast a
        // fresh summary so a dropped agent's dot can fall to offline instead
        // of the last frame's parked=true sticking forever. Re-read the
        // registry — the session may have flipped (approve) or vanished
        // (clean) during the park.
        const current = store.getSession(session.id);
        if (current) publishSession(current);
        resolve(response);
      };
      // Aborted while parked: cancel the waiter; queued events stay queued.
      // (Aborted after wake-up is the respondEvent requeue path instead.)
      const onAbort = () => settle(timeoutEvent(c));
      handle = queue.park((event) => settle(respondEvent(c, queue, event)));
      if (!settled) {
        // Genuinely parked (the queue was empty at take()): broadcast
        // parked=true + the refreshed lastContactAt so the live dot reaches the
        // UI within one park slice (DESIGN.md §6).
        publishSession(session);
        timer = setTimeout(() => settle(timeoutEvent(c)), waitSeconds * 1000);
        signal.addEventListener("abort", onAbort);
      }
    });
  });

  app.post("/api/sessions/:id/submit", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    // Raw markdown body, or {"plan": "...", "resolutions": {...}} JSON — the
    // CLI sends resolutions.json's content along (DESIGN.md §6). The raw path
    // carries no resolutions, so L5 still rejects it when threads are open.
    let content = await c.req.text();
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    // A submit cannot land mid-build. `implementing` is non-terminal (it re-opens
    // progress/ask/wait/answer, DESIGN.md §6) so it slips past sessionEnded — but
    // submit is not in that verb set, and a revision here would clobber the
    // approved plan. This also serializes the double-finalize race: a comment-&-
    // approve fold-in that flips to `implementing` is the winner, and a second
    // submit racing it is refused here (an `approved` finalize is caught by
    // sessionEnded above instead).
    if (store.getSession(session.id)?.status === "implementing") {
      return alreadyImplementing(c, session.id);
    }
    bumpContact(session.id);
    let resolutions: Resolutions = {};
    if (c.req.header("content-type")?.includes("json")) {
      let body: unknown;
      try {
        body = JSON.parse(content);
      } catch {
        body = undefined;
      }
      const plan = (body as Record<string, unknown> | undefined)?.plan;
      if (typeof plan !== "string") return badRequest(c, "JSON body must carry a string plan");
      const parsed = parseResolutions((body as Record<string, unknown>).resolutions);
      if (!parsed) {
        return badRequest(
          c,
          'resolutions must be {"changelog"?: string, "threads"?: {"t<n>": "reply"}}',
        );
      }
      content = plan;
      resolutions = parsed;
    }
    if (content.trim() === "") return badRequest(c, "request body must be the plan markdown");

    const state = store.readState(session.id);
    const replies = resolutions.threads ?? {};
    const result = lint(content, loadConfig(session.repo), {
      session: session.id,
      expectedRevision: state.revision + 1,
      expectedStatus: "in_review",
      // L3/L5 context is composed here: rules stay pure, the daemon does the I/O.
      grill: {
        quick: session.quick,
        knownQuestions: readTranscript(store.transcriptPath(session.id)).map((e) => e.id),
      },
      resolutions: {
        revision: state.revision + 1,
        commentThreads: commentThreadStates(store.threadsPath(session.id)),
        replies,
        changelog: resolutions.changelog,
      },
    });
    if (!result.ok) {
      return c.json({ ok: false, errors: result.errors, warnings: result.warnings }, 422);
    }
    const changelog = (resolutions.changelog ?? "").trim() === "" ? null : (resolutions.changelog as string);
    const revision = store.saveRevision(session.id, content, result.warnings, changelog ?? undefined);
    // The accepted revision settles its threads: resolutions land on their
    // threads, every anchor is re-located in the new text, lost ones orphan
    // (DESIGN.md §4, §9). SSE upserts keep the rail live.
    const changedThreads = applyRevisionToThreads(store.threadsPath(session.id), {
      plan: content,
      replies,
      revision,
    });
    // The accepted revision and its settled threads go out the same way on both
    // the fold-in and the ordinary path — but at different points relative to the
    // status flip (finalizeApproval vs publishSession), so each branch fires this.
    const publishRevision = (): void => {
      notifier.publish({
        type: "revision",
        session: session.id,
        data: { session: session.id, revision, changelog },
      });
      for (const thread of changedThreads) publishThread(session.id, thread);
    };

    // Deferred approval (comment & approve, DESIGN.md §6, §12): a send-to-agent
    // approve armed `pendingApproval` and parked the session in `finalizing`.
    // This clean submit is the agent's fold-in pass — L5 has just vouched that
    // every open comment carries a resolution — so finalize now instead of
    // returning to in_review. The swept threads (re-read post-resolution) become
    // the committed `## Review notes`, so the unreviewed fold-in stays auditable.
    const pending = state.pendingApproval;
    if (pending) {
      const swept = new Set(pending.threads);
      const reviewNotes: ReviewNote[] = readThreads(store.threadsPath(session.id))
        .filter((t): t is Extract<Thread, { kind: "comment" }> => t.kind === "comment" && swept.has(t.id))
        .map((t) => ({
          thread: t.id,
          section: t.anchor?.section ?? null,
          body: t.body,
          resolution: t.resolution?.body ?? "",
        }));
      const { path, home } = finalizeApproval(session, {
        revision,
        markdown: content,
        implement: pending.implement,
        reviewNotes,
      });
      // The fold-in produced a real revision and resolved threads; publish them
      // so the rail/diff stay honest (the implement variant keeps the screen
      // live, a plain finalize flips it to the approved notice).
      publishRevision();
      return c.json({
        ok: true,
        session: session.id,
        revision,
        status: pending.implement ? "implementing" : "approved",
        path,
        home,
        finalized: true,
        warnings: result.warnings,
        resolved: Object.keys(replies),
      });
    }

    const updated = store.updateSession(session.id, { status: "in_review" });
    publishSession(updated);
    publishRevision();
    // The ball is back in the user's court: a fresh revision awaits review.
    maybeNotify(session, { kind: "revision", revision });
    return c.json({
      ok: true,
      session: session.id,
      revision,
      status: "in_review",
      warnings: result.warnings,
      resolved: Object.keys(replies),
    });
  });

  // The user's side of re-review bookkeeping (DESIGN.md §9 layer 3): the UI's
  // "mark reviewed" / banner-dismiss POSTs here; comment flushes mark it
  // implicitly. Monotonic — see Store.markReviewed.
  app.post("/api/sessions/:id/reviewed", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const state = store.readState(session.id);
    if (state.revision === 0) {
      return badRequest(c, "session has no revisions to mark reviewed");
    }
    const body = (await readJsonBody(c)) ?? {};
    const revision = body.revision ?? state.revision;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || revision > state.revision) {
      return badRequest(c, `revision must be an integer 1..${state.revision}`);
    }
    const lastReviewedRevision = store.markReviewed(session.id, revision);
    publishSession(session); // summary re-reads state, so the frame carries it
    return c.json({ ok: true, session: session.id, lastReviewedRevision });
  });

  // The review screen reports its visibility here (DESIGN.md §6): {visible:true}
  // when shown + on a heartbeat, {visible:false} on blur/unload. The daemon
  // suppresses a desktop banner only while a review is visible — a hidden or
  // backgrounded tab (its SSE stream still open) does NOT suppress. No status
  // change, so it stays callable on an approved session (a closing tab still
  // pings); presence is ephemeral, not persisted.
  app.post("/api/sessions/:id/presence", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const body = (await readJsonBody(c)) ?? {};
    if (typeof body.visible !== "boolean") {
      return badRequest(c, "visible must be a boolean");
    }
    if (body.visible) presence.markVisible(session.id);
    else presence.markHidden(session.id);
    return c.json({ ok: true, session: session.id, visible: body.visible });
  });

  // Structural diff between two stored revisions (DESIGN.md §6, §9 layer 3).
  // Defaults: to = latest, from = last-reviewed (?from= selects any other
  // baseline; 0 = the empty plan, so a never-reviewed session shows all-new).
  app.get("/api/sessions/:id/diff", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const state = store.readState(session.id);
    if (state.revision === 0) {
      return notFound(c, `session ${session.id} has no revisions to diff`);
    }
    const parseRev = (raw: string | undefined, fallback: number): number | undefined => {
      if (raw === undefined || raw === "") return fallback;
      const n = Number(raw);
      return Number.isInteger(n) ? n : undefined;
    };
    const to = parseRev(c.req.query("to"), state.revision);
    const from = parseRev(c.req.query("from"), state.lastReviewedRevision);
    if (to === undefined || to < 1 || to > state.revision) {
      return badRequest(c, `to must be a revision number 1..${state.revision}`);
    }
    if (from === undefined || from < 0 || from > state.revision) {
      return badRequest(c, `from must be a revision number 0..${state.revision} (0 = empty plan)`);
    }
    const payload: DiffPayload = {
      session: session.id,
      from,
      to,
      sections: diffPlans(
        from === 0 ? "" : store.readRevision(session.id, from),
        store.readRevision(session.id, to),
      ),
    };
    return c.json(payload);
  });

  app.post("/api/sessions/:id/comments", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const queue = queueFor(session.id); // before any state write: can throw on a corrupt file
    const body = (await readJsonBody(c)) ?? {};
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    // A `finalizing` session is locked to the agent's solo fold-in pass — a new
    // comment here would clobber it back to `revising` with `pendingApproval`
    // still armed and hand the agent an un-swept thread that wedges L5 (D7).
    if (store.getSession(session.id)?.status === "finalizing") {
      return alreadyFinalizing(c, session.id);
    }
    bumpContact(session.id);
    const rawItems = body.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return badRequest(c, "items must be a non-empty array");
    }
    const drafts: { anchor: Anchor | null; body: string }[] = [];
    for (const raw of rawItems as Record<string, unknown>[]) {
      const anchor = parseAnchor(raw?.anchor);
      if (typeof raw?.body !== "string" || raw.body.trim() === "" || anchor === undefined) {
        return badRequest(c, "each item needs a non-empty body and a valid anchor (or null)");
      }
      drafts.push({ anchor, body: raw.body });
    }
    // Ids are minted only after the whole batch validates, in one counter
    // write — a rejected batch burns neither ids nor disk writes.
    const counters = store.bumpCounters(session.id, {
      thread: drafts.length,
      batch: 1,
      eventSeq: 1,
    });
    const firstThread = counters.thread - drafts.length;
    const items: CommentItem[] = drafts.map((draft, i) => ({
      thread: `t${firstThread + i + 1}`,
      ...draft,
    }));
    const batch = `b${counters.batch}`;
    // Each item becomes a persistent thread (DESIGN.md §9) — the rail's
    // source of truth; the queued event is only the agent's wake-up copy.
    const createdAt = new Date().toISOString();
    const threads: Thread[] = items.map((item) => ({
      id: item.thread,
      kind: "comment",
      batch,
      anchor: item.anchor,
      body: item.body,
      createdAt,
    }));
    appendThreads(store.threadsPath(session.id), threads);
    // Flushing a batch is the implicit "I reviewed this revision" signal
    // (DESIGN.md §9 layer 3) — the diff baseline moves with it.
    store.markReviewed(session.id, store.readState(session.id).revision);
    // Comments are revision requests (DECISIONS.md "Status transitions"); flip
    // status before the enqueue wakes a parked agent.
    const updated = store.updateSession(session.id, { status: "revising" });
    const payload: EventPayload = { event: "comments", session: session.id, batch, items };
    queue.enqueue(payload, counters.eventSeq);
    publishSession(updated); // after the enqueue, so the summary carries the fresh pending count
    for (const thread of threads) publishThread(session.id, thread);
    return c.json(
      { ok: true, batch, threads: items.map((i) => i.thread), seq: counters.eventSeq },
      202,
    );
  });

  app.post("/api/sessions/:id/questions", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const queue = queueFor(session.id); // before any state write: can throw on a corrupt file
    const body = (await readJsonBody(c)) ?? {};
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    bumpContact(session.id);
    if (typeof body.body !== "string" || body.body.trim() === "") {
      return badRequest(c, "question needs a non-empty body");
    }
    // A follow-up (DESIGN.md §9) names the question it continues with `replyTo`
    // and inherits that conversation's anchor — so a client anchor is ignored on
    // a follow-up; a root question parses its own anchor (or null = whole-plan).
    let anchor: Anchor | null;
    let replyTo: string | undefined;
    let inheritOrphan = false;
    const replyToRaw = body.replyTo;
    if (replyToRaw === undefined) {
      const parsed = parseAnchor(body.anchor);
      if (parsed === undefined) {
        return badRequest(c, "question needs a valid anchor (or null)");
      }
      anchor = parsed;
    } else {
      if (typeof replyToRaw !== "string" || replyToRaw === "") {
        return badRequest(c, "replyTo must name a question thread id (q<n>)");
      }
      const existing = readThreads(store.threadsPath(session.id));
      const parent = existing.find(
        (t): t is Extract<Thread, { kind: "question" }> =>
          t.id === replyToRaw && t.kind === "question",
      );
      if (!parent) {
        return c.json(
          {
            error: {
              code: "E_UNKNOWN_QUESTION",
              message: `session ${session.id} has no question ${replyToRaw}`,
            },
          },
          404,
        );
      }
      // Resolve the root so a whole chain shares one key — "follow up on a
      // follow-up" collapses to the same root, whose anchor (and orphan state)
      // the new turn inherits and travels with.
      const rootId = parent.replyTo ?? parent.id;
      const root = existing.find(
        (t): t is Extract<Thread, { kind: "question" }> =>
          t.id === rootId && t.kind === "question",
      );
      const source = root ?? parent;
      replyTo = rootId;
      anchor = source.anchor;
      inheritOrphan = source.anchorState === "orphaned";
    }
    const counters = store.bumpCounters(session.id, { question: 1, eventSeq: 1 });
    const id = `q${counters.question}`;
    const thread: Thread = {
      id,
      kind: "question",
      anchor,
      ...(inheritOrphan ? { anchorState: "orphaned" as const } : {}),
      body: body.body,
      createdAt: new Date().toISOString(),
      ...(replyTo !== undefined ? { replyTo } : {}),
    };
    appendThreads(store.threadsPath(session.id), [thread]);
    // Questions leave the plan — and the status — untouched (DESIGN.md §9).
    const payload: EventPayload = {
      event: "question",
      session: session.id,
      id,
      anchor,
      body: body.body,
      ...(replyTo !== undefined ? { replyTo } : {}),
    };
    queue.enqueue(payload, counters.eventSeq);
    publishQueue(session.id, queue.size);
    publishThread(session.id, thread);
    return c.json({ ok: true, id, seq: counters.eventSeq }, 202);
  });

  // The agent's side of a user question (otacon answer, DESIGN.md §6, §9):
  // the answer lands on the thread — the plan and the status stay untouched —
  // and the UI's "answering…" placeholder resolves over SSE.
  app.post("/api/sessions/:id/questions/:qid/answer", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const body = (await readJsonBody(c)) ?? {};
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    bumpContact(session.id);
    if (typeof body.body !== "string" || body.body.trim() === "") {
      return badRequest(c, "answer needs a non-empty body");
    }
    const qid = c.req.param("qid") ?? "";
    const thread = answerQuestion(store.threadsPath(session.id), qid, body.body);
    if (!thread) {
      return c.json(
        {
          error: {
            code: "E_UNKNOWN_QUESTION",
            message: `session ${session.id} has no question ${qid}`,
          },
        },
        404,
      );
    }
    publishThread(session.id, thread);
    return c.json({
      ok: true,
      session: session.id,
      question: qid,
      answeredAt: thread.answer.answeredAt,
    });
  });

  app.get("/api/sessions/:id/threads", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    return c.json({ session: session.id, threads: readThreads(store.threadsPath(session.id)) });
  });

  // The agent's grill question (otacon ask, DESIGN.md §6, §8): persisted in
  // the transcript and pushed to the UI as a card; no agent event is queued —
  // the asker goes straight back to `otacon wait` for the answer. Accepts a
  // single question body or a batch (`{questions:[…]}`) of independent
  // questions — independent siblings the agent posts in one call (§8); they
  // render as ordinary cards, each answered instantly.
  app.post("/api/sessions/:id/ask", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const body = (await readJsonBody(c)) ?? {};
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    bumpContact(session.id);

    // Batch: validate every member first, then mint all ids in one counter
    // bump and append them in one write — a malformed member fails the whole
    // batch, so the queue never holds a partial set (DECISIONS.md).
    if (body.questions !== undefined) {
      const raw = body.questions;
      if (!Array.isArray(raw) || raw.length === 0) {
        return badRequest(c, "questions must be a non-empty array of question objects");
      }
      const specs: QuestionSpec[] = [];
      for (let i = 0; i < raw.length; i++) {
        const spec = parseQuestionSpec(raw[i]);
        if (typeof spec === "string") return badRequest(c, `questions[${i}] ${spec}`);
        specs.push(spec);
      }
      const counters = store.bumpCounters(session.id, { question: specs.length });
      const first = counters.question - specs.length;
      const askedAt = new Date().toISOString();
      const entries = specs.map((spec, i) => entryFromSpec(`q${first + i + 1}`, spec, askedAt));
      appendEntries(store.transcriptPath(session.id), entries);
      for (const entry of entries) publishGrill(session.id, entry);
      publishSession(store.getSession(session.id) ?? session);
      // A batch coalesces to one banner — N questions need answering (DESIGN.md §6).
      maybeNotify(
        session,
        entries.length === 1
          ? { kind: "question", text: specs[0]!.question }
          : { kind: "questions", count: entries.length },
      );
      return c.json({ ok: true, session: session.id, ids: entries.map((e) => e.id) }, 201);
    }

    const spec = parseQuestionSpec(body);
    if (typeof spec === "string") return badRequest(c, spec);
    const counters = store.bumpCounters(session.id, { question: 1 });
    const entry = entryFromSpec(`q${counters.question}`, spec, new Date().toISOString());
    appendEntry(store.transcriptPath(session.id), entry);
    publishGrill(session.id, entry);
    // The summary's openQuestions just moved: the index's "questions pending"
    // chip rides session frames, so every transcript change publishes one.
    publishSession(store.getSession(session.id) ?? session);
    maybeNotify(session, { kind: "question", text: spec.question });
    return c.json({ ok: true, session: session.id, id: entry.id }, 201);
  });

  // The user's side of a grill question (DESIGN.md §6, §8): the answer lands
  // on the transcript entry and an `answer` event wakes the parked agent.
  app.post("/api/sessions/:id/answers", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const queue = queueFor(session.id); // before any state write: can throw on a corrupt file
    const body = (await readJsonBody(c)) ?? {};
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    const { question, choice, choices, text } = body;
    if (typeof question !== "string" || question === "") {
      return badRequest(c, "question must name a transcript question id (q<n>)");
    }
    const asked = readTranscript(store.transcriptPath(session.id)).find((e) => e.id === question);
    if (!asked) {
      return c.json(
        {
          error: {
            code: "E_UNKNOWN_QUESTION",
            message: `session ${session.id} has no grill question ${question}`,
          },
        },
        404,
      );
    }
    if (text !== undefined && typeof text !== "string") {
      return badRequest(c, "text must be a string");
    }
    // The answer must fit the question's shape: chips for option questions
    // (one chip, or 1+ under --multi), free text for optionless ones. A
    // non-empty custom answer with no chip is valid on option questions too
    // (native-AskUserQuestion "Other" parity, DESIGN.md §8) — and text may
    // still ride a chosen chip as a note.
    const customText = typeof text === "string" && text.trim() !== "";
    const noChips = choice === undefined && choices === undefined;
    if (noChips) {
      // "Other" parity (DESIGN.md §8): a non-empty custom answer with no chip
      // is valid on ANY question shape — the one branch-independent rule, so it
      // lives here, not re-stated per shape. Only the hint names the shape.
      if (!customText) {
        const need =
          asked.options === undefined
            ? "a non-empty text answer"
            : asked.multi === true
              ? "chosen choices or a non-empty custom answer"
              : "a single choice from its options or a non-empty custom answer";
        return badRequest(c, `${question} needs ${need}`);
      }
    } else if (asked.options === undefined) {
      return badRequest(c, `${question} has no options — answer with text only`);
    } else if (asked.multi === true) {
      const ok =
        choice === undefined &&
        Array.isArray(choices) &&
        choices.length > 0 &&
        choices.every((x) => typeof x === "string" && (asked.options as string[]).includes(x)) &&
        new Set(choices).size === choices.length;
      if (!ok) {
        return badRequest(c, `${question} is multi-choice — pass distinct choices from its options`);
      }
    } else if (choices !== undefined || typeof choice !== "string" || !asked.options.includes(choice)) {
      // Single-choice with a chip: exactly one valid `choice`, never `choices`.
      return badRequest(c, `${question} needs a single choice from its options`);
    }
    const answer: GrillAnswer = {
      ...(typeof choice === "string" ? { choice } : {}),
      ...(Array.isArray(choices) ? { choices: choices as string[] } : {}),
      ...(customText ? { text: text as string } : {}),
      answeredAt: new Date().toISOString(),
    };
    // Re-answering overwrites (at-least-once: a duplicate POST is legitimate);
    // the agent sees a second answer event with the same question id.
    const updated = answerEntry(store.transcriptPath(session.id), question, answer);
    const payload: EventPayload = {
      event: "answer",
      session: session.id,
      question,
      ...(answer.choice !== undefined ? { choice: answer.choice } : {}),
      ...(answer.choices !== undefined ? { choices: answer.choices } : {}),
      ...(answer.text !== undefined ? { text: answer.text } : {}),
    };
    queue.enqueue(payload, store.bumpCounter(session.id, "eventSeq"));
    publishQueue(session.id, queue.size);
    if (updated) publishGrill(session.id, updated);
    // openQuestions dropped (or held, on a re-answer) — keep the chip honest.
    publishSession(store.getSession(session.id) ?? session);
    return c.json({ ok: true, session: session.id, question }, 202);
  });

  app.get("/api/sessions/:id/transcript", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    return c.json({
      session: session.id,
      transcript: readTranscript(store.transcriptPath(session.id)),
    });
  });

  // The agent's narration (otacon progress, DESIGN.md §6, §8): a non-blocking
  // progress note appended to the capped activity feed and pushed to the UI as
  // an `activity` frame (the per-session log) plus a `session` frame (the
  // chip's latestActivity). No agent event is queued — like `ask`, this is
  // UI-only telemetry, never a wake-up. The note is trimmed to the configured
  // max so long narration never fails or bloats payloads.
  app.post("/api/sessions/:id/progress", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const body = (await readJsonBody(c)) ?? {};
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    const raw = body.note;
    if (typeof raw !== "string" || raw.trim() === "") {
      return badRequest(c, "note must be a non-empty string");
    }
    const { activity } = loadConfig(session.repo);
    const trimmed = raw.trim();
    const text =
      trimmed.length > activity.noteMaxChars
        ? `${trimmed.slice(0, Math.max(1, activity.noteMaxChars - 1)).trimEnd()}…`
        : trimmed;
    const note = appendActivity(
      store.activityPath(session.id),
      text,
      activity.cap,
      new Date().toISOString(),
    );
    bumpContact(session.id);
    notifier.publish({ type: "activity", session: session.id, data: { session: session.id, note } });
    publishSession(session); // latestActivity for the chip; fresh contact for the dot
    return c.json({ ok: true, session: session.id, note: text });
  });

  // Approve ends the planning session (DESIGN.md §6 step 6/7, §12). Otacon never
  // git-commits the plan — it only writes the composed artifact (final revision,
  // status: approved, grill transcript appended). The canonical copy ALWAYS lands
  // in the home store (~/.otacon/sessions/<id>/). **Save** (plain Approve,
  // implement=false) ALSO writes a project copy under the repo's `plans.dir` and
  // sets the event `path` there; the session flips to `approved` (terminal) and
  // the agent prints where it landed and stops — the user commits it themselves.
  // **Implement** ({implement:true}) writes the home copy only, sets `path`=home,
  // flips to the non-terminal `implementing`, and the agent builds from the home
  // copy. The event always carries `home` (the absolute canonical path).
  //
  // Unresolved threads refuse 409 carrying the count; the UI's warn stage then
  // offers two ways past it: **{force:true}** finalizes now and drops the open
  // threads (today's behavior), or **comment & approve** — {sendOpenComments:true}
  // — defers the finalize, flipping to the non-terminal `finalizing` and handing
  // the agent every open comment thread (a `final:true` comments batch) for one
  // solo fold-in pass; its next clean submit finalizes (carrying the implement
  // choice). Mid-finalize, a fresh {sendOpenComments} is refused E_ALREADY_FINALIZING,
  // but {force:true} stays open as the manual escape (force-drop the current
  // revision).
  app.post("/api/sessions/:id/approve", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const queue = queueFor(session.id); // before any state write: can throw on a corrupt file
    const body = (await readJsonBody(c)) ?? {};
    // Doubles as the double-approve guard: two concurrent approves both
    // snapshot in_review, but the loser re-checks here after its body await
    // and refuses instead of writing a second (-2 suffixed) artifact.
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    const currentStatus = store.getSession(session.id)?.status;
    // `implementing` is non-terminal, so it slips past sessionEnded — but a
    // build is already under way, and re-approving would re-write the artifact
    // and re-queue the wake-up. Refuse it explicitly (the second tap on an
    // Approve & Implement, or a stray approve while the agent builds).
    if (currentStatus === "implementing") {
      return alreadyImplementing(c, session.id);
    }
    if (body.force !== undefined && typeof body.force !== "boolean") {
      return badRequest(c, "force must be a boolean");
    }
    if (body.implement !== undefined && typeof body.implement !== "boolean") {
      return badRequest(c, "implement must be a boolean");
    }
    if (body.sendOpenComments !== undefined && typeof body.sendOpenComments !== "boolean") {
      return badRequest(c, "sendOpenComments must be a boolean");
    }
    const force = body.force === true;
    const sendOpenComments = body.sendOpenComments === true;
    // A second send-to-agent while the fold-in is in flight is refused; "Commit
    // anyway" (force) stays open as the manual escape from a hung finalize (D7).
    if (currentStatus === "finalizing" && !force) {
      return c.json(
        {
          error: {
            code: "E_ALREADY_FINALIZING",
            message: `session ${session.id} is already finalizing; approve with {"force":true} to commit anyway`,
          },
        },
        409,
      );
    }
    const state = store.readState(session.id);
    if (state.revision === 0) {
      return c.json(
        {
          error: {
            code: "E_NO_REVISION",
            message: `session ${session.id} has no revisions to approve`,
          },
        },
        409,
      );
    }
    // A force escape mid-finalize honors the variant the user originally chose
    // (carried on pendingApproval); a fresh approve reads the body's flag.
    const implement =
      currentStatus === "finalizing"
        ? (state.pendingApproval?.implement ?? false)
        : body.implement === true;
    const threads = readThreads(store.threadsPath(session.id));
    const openComments = openCommentThreads(threads);
    // Unresolved = comment threads with no resolution + user questions with no
    // answer — the same open items the rail shows.
    const unresolved = threads.filter((t) =>
      t.kind === "comment" ? t.resolution === undefined : t.answer === undefined,
    ).length;

    // Comment & approve: defer the finalize and hand the agent every open comment
    // thread for one solo fold-in pass — its next clean submit finalizes. Only
    // when there is something to fold in, and not already finalizing (a force then
    // falls through to the escape below).
    if (sendOpenComments && currentStatus !== "finalizing" && openComments.length > 0) {
      const counters = store.bumpCounters(session.id, { batch: 1, eventSeq: 1 });
      const batch = `b${counters.batch}`;
      const items: CommentItem[] = openComments.map((t) => ({
        thread: t.id,
        anchor: t.anchor,
        body: t.body,
      }));
      store.setPendingApproval(session.id, { implement, threads: items.map((i) => i.thread) });
      const updated = store.updateSession(session.id, { status: "finalizing" });
      const payload: EventPayload = {
        event: "comments",
        session: session.id,
        batch,
        items,
        final: true,
      };
      queue.enqueue(payload, counters.eventSeq);
      publishSession(updated); // after the enqueue, so the summary carries the fresh pending count
      return c.json({
        ok: true,
        session: session.id,
        finalizing: true,
        sent: items.map((i) => i.thread),
        implement,
      });
    }

    // The 409 carries both counts: `unresolved` (the warning's total) and
    // `openComments` (whether comment & approve has anything to fold in, so the
    // UI can offer "Send to agent" only when it would do something).
    if (unresolved > 0 && !force) {
      return c.json(
        {
          error: {
            code: "E_UNRESOLVED_THREADS",
            message: `session has ${unresolved} unresolved thread(s); approve with {"force":true} to override, or {"sendOpenComments":true} to fold open comments in`,
          },
          unresolved,
          openComments: openComments.length,
        },
        409,
      );
    }
    // Finalize now (plain/force approve, or the force escape mid-finalize): no
    // review notes — a force drop leaves the open threads unaddressed.
    const { path, home } = finalizeApproval(session, {
      revision: state.revision,
      markdown: store.readRevision(session.id, state.revision),
      implement,
    });
    return c.json({
      ok: true,
      session: session.id,
      revision: state.revision,
      path,
      home,
      unresolved,
      implement,
    });
  });

  // Approve & Implement's outcome report (DESIGN.md §6, §12): once the agent has
  // built the approved plan it reports here. `failed:true` flips the session
  // `implement_failed`, otherwise `implemented` (both terminal). A `pr` URL is
  // persisted on the registry session so the home card can surface the link.
  // The session must currently be `implementing` — that check runs FIRST, so a
  // double-report (the second sees a terminal state) and a stray call on a
  // never-implementing session both get a clear E_NOT_IMPLEMENTING instead of
  // the generic terminal wall.
  app.post("/api/sessions/:id/implement-done", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const body = (await readJsonBody(c)) ?? {};
    bumpContact(session.id);
    if (store.getSession(session.id)?.status !== "implementing") {
      return c.json(
        {
          error: {
            code: "E_NOT_IMPLEMENTING",
            message: `session ${session.id} is not implementing`,
          },
        },
        409,
      );
    }
    const { pr, failed } = body;
    if (pr !== undefined && (typeof pr !== "string" || pr.trim() === "")) {
      return badRequest(c, "pr must be a non-empty string");
    }
    if (failed !== undefined && typeof failed !== "boolean") {
      return badRequest(c, "failed must be a boolean");
    }
    const status = failed === true ? "implement_failed" : "implemented";
    const updated = store.updateSession(session.id, {
      status,
      ...(typeof pr === "string" ? { prUrl: pr } : {}),
    });
    publishSession(updated); // the chip flips + the PR link appears live
    return c.json({ ok: true, session: updated, status, prUrl: updated.prUrl });
  });

  app.get("/api/sessions/:id/revisions/:n", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n) || n < 1) {
      return badRequest(c, "revision must be a positive integer");
    }
    if (n > store.readState(session.id).revision) {
      return notFound(c, `session ${session.id} has no revision ${n}`);
    }
    // Default is the raw markdown (byte-identical read-back; the CLI/curl
    // path). The web UI asks for JSON to get the lint warnings the revision
    // was accepted with alongside it (DESIGN.md §6).
    if (c.req.header("accept")?.toLowerCase().includes("application/json")) {
      const payload: RevisionPayload = {
        session: session.id,
        revision: n,
        markdown: store.readRevision(session.id, n),
        warnings: store.readRevisionWarnings(session.id, n),
        changelog: store.readRevisionChangelog(session.id, n),
      };
      return c.json(payload);
    }
    return c.text(store.readRevision(session.id, n), 200, {
      "content-type": "text/markdown; charset=utf-8",
    });
  });

  // The SPA (GET /, GET /s/:id, /assets/*) and its SSE feeds (GET /api/stream,
  // GET /api/sessions/:id/stream) — see ui.ts.
  registerUiRoutes(app, {
    notifier,
    listSummaries: () => store.listSessions().map(summarize),
    getSummary: (id) => {
      const session = store.getSession(id);
      return session ? summarize(session) : undefined;
    },
    getThreads: (id) => readThreads(store.threadsPath(id)),
    getTranscript: (id) => readTranscript(store.transcriptPath(id)),
    getActivity: (id) => readActivity(store.activityPath(id)),
    uiDir: options.uiDir,
    heartbeatMs: options.sseHeartbeatMs,
  });

  return app;
}
