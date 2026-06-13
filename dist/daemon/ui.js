// The daemon's browser-facing surface: the built SPA (static files from
// dist/ui) and the SSE streams the UI watches (DESIGN.md §6, §10). Static
// serving is hand-rolled because @hono/node-server's serveStatic resolves
// roots against process.cwd(), which is meaningless for a daemon spawned from
// any repo (DECISIONS.md "Daemon serves the built SPA from dist/ui").
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const HEARTBEAT_MS = 25_000;
/** Vite's output is flat hashed names — no slashes means no traversal. */
const ASSET_NAME = /^[A-Za-z0-9_.-]+$/;
const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".woff2": "font/woff2",
};
/** dist/daemon/ui.js → ../ui = dist/ui; a source-tree run under bun falls back to <root>/dist/ui. */
function resolveBuiltUiDir() {
    for (const candidate of ["../ui/", "../../dist/ui/"]) {
        const dir = fileURLToPath(new URL(candidate, import.meta.url));
        if (existsSync(join(dir, "index.html")))
            return dir;
    }
    return undefined;
}
const encoder = new TextEncoder();
function frame(event, data) {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
/**
 * One SSE response: a `snapshot` frame immediately (so subscribers never race
 * a separate fetch), then every published UiEvent — optionally filtered to one
 * session — plus a comment heartbeat that keeps idle proxies from severing the
 * stream. No event ids: a reconnect re-syncs from the fresh snapshot.
 */
function sse(c, deps, snapshot, onlySession) {
    // Materializes node-server's lazy AbortController so client disconnects
    // abort the signal (same trick as the events long-poll in app.ts).
    const signal = c.req.raw.signal;
    let cleanup;
    const dispose = () => {
        cleanup?.();
        cleanup = undefined;
    };
    const stream = new ReadableStream({
        start(controller) {
            // Built before any resource exists: if snapshot() throws (a session read
            // gone wrong), the error propagates out of sse() into app.onError with
            // no subscription or heartbeat left behind to leak.
            const snapshotFrame = frame("snapshot", snapshot());
            const close = () => {
                dispose();
                try {
                    controller.close();
                }
                catch {
                    // already closed or cancelled
                }
            };
            const send = (chunk) => {
                try {
                    controller.enqueue(chunk);
                }
                catch {
                    close(); // reader vanished mid-enqueue
                }
            };
            const unsubscribe = deps.notifier.subscribe((event) => {
                if (onlySession !== undefined && event.session !== onlySession)
                    return;
                send(frame(event.type, event.data));
                // `removed` is terminal for a single-session stream: the session left
                // the registry, so nothing can ever be published for it again. End the
                // response server-side too — otherwise a client that ignores the frame
                // pins this connection (subscription + heartbeat) forever. The index
                // stream stays open: other sessions keep flowing.
                if (onlySession !== undefined && event.type === "removed")
                    close();
            });
            const heartbeat = setInterval(() => send(encoder.encode(": hb\n\n")), deps.heartbeatMs ?? HEARTBEAT_MS);
            heartbeat.unref?.(); // never holds the process open
            const onAbort = () => close();
            cleanup = () => {
                unsubscribe();
                clearInterval(heartbeat);
                signal.removeEventListener("abort", onAbort);
            };
            send(snapshotFrame);
            if (signal.aborted)
                close();
            else
                signal.addEventListener("abort", onAbort);
        },
        cancel() {
            dispose();
        },
    });
    return new Response(stream, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
        },
    });
}
export function registerUiRoutes(app, deps) {
    const uiDir = deps.uiDir === undefined ? resolveBuiltUiDir() : deps.uiDir;
    // The SPA shell. /s/:id always answers 200 — a static shell cannot know
    // session ids, so unknown sessions render a client-side not-found state.
    const shell = (c) => {
        if (uiDir == null) {
            return c.text("otacon: web UI is not built — run `bun run build` (output: dist/ui)\n", 503);
        }
        return c.html(readFileSync(join(uiDir, "index.html"), "utf8"), 200, {
            "cache-control": "no-cache",
        });
    };
    app.get("/", shell);
    app.get("/s/:id", shell);
    app.get("/assets/*", (c) => {
        const name = c.req.path.slice("/assets/".length);
        const type = CONTENT_TYPES[name.slice(name.lastIndexOf("."))];
        const path = uiDir != null && ASSET_NAME.test(name) && type !== undefined
            ? join(uiDir, "assets", name)
            : undefined;
        if (path === undefined || !existsSync(path))
            return c.text("not found\n", 404);
        // Vite asset names are content-hashed: immutable forever.
        return new Response(new Uint8Array(readFileSync(path)), {
            headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" },
        });
    });
    app.get("/api/stream", (c) => sse(c, deps, () => ({ sessions: deps.listSummaries() })));
    app.get("/api/sessions/:id/stream", (c) => {
        const id = c.req.param("id");
        if (!deps.getSummary(id)) {
            return c.json({ error: { code: "E_NOT_FOUND", message: `unknown session: ${id}` } }, 404);
        }
        // Threads and the transcript ride the snapshot so the rail and the
        // Interview panel never race a separate fetch against `thread`/`grill`
        // frames (same argument as snapshot-first itself).
        return sse(c, deps, () => ({
            session: deps.getSummary(id),
            threads: deps.getThreads(id),
            transcript: deps.getTranscript(id),
        }), id);
    });
}
//# sourceMappingURL=ui.js.map