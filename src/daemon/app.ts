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
import type { Anchor, CommentItem, EventPayload, QueuedEvent } from "../shared/types.js";
import { VERSION } from "../shared/version.js";
import { lint } from "./linter/index.js";
import type { ParkHandle } from "./queue.js";
import { SessionQueue } from "./queue.js";
import type { Store } from "./store.js";

/** Provided by @hono/node-server; absent under app.request() in tests. */
export interface NodeBindings {
  outgoing?: ServerResponse;
}

export interface AppOptions {
  store: Store;
  /** Invoked by POST /api/shutdown; main.ts flushes the response, then exits. */
  onShutdown?: () => void;
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

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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

  /** Respond with the event; ack only after the bytes are out (see header comment). */
  function respondEvent(c: AppContext, queue: SessionQueue, event: QueuedEvent): Response {
    const outgoing = c.env?.outgoing;
    if (!outgoing) {
      queue.flush(event); // app.request() test path: no socket to wait on
    } else if (outgoing.destroyed) {
      queue.requeue(event); // client vanished before we even built the response
    } else {
      outgoing.once("close", () => {
        if (outgoing.writableFinished) queue.flush(event);
        else queue.requeue(event);
      });
    }
    return c.json(event.payload);
  }

  const app = new Hono<{ Bindings: NodeBindings }>();

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
    options.onShutdown?.();
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
    return c.json(store.createSession({ title, repo, branch, quick }), 201);
  });

  app.get("/api/sessions/:id", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const state = store.readState(session.id);
    return c.json({
      ...session,
      revision: state.revision,
      pendingEvents: queueFor(session.id).size,
    });
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
    // Raw markdown body, or {"plan": "..."} JSON (the CLI's --resolutions ride
    // along there once L5 lands in M3; ignored until then).
    let content = await c.req.text();
    if (c.req.header("content-type")?.includes("json")) {
      let plan: unknown;
      try {
        plan = (JSON.parse(content) as Record<string, unknown>).plan;
      } catch {
        plan = undefined;
      }
      if (typeof plan !== "string") return badRequest(c, "JSON body must carry a string plan");
      content = plan;
    }
    if (content.trim() === "") return badRequest(c, "request body must be the plan markdown");

    const state = store.readState(session.id);
    const result = lint(content, loadConfig(session.repo), {
      session: session.id,
      expectedRevision: state.revision + 1,
      expectedStatus: "in_review",
    });
    if (!result.ok) {
      return c.json({ ok: false, errors: result.errors, warnings: result.warnings }, 422);
    }
    const revision = store.saveRevision(session.id, content);
    store.updateSession(session.id, { status: "in_review" });
    return c.json({
      ok: true,
      session: session.id,
      revision,
      status: "in_review",
      warnings: result.warnings,
    });
  });

  app.post("/api/sessions/:id/comments", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const body = (await readJsonBody(c)) ?? {};
    const rawItems = body.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return badRequest(c, "items must be a non-empty array");
    }
    const items: CommentItem[] = [];
    for (const raw of rawItems as Record<string, unknown>[]) {
      const anchor = parseAnchor(raw?.anchor);
      if (typeof raw?.body !== "string" || raw.body.trim() === "" || anchor === undefined) {
        return badRequest(c, "each item needs a non-empty body and a valid anchor (or null)");
      }
      items.push({ thread: `t${store.bumpCounter(session.id, "thread")}`, anchor, body: raw.body });
    }
    const batch = `b${store.bumpCounter(session.id, "batch")}`;
    // Comments are revision requests (DECISIONS.md "Status transitions"); flip
    // status before the enqueue wakes a parked agent.
    store.updateSession(session.id, { status: "revising" });
    const payload: EventPayload = { event: "comments", session: session.id, batch, items };
    const seq = store.bumpCounter(session.id, "eventSeq");
    queueFor(session.id).enqueue(payload, seq);
    return c.json({ ok: true, batch, threads: items.map((i) => i.thread), seq }, 202);
  });

  app.post("/api/sessions/:id/questions", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const body = (await readJsonBody(c)) ?? {};
    const anchor = parseAnchor(body.anchor);
    if (typeof body.body !== "string" || body.body.trim() === "" || anchor === undefined) {
      return badRequest(c, "question needs a non-empty body and a valid anchor (or null)");
    }
    const id = `q${store.bumpCounter(session.id, "question")}`;
    // Questions leave the plan — and the status — untouched (DESIGN.md §9).
    const payload: EventPayload = {
      event: "question",
      session: session.id,
      id,
      anchor,
      body: body.body,
    };
    const seq = store.bumpCounter(session.id, "eventSeq");
    queueFor(session.id).enqueue(payload, seq);
    return c.json({ ok: true, id, seq }, 202);
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
    return c.text(store.readRevision(session.id, n), 200, {
      "content-type": "text/markdown; charset=utf-8",
    });
  });

  // Placeholder review page until the web UI lands in M2 (DECISIONS.md
  // "`/s/:id` serves a plain-text placeholder until the UI ships").
  app.get("/s/:id", (c) => {
    const session = sessionFor(c);
    if (!session) return c.text(`otacon: unknown session ${c.req.param("id")}\n`, 404);
    return c.html(
      `<!doctype html><title>otacon — ${escapeHtml(session.title)}</title><p>otacon session <code>${session.id}</code> — “${escapeHtml(session.title)}” (${session.status}). The review UI lands in M2.</p>\n`,
    );
  });

  return app;
}
