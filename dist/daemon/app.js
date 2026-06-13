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
import { isAbsolute, join } from "node:path";
import { loadConfig } from "../shared/config.js";
import { VERSION } from "../shared/version.js";
import { composeArtifact, localDate, pickArtifactRelPath } from "./approve.js";
import { diffPlans } from "./diff.js";
import { lint } from "./linter/index.js";
import { Notifier } from "./notify.js";
import { SessionQueue } from "./queue.js";
import { writeFileAtomic } from "./store.js";
import { answerQuestion, appendThreads, applyRevisionToThreads, commentThreadStates, readThreads, } from "./threads.js";
import { answerEntry, appendEntry, readTranscript } from "./transcript.js";
import { registerUiRoutes } from "./ui.js";
/** Hard ceiling on ?wait= (seconds); agents ask for 540 under their 600s Bash cap. */
const MAX_WAIT_SECONDS = 600;
const badRequest = (c, message) => c.json({ error: { code: "E_BAD_REQUEST", message } }, 400);
const notFound = (c, message) => c.json({ error: { code: "E_NOT_FOUND", message } }, 404);
const timeoutEvent = (c) => c.json({ event: "timeout" });
// Approved sessions are over (DESIGN.md §6, §12 status machine): every
// state-mutating verb refuses — the CLI's pointer rules guard its side, but
// curl/UI/--session calls must hit the same wall. Each route checks *after*
// its body await (see sessionEnded in createApp): a pre-await snapshot goes
// stale when a concurrent approve lands while the bytes stream in.
const sessionOver = (c, id) => c.json({ error: { code: "E_SESSION_OVER", message: `session ${id} is approved — the session is over` } }, 409);
async function readJsonBody(c) {
    try {
        const parsed = await c.req.json();
        return typeof parsed === "object" && parsed !== null
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** null/undefined = whole-plan; otherwise require {section} and keep known keys only. */
function parseAnchor(raw) {
    if (raw === null || raw === undefined)
        return null;
    if (typeof raw !== "object")
        return undefined;
    const { section, exact, prefix, suffix } = raw;
    if (typeof section !== "string" || section === "")
        return undefined;
    const anchor = { section };
    if (typeof exact === "string")
        anchor.exact = exact;
    if (typeof prefix === "string")
        anchor.prefix = prefix;
    if (typeof suffix === "string")
        anchor.suffix = suffix;
    return anchor;
}
/**
 * Validate the submit body's `resolutions` (DESIGN.md §6): an object with
 * only `changelog` (string) and `threads` (string → string). Strict — an
 * unknown key is a typo that would silently drop resolutions, so it refuses.
 * undefined/null = none provided ({}); any other bad shape = undefined.
 */
function parseResolutions(raw) {
    if (raw === undefined || raw === null)
        return {};
    if (typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        if (key === "changelog" && typeof value === "string") {
            out.changelog = value;
        }
        else if (key === "threads" && typeof value === "object" && value !== null && !Array.isArray(value)) {
            // Null-prototype: JSON.parse can hand us an own "__proto__" key, and
            // assigning it onto a plain object silently drops it — the strict shape
            // must surface it to L5 (E_UNKNOWN_THREAD) instead.
            const threads = Object.create(null);
            for (const [id, reply] of Object.entries(value)) {
                if (typeof reply !== "string")
                    return undefined;
                threads[id] = reply;
            }
            out.threads = threads;
        }
        else {
            return undefined;
        }
    }
    return out;
}
/** True when the Origin header names this daemon itself (the M2 web UI). */
function sameOrigin(origin, host) {
    try {
        return host !== undefined && new URL(origin).host === host;
    }
    catch {
        return false; // opaque origins ("null") and garbage are foreign
    }
}
export function createApp(options) {
    const { store } = options;
    // One queue instance per session for the daemon's lifetime — every request
    // must park on / enqueue into the same in-memory waiter list, and the
    // SessionQueue constructor re-reads disk (it would resurrect unacked
    // in-flight events if constructed per request).
    const queues = new Map();
    const queueFor = (id) => {
        let queue = queues.get(id);
        if (!queue) {
            queue = new SessionQueue(store.eventsPath(id));
            queues.set(id, queue);
        }
        return queue;
    };
    const sessionFor = (c) => store.getSession(c.req.param("id") ?? "");
    // Mutating routes call this after their last await: reading the request
    // body yields, and a concurrent approve can flip the session mid-read — a
    // status captured before the await would let the stale handler mutate (or
    // re-approve) an ended session. Everything from this re-check to the state
    // writes is synchronous, so the answer cannot rot again.
    const sessionEnded = (id) => store.getSession(id)?.status === "approved";
    // UI pub/sub (DECISIONS.md "UI live updates"): every state mutation below
    // publishes, and the SSE routes in ui.ts fan the events out to browsers.
    const notifier = new Notifier();
    const summarize = (session) => {
        const state = store.readState(session.id);
        return {
            ...session,
            revision: state.revision,
            lastReviewedRevision: state.lastReviewedRevision,
            pendingEvents: queueFor(session.id).size,
            openQuestions: readTranscript(store.transcriptPath(session.id)).filter((e) => e.answer === undefined).length,
        };
    };
    const publishSession = (session) => notifier.publish({ type: "session", session: session.id, data: { session: summarize(session) } });
    const publishQueue = (id, pending) => notifier.publish({ type: "queue", session: id, data: { session: id, pending } });
    const publishThread = (id, thread) => notifier.publish({ type: "thread", session: id, data: { session: id, thread } });
    const publishGrill = (id, entry) => notifier.publish({ type: "grill", session: id, data: { session: id, entry } });
    /** Respond with the event; ack only after the bytes are out (see header comment). */
    function respondEvent(c, queue, event) {
        const session = event.payload.session;
        const outgoing = c.env?.outgoing;
        if (!outgoing) {
            queue.flush(event); // app.request() test path: no socket to wait on
            publishQueue(session, queue.size);
        }
        else if (outgoing.destroyed || outgoing.closed) {
            // Client vanished before we built the response. The closed check matters:
            // once "close" has fired, a listener added below would never run and the
            // event would sit unacked-unrequeued in the in-flight list until restart.
            queue.requeue(event);
        }
        else {
            outgoing.once("close", () => {
                if (outgoing.writableFinished)
                    queue.flush(event);
                else
                    queue.requeue(event);
                publishQueue(session, queue.size);
            });
        }
        return c.json(event.payload);
    }
    const app = new Hono();
    // Loopback binding doesn't stop a malicious webpage from firing fetch() at
    // 127.0.0.1 (no-cors requests are delivered even though the response is
    // opaque). Browsers always attach Origin to cross-origin POSTs; the CLI and
    // curl send none, and the M2 web UI is same-origin — so a foreign Origin on
    // a state-changing call is refused (DECISIONS.md "Foreign-Origin requests").
    app.use("/api/*", async (c, next) => {
        const origin = c.req.header("origin");
        if (c.req.method !== "GET" && origin !== undefined && !sameOrigin(origin, c.req.header("host"))) {
            return c.json({ error: { code: "E_FORBIDDEN", message: "cross-origin requests are refused" } }, 403);
        }
        await next();
    });
    app.onError((error, c) => c.json({ error: { code: "E_INTERNAL", message: error.message } }, 500));
    app.notFound((c) => c.json({ error: { code: "E_NOT_FOUND", message: `no route: ${c.req.method} ${c.req.path}` } }, 404));
    app.get("/api/health", (c) => c.json({ app: "otacond", version: VERSION, pid: process.pid }));
    app.post("/api/shutdown", (c) => {
        // Fire the hook only once the response is out (or the client is already
        // gone): main.ts exits the process in it, and a timing guess would race
        // the response flush.
        const outgoing = c.env?.outgoing;
        if (outgoing && !outgoing.destroyed && !outgoing.closed) {
            outgoing.once("close", () => options.onShutdown?.());
        }
        else {
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
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        return c.json(summarize(session));
    });
    // otacon clean's deregistration (DESIGN.md §6, §12): only an approved
    // (ended) session may leave the registry — the CLI archives its .otacon/
    // dir afterwards. The queue instance is evicted with it; still-queued
    // events on an ended session (an undrained `approved` copy) leave with the
    // dir by design (DECISIONS.md "clean: daemon deregisters, CLI archives").
    app.delete("/api/sessions/:id", (c) => {
        const session = sessionFor(c);
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        if (session.status !== "approved") {
            return c.json({
                error: {
                    code: "E_SESSION_ACTIVE",
                    message: `session ${session.id} is ${session.status} — only approved (ended) sessions can be cleaned`,
                },
            }, 409);
        }
        const queue = queueFor(session.id);
        const pendingEvents = queue.size;
        // Deregister first — it can throw (registry flush), and an early queue
        // eviction would orphan in-flight ack tracking for a session that is in
        // fact still registered. Then close the evicted instance so a late
        // in-flight ack cannot recreate .otacon/<id>/ after the CLI archives it.
        store.deleteSession(session.id);
        queue.close();
        queues.delete(session.id);
        // Terminal frame: the index and switcher drop the session live, and an
        // open review tab flips to its cleaned state instead of error-limbo.
        notifier.publish({ type: "removed", session: session.id, data: { session: session.id } });
        return c.json({ ok: true, session: session.id, repo: session.repo, pendingEvents });
    });
    app.get("/api/sessions/:id/events", (c) => {
        const session = sessionFor(c);
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        const queue = queueFor(session.id);
        const raw = Number(c.req.query("wait") ?? "0");
        const waitSeconds = Number.isFinite(raw)
            ? Math.min(Math.max(raw, 0), MAX_WAIT_SECONDS)
            : 0;
        // Fast path and parking are one synchronous block: no enqueue can slip
        // between this take() and park() (DECISIONS.md "SessionQueue: synchronous").
        const immediate = queue.take();
        if (immediate)
            return respondEvent(c, queue, immediate);
        if (waitSeconds === 0)
            return timeoutEvent(c);
        const signal = c.req.raw.signal; // materializes node-server's AbortController
        // node-server only aborts that controller if it existed when the socket's
        // "close" fired. A client that vanished before this handler ran would
        // otherwise park a zombie waiter for the full wait window.
        const outgoing = c.env?.outgoing;
        if (signal.aborted || outgoing?.destroyed || outgoing?.closed)
            return timeoutEvent(c);
        return new Promise((resolve) => {
            let settled = false;
            let timer;
            let handle;
            const settle = (response) => {
                if (settled)
                    return;
                settled = true;
                if (timer !== undefined)
                    clearTimeout(timer);
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
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        // Raw markdown body, or {"plan": "...", "resolutions": {...}} JSON — the
        // CLI sends resolutions.json's content along (DESIGN.md §6). The raw path
        // carries no resolutions, so L5 still rejects it when threads are open.
        let content = await c.req.text();
        if (sessionEnded(session.id))
            return sessionOver(c, session.id);
        let resolutions = {};
        if (c.req.header("content-type")?.includes("json")) {
            let body;
            try {
                body = JSON.parse(content);
            }
            catch {
                body = undefined;
            }
            const plan = body?.plan;
            if (typeof plan !== "string")
                return badRequest(c, "JSON body must carry a string plan");
            const parsed = parseResolutions(body.resolutions);
            if (!parsed) {
                return badRequest(c, 'resolutions must be {"changelog"?: string, "threads"?: {"t<n>": "reply"}}');
            }
            content = plan;
            resolutions = parsed;
        }
        if (content.trim() === "")
            return badRequest(c, "request body must be the plan markdown");
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
        const changelog = (resolutions.changelog ?? "").trim() === "" ? null : resolutions.changelog;
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
        for (const thread of changedThreads)
            publishThread(session.id, thread);
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
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
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
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        const state = store.readState(session.id);
        if (state.revision === 0) {
            return notFound(c, `session ${session.id} has no revisions to diff`);
        }
        const parseRev = (raw, fallback) => {
            if (raw === undefined || raw === "")
                return fallback;
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
        const payload = {
            session: session.id,
            from,
            to,
            sections: diffPlans(from === 0 ? "" : store.readRevision(session.id, from), store.readRevision(session.id, to)),
        };
        return c.json(payload);
    });
    app.post("/api/sessions/:id/comments", async (c) => {
        const session = sessionFor(c);
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        const queue = queueFor(session.id); // before any state write: can throw on a corrupt file
        const body = (await readJsonBody(c)) ?? {};
        if (sessionEnded(session.id))
            return sessionOver(c, session.id);
        const rawItems = body.items;
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
            return badRequest(c, "items must be a non-empty array");
        }
        const drafts = [];
        for (const raw of rawItems) {
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
        const items = drafts.map((draft, i) => ({
            thread: `t${firstThread + i + 1}`,
            ...draft,
        }));
        const batch = `b${counters.batch}`;
        // Each item becomes a persistent thread (DESIGN.md §9) — the rail's
        // source of truth; the queued event is only the agent's wake-up copy.
        const createdAt = new Date().toISOString();
        const threads = items.map((item) => ({
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
        const payload = { event: "comments", session: session.id, batch, items };
        queue.enqueue(payload, counters.eventSeq);
        publishSession(updated); // after the enqueue, so the summary carries the fresh pending count
        for (const thread of threads)
            publishThread(session.id, thread);
        return c.json({ ok: true, batch, threads: items.map((i) => i.thread), seq: counters.eventSeq }, 202);
    });
    app.post("/api/sessions/:id/questions", async (c) => {
        const session = sessionFor(c);
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        const queue = queueFor(session.id); // before any state write: can throw on a corrupt file
        const body = (await readJsonBody(c)) ?? {};
        if (sessionEnded(session.id))
            return sessionOver(c, session.id);
        const anchor = parseAnchor(body.anchor);
        if (typeof body.body !== "string" || body.body.trim() === "" || anchor === undefined) {
            return badRequest(c, "question needs a non-empty body and a valid anchor (or null)");
        }
        const counters = store.bumpCounters(session.id, { question: 1, eventSeq: 1 });
        const id = `q${counters.question}`;
        const thread = {
            id,
            kind: "question",
            anchor,
            body: body.body,
            createdAt: new Date().toISOString(),
        };
        appendThreads(store.threadsPath(session.id), [thread]);
        // Questions leave the plan — and the status — untouched (DESIGN.md §9).
        const payload = {
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
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        const body = (await readJsonBody(c)) ?? {};
        if (sessionEnded(session.id))
            return sessionOver(c, session.id);
        if (typeof body.body !== "string" || body.body.trim() === "") {
            return badRequest(c, "answer needs a non-empty body");
        }
        const qid = c.req.param("qid") ?? "";
        const thread = answerQuestion(store.threadsPath(session.id), qid, body.body);
        if (!thread) {
            return c.json({
                error: {
                    code: "E_UNKNOWN_QUESTION",
                    message: `session ${session.id} has no question ${qid}`,
                },
            }, 404);
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
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        return c.json({ session: session.id, threads: readThreads(store.threadsPath(session.id)) });
    });
    // The agent's grill question (otacon ask, DESIGN.md §6, §8): persisted in
    // the transcript and pushed to the UI as a card; no agent event is queued —
    // the asker goes straight back to `otacon wait` for the answer.
    app.post("/api/sessions/:id/ask", async (c) => {
        const session = sessionFor(c);
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        const body = (await readJsonBody(c)) ?? {};
        if (sessionEnded(session.id))
            return sessionOver(c, session.id);
        const { question, options, recommend, multi } = body;
        if (typeof question !== "string" || question.trim() === "") {
            return badRequest(c, "question must be a non-empty string");
        }
        if (options !== undefined) {
            const ok = Array.isArray(options) &&
                options.length >= 2 &&
                options.every((o) => typeof o === "string" && o.trim() !== "") &&
                new Set(options).size === options.length;
            if (!ok)
                return badRequest(c, "options must be 2+ distinct non-empty strings");
        }
        if (recommend !== undefined) {
            if (!Array.isArray(options) || typeof recommend !== "string" || !options.includes(recommend)) {
                return badRequest(c, "recommend must name one of the options");
            }
        }
        if (multi !== undefined && (typeof multi !== "boolean" || (multi && options === undefined))) {
            return badRequest(c, "multi must be a boolean and requires options");
        }
        const counters = store.bumpCounters(session.id, { question: 1 });
        const entry = {
            id: `q${counters.question}`,
            question,
            ...(options !== undefined ? { options: options } : {}),
            ...(recommend !== undefined ? { recommend: recommend } : {}),
            ...(multi === true ? { multi: true } : {}),
            askedAt: new Date().toISOString(),
        };
        appendEntry(store.transcriptPath(session.id), entry);
        publishGrill(session.id, entry);
        // The summary's openQuestions just moved: the index's "questions pending"
        // chip rides session frames, so every transcript change publishes one.
        publishSession(store.getSession(session.id) ?? session);
        return c.json({ ok: true, session: session.id, id: entry.id }, 201);
    });
    // The user's side of a grill question (DESIGN.md §6, §8): the answer lands
    // on the transcript entry and an `answer` event wakes the parked agent.
    app.post("/api/sessions/:id/answers", async (c) => {
        const session = sessionFor(c);
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        const queue = queueFor(session.id); // before any state write: can throw on a corrupt file
        const body = (await readJsonBody(c)) ?? {};
        if (sessionEnded(session.id))
            return sessionOver(c, session.id);
        const { question, choice, choices, text } = body;
        if (typeof question !== "string" || question === "") {
            return badRequest(c, "question must name a transcript question id (q<n>)");
        }
        const asked = readTranscript(store.transcriptPath(session.id)).find((e) => e.id === question);
        if (!asked) {
            return c.json({
                error: {
                    code: "E_UNKNOWN_QUESTION",
                    message: `session ${session.id} has no grill question ${question}`,
                },
            }, 404);
        }
        if (text !== undefined && typeof text !== "string") {
            return badRequest(c, "text must be a string");
        }
        // The answer must fit the question's shape: chips for option questions
        // (one chip, or 1+ under --multi), free text for optionless ones.
        if (asked.options === undefined) {
            if (choice !== undefined || choices !== undefined) {
                return badRequest(c, `${question} has no options — answer with text only`);
            }
            if (typeof text !== "string" || text.trim() === "") {
                return badRequest(c, `${question} needs a non-empty text answer`);
            }
        }
        else if (asked.multi === true) {
            const ok = choice === undefined &&
                Array.isArray(choices) &&
                choices.length > 0 &&
                choices.every((x) => typeof x === "string" && asked.options.includes(x)) &&
                new Set(choices).size === choices.length;
            if (!ok) {
                return badRequest(c, `${question} is multi-choice — pass distinct choices from its options`);
            }
        }
        else if (choices !== undefined ||
            typeof choice !== "string" ||
            !asked.options.includes(choice)) {
            return badRequest(c, `${question} needs a single choice from its options`);
        }
        const answer = {
            ...(typeof choice === "string" ? { choice } : {}),
            ...(Array.isArray(choices) ? { choices: choices } : {}),
            ...(typeof text === "string" && text.trim() !== "" ? { text } : {}),
            answeredAt: new Date().toISOString(),
        };
        // Re-answering overwrites (at-least-once: a duplicate POST is legitimate);
        // the agent sees a second answer event with the same question id.
        const updated = answerEntry(store.transcriptPath(session.id), question, answer);
        const payload = {
            event: "answer",
            session: session.id,
            question,
            ...(answer.choice !== undefined ? { choice: answer.choice } : {}),
            ...(answer.choices !== undefined ? { choices: answer.choices } : {}),
            ...(answer.text !== undefined ? { text: answer.text } : {}),
        };
        queue.enqueue(payload, store.bumpCounter(session.id, "eventSeq"));
        publishQueue(session.id, queue.size);
        if (updated)
            publishGrill(session.id, updated);
        // openQuestions dropped (or held, on a re-answer) — keep the chip honest.
        publishSession(store.getSession(session.id) ?? session);
        return c.json({ ok: true, session: session.id, question }, 202);
    });
    app.get("/api/sessions/:id/transcript", (c) => {
        const session = sessionFor(c);
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        return c.json({
            session: session.id,
            transcript: readTranscript(store.transcriptPath(session.id)),
        });
    });
    // Approve ends the session (DESIGN.md §6 step 6, §12): the daemon writes
    // docs/plans/YYYY-MM-DD-<slug>.md (final revision, status: approved, grill
    // transcript appended), flips the session approved — after which every
    // mutating verb refuses — and queues the `approved` event for the parked
    // agent to commit the file. Unresolved threads refuse 409 unless {force}.
    app.post("/api/sessions/:id/approve", async (c) => {
        const session = sessionFor(c);
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
        const queue = queueFor(session.id); // before any state write: can throw on a corrupt file
        const body = (await readJsonBody(c)) ?? {};
        // Doubles as the double-approve guard: two concurrent approves both
        // snapshot in_review, but the loser re-checks here after its body await
        // and refuses instead of writing a second (-2 suffixed) artifact.
        if (sessionEnded(session.id))
            return sessionOver(c, session.id);
        if (body.force !== undefined && typeof body.force !== "boolean") {
            return badRequest(c, "force must be a boolean");
        }
        const state = store.readState(session.id);
        if (state.revision === 0) {
            return c.json({
                error: {
                    code: "E_NO_REVISION",
                    message: `session ${session.id} has no revisions to approve`,
                },
            }, 409);
        }
        // Unresolved = comment threads with no resolution + user questions with no
        // answer — the same open items the rail shows. The 409 carries the count;
        // the UI warns and retries with {force:true} on confirm.
        const unresolved = readThreads(store.threadsPath(session.id)).filter((t) => t.kind === "comment" ? t.resolution === undefined : t.answer === undefined).length;
        if (unresolved > 0 && body.force !== true) {
            return c.json({
                error: {
                    code: "E_UNRESOLVED_THREADS",
                    message: `session has ${unresolved} unresolved thread(s); approve with {"force":true} to override`,
                },
                unresolved,
            }, 409);
        }
        const artifact = composeArtifact(store.readRevision(session.id, state.revision), {
            revision: state.revision,
            entries: readTranscript(store.transcriptPath(session.id)),
        });
        const relPath = pickArtifactRelPath(session.repo, session.title, localDate());
        // Artifact on disk first, then the status flip (the registry is the commit
        // point — same ordering argument as createSession), then the wake-up.
        writeFileAtomic(join(session.repo, relPath), artifact);
        const updated = store.updateSession(session.id, { status: "approved" });
        const payload = { event: "approved", session: session.id, path: relPath };
        queue.enqueue(payload, store.bumpCounter(session.id, "eventSeq"));
        publishSession(updated); // after the enqueue, so the summary carries the fresh pending count
        return c.json({
            ok: true,
            session: session.id,
            revision: state.revision,
            path: relPath,
            unresolved,
        });
    });
    app.get("/api/sessions/:id/revisions/:n", (c) => {
        const session = sessionFor(c);
        if (!session)
            return notFound(c, `unknown session: ${c.req.param("id")}`);
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
            const payload = {
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
        uiDir: options.uiDir,
        heartbeatMs: options.sseHeartbeatMs,
    });
    return app;
}
//# sourceMappingURL=app.js.map