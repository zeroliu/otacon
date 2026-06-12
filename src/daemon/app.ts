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
import { isAbsolute } from "node:path";
import { loadConfig } from "../shared/config.js";
import type {
  Anchor,
  CommentItem,
  DiffPayload,
  EventPayload,
  QueuedEvent,
  RegistrySession,
  Resolutions,
  RevisionPayload,
  SessionSummary,
  Thread,
} from "../shared/types.js";
import { VERSION } from "../shared/version.js";
import { diffPlans } from "./diff.js";
import { lint } from "./linter/index.js";
import { Notifier } from "./notify.js";
import type { ParkHandle } from "./queue.js";
import { SessionQueue } from "./queue.js";
import type { Store } from "./store.js";
import {
  answerQuestion,
  appendThreads,
  applyRevisionToThreads,
  commentThreadStates,
  readThreads,
} from "./threads.js";
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
}

type AppContext = Context<{ Bindings: NodeBindings }>;

/** Hard ceiling on ?wait= (seconds); agents ask for 540 under their 600s Bash cap. */
const MAX_WAIT_SECONDS = 600;

const badRequest = (c: AppContext, message: string) =>
  c.json({ error: { code: "E_BAD_REQUEST", message } }, 400);
const notFound = (c: AppContext, message: string) =>
  c.json({ error: { code: "E_NOT_FOUND", message } }, 404);
const timeoutEvent = (c: AppContext) => c.json({ event: "timeout" });

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
      const threads: Record<string, string> = {};
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
    };
  };
  const publishSession = (session: RegistrySession): void =>
    notifier.publish({ type: "session", session: session.id, data: { session: summarize(session) } });
  const publishQueue = (id: string, pending: number): void =>
    notifier.publish({ type: "queue", session: id, data: { session: id, pending } });
  const publishThread = (id: string, thread: Thread): void =>
    notifier.publish({ type: "thread", session: id, data: { session: id, thread } });

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

  app.get("/api/sessions/:id/events", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const queue = queueFor(session.id);
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
        resolve(response);
      };
      // Aborted while parked: cancel the waiter; queued events stay queued.
      // (Aborted after wake-up is the respondEvent requeue path instead.)
      const onAbort = () => settle(timeoutEvent(c));
      handle = queue.park((event) => settle(respondEvent(c, queue, event)));
      if (!settled) {
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
      // L5's context is composed here: rules stay pure, the daemon does the I/O.
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
    const updated = store.updateSession(session.id, { status: "in_review" });
    publishSession(updated);
    notifier.publish({
      type: "revision",
      session: session.id,
      data: { session: session.id, revision, changelog },
    });
    for (const thread of changedThreads) publishThread(session.id, thread);
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
    const anchor = parseAnchor(body.anchor);
    if (typeof body.body !== "string" || body.body.trim() === "" || anchor === undefined) {
      return badRequest(c, "question needs a non-empty body and a valid anchor (or null)");
    }
    const counters = store.bumpCounters(session.id, { question: 1, eventSeq: 1 });
    const id = `q${counters.question}`;
    const thread: Thread = {
      id,
      kind: "question",
      anchor,
      body: body.body,
      createdAt: new Date().toISOString(),
    };
    appendThreads(store.threadsPath(session.id), [thread]);
    // Questions leave the plan — and the status — untouched (DESIGN.md §9).
    const payload: EventPayload = {
      event: "question",
      session: session.id,
      id,
      anchor,
      body: body.body,
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
    uiDir: options.uiDir,
    heartbeatMs: options.sseHeartbeatMs,
  });

  return app;
}
