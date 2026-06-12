import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { eventsPath, revisionPath } from "../shared/paths.js";
import type { RegistrySession } from "../shared/types.js";
import { VERSION } from "../shared/version.js";
import type { NodeBindings } from "./app.js";
import { createApp } from "./app.js";
import { Store } from "./store.js";

let home: string;
let repo: string;
let savedHome: string | undefined;
let store: Store;
let app: Hono<{ Bindings: NodeBindings }>;
let shutdowns: number;

beforeEach(() => {
  savedHome = process.env.OTACON_HOME;
  home = mkdtempSync(join(tmpdir(), "otacon-home-"));
  repo = mkdtempSync(join(tmpdir(), "otacon-repo-"));
  process.env.OTACON_HOME = home;
  store = new Store();
  shutdowns = 0;
  app = createApp({ store, onShutdown: () => (shutdowns += 1) });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mintSession(): RegistrySession {
  return store.createSession({ title: "e2e plan", repo });
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validPlanFor(id: string): string {
  const fixture = readFileSync(
    join(import.meta.dir, "../../test/fixtures/valid-plan.md"),
    "utf8",
  );
  return fixture.replace("otc_test01", id);
}

type FakeOutgoing = Omit<ServerResponse, "writableFinished"> & {
  destroyed: boolean;
  closed: boolean;
  writableFinished: boolean;
};

/** Just enough of a Node ServerResponse for the ack/abort paths: state flags + "close". */
function fakeOutgoing(
  overrides: Partial<Pick<ServerResponse, "destroyed" | "closed" | "writableFinished">> = {},
): FakeOutgoing {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    destroyed: false,
    closed: false,
    writableFinished: false,
    ...overrides,
  }) as unknown as FakeOutgoing;
}

function eventsOnDisk(id: string): unknown[] {
  return (JSON.parse(readFileSync(eventsPath(repo, id), "utf8")) as { events: unknown[] }).events;
}

describe("health and shutdown", () => {
  test("GET /api/health reports app, version, and pid", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ app: "otacond", version: VERSION, pid: process.pid });
  });

  test("POST /api/shutdown responds ok and invokes the shutdown hook", async () => {
    const res = await app.request("/api/shutdown", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(shutdowns).toBe(1);
  });

  test("unknown routes return a machine-readable 404", async () => {
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("E_NOT_FOUND");
  });
});

describe("session CRUD", () => {
  test("POST /api/sessions mints and registers a session", async () => {
    const res = await postJson("/api/sessions", { title: "auth refactor", repo, branch: "main" });
    expect(res.status).toBe(201);
    const session = (await res.json()) as RegistrySession;
    expect(session.id).toMatch(/^otc_[0-9a-z]{6}$/);
    expect(session.status).toBe("draft");
    expect(session.branch).toBe("main");
    expect(store.getSession(session.id)?.title).toBe("auth refactor");
  });

  test("POST /api/sessions rejects missing title and relative repo", async () => {
    expect((await postJson("/api/sessions", { repo })).status).toBe(400);
    const res = await postJson("/api/sessions", { title: "x", repo: "not/absolute" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("E_BAD_REQUEST");
  });

  test("GET /api/sessions lists registered sessions", async () => {
    const a = mintSession();
    const b = mintSession();
    const res = await app.request("/api/sessions");
    const body = (await res.json()) as { sessions: RegistrySession[] };
    expect(body.sessions.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("GET /api/sessions/:id includes revision and pending event count", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/questions`, { body: "why?" });
    const res = await app.request(`/api/sessions/${session.id}`);
    const body = (await res.json()) as { revision: number; pendingEvents: number };
    expect(res.status).toBe(200);
    expect(body.revision).toBe(0);
    expect(body.pendingEvents).toBe(1);
  });

  test("GET /api/sessions/:id 404s on unknown ids", async () => {
    const res = await app.request("/api/sessions/otc_zzzzzz");
    expect(res.status).toBe(404);
  });
});

describe("submit", () => {
  test("an invalid plan is rejected 422 with machine-readable issues", async () => {
    const session = mintSession();
    const res = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: "# not a plan\n",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      ok: boolean;
      errors: { rule: string; code: string }[];
    };
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]?.rule).toBe("L1");
    expect(body.errors.every((e) => typeof e.code === "string")).toBe(true);
    expect(store.readState(session.id).revision).toBe(0);
    expect(store.getSession(session.id)?.status).toBe("draft");
  });

  test("a plan for the wrong session is a hard lint error", async () => {
    const session = mintSession();
    const res = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: validPlanFor("otc_other1"),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors.map((e) => e.code)).toContain("E_SESSION_MISMATCH");
  });

  test("a valid plan stores revision 1 and flips status to in_review", async () => {
    const session = mintSession();
    const res = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: validPlanFor(session.id),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; revision: number; status: string };
    expect(body).toMatchObject({ ok: true, session: session.id, revision: 1, status: "in_review" });
    expect(existsSync(revisionPath(repo, session.id, 1))).toBe(true);
    expect(store.getSession(session.id)?.status).toBe("in_review");
  });

  test("accepts a JSON body carrying the plan, for the CLI's resolutions rider", async () => {
    const session = mintSession();
    const res = await postJson(`/api/sessions/${session.id}/submit`, {
      plan: validPlanFor(session.id),
      resolutions: { t1: "done" },
    });
    expect(res.status).toBe(200);
  });

  test("a resubmit with a stale frontmatter revision passes with a warning", async () => {
    const session = mintSession();
    const plan = validPlanFor(session.id);
    await app.request(`/api/sessions/${session.id}/submit`, { method: "POST", body: plan });
    const res = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: plan, // still says revision: 1; daemon is at 2 now
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revision: number; warnings: { code: string }[] };
    expect(body.revision).toBe(2);
    expect(body.warnings.map((w) => w.code)).toContain("W_REVISION_MISMATCH");
  });

  test("an empty body is a 400, not a lint run", async () => {
    const session = mintSession();
    const res = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: "",
    });
    expect(res.status).toBe(400);
  });
});

describe("comments and questions", () => {
  test("a comment batch mints batch/thread ids, queues an event, and sets revising", async () => {
    const session = mintSession();
    const res = await postJson(`/api/sessions/${session.id}/comments`, {
      items: [
        { anchor: { section: "phase-1", exact: "RS256" }, body: "why not HS256?" },
        { anchor: null, body: "overall: too broad" },
      ],
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, batch: "b1", threads: ["t1", "t2"], seq: 1 });
    expect(store.getSession(session.id)?.status).toBe("revising");

    const event = await app.request(`/api/sessions/${session.id}/events`);
    const payload = (await event.json()) as Record<string, unknown>;
    expect(payload).toEqual({
      event: "comments",
      session: session.id,
      batch: "b1",
      items: [
        { thread: "t1", anchor: { section: "phase-1", exact: "RS256" }, body: "why not HS256?" },
        { thread: "t2", anchor: null, body: "overall: too broad" },
      ],
    });
  });

  test("comment validation: empty items, missing body, malformed anchor", async () => {
    const session = mintSession();
    const url = `/api/sessions/${session.id}/comments`;
    expect((await postJson(url, { items: [] })).status).toBe(400);
    expect((await postJson(url, { items: [{ anchor: null }] })).status).toBe(400);
    expect((await postJson(url, { items: [{ anchor: { exact: "x" }, body: "b" }] })).status).toBe(400);
  });

  test("a question queues a question event and leaves status untouched", async () => {
    const session = mintSession();
    const res = await postJson(`/api/sessions/${session.id}/questions`, {
      anchor: { section: "decisions" },
      body: "what about refresh tokens?",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, id: "q1", seq: 1 });
    expect(store.getSession(session.id)?.status).toBe("draft");

    const event = await app.request(`/api/sessions/${session.id}/events`);
    expect(await event.json()).toEqual({
      event: "question",
      session: session.id,
      id: "q1",
      anchor: { section: "decisions" },
      body: "what about refresh tokens?",
    });
  });

  test("event seqs keep climbing across batches and questions", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "a" }] });
    const res = await postJson(`/api/sessions/${session.id}/questions`, { body: "b" });
    expect(((await res.json()) as { seq: number }).seq).toBe(2);
  });

  test("posting to an unknown session 404s without minting ids", async () => {
    const res = await postJson("/api/sessions/otc_zzzzzz/comments", { items: [{ body: "x" }] });
    expect(res.status).toBe(404);
  });
});

describe("events long-poll", () => {
  test("fast path: a queued event is delivered without waiting and acked on disk", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/questions`, { body: "q" });
    const res = await app.request(`/api/sessions/${session.id}/events?wait=540`);
    const payload = (await res.json()) as { event: string; session: string };
    expect(payload.event).toBe("question");
    expect(payload.session).toBe(session.id);
    // app.request() has no socket, so the ack is immediate: disk is drained.
    const file = JSON.parse(readFileSync(eventsPath(repo, session.id), "utf8"));
    expect(file.events).toEqual([]);
  });

  test("wait=0 returns {\"event\":\"timeout\"} immediately when the queue is empty", async () => {
    const session = mintSession();
    const res = await app.request(`/api/sessions/${session.id}/events`);
    expect(await res.json()).toEqual({ event: "timeout" });
  });

  test("a parked poll is woken by a comment posted while it waits", async () => {
    const session = mintSession();
    const parked = app.request(`/api/sessions/${session.id}/events?wait=5`);
    await sleep(20); // let the handler reach park()
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "wake up" }] });
    const res = await parked;
    const payload = (await res.json()) as { event: string; batch: string; session: string };
    expect(payload.event).toBe("comments");
    expect(payload.batch).toBe("b1");
    expect(payload.session).toBe(session.id);
  });

  test("a parked poll expires with {\"event\":\"timeout\"} and stays parked until then", async () => {
    const session = mintSession();
    const started = Date.now();
    const res = await app.request(`/api/sessions/${session.id}/events?wait=0.1`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(await res.json()).toEqual({ event: "timeout" });
  });

  test("two parked polls are served FIFO, one event each", async () => {
    const session = mintSession();
    const first = app.request(`/api/sessions/${session.id}/events?wait=5`);
    await sleep(20);
    const second = app.request(`/api/sessions/${session.id}/events?wait=5`);
    await sleep(20);
    await postJson(`/api/sessions/${session.id}/questions`, { body: "one" });
    await postJson(`/api/sessions/${session.id}/questions`, { body: "two" });
    const bodies = [
      (await (await first).json()) as { id: string },
      (await (await second).json()) as { id: string },
    ];
    expect(bodies.map((b) => b.id)).toEqual(["q1", "q2"]);
  });

  test("events for unknown sessions 404 instead of parking", async () => {
    const res = await app.request("/api/sessions/otc_zzzzzz/events?wait=540");
    expect(res.status).toBe(404);
  });
});

describe("revisions and placeholder page", () => {
  test("GET /revisions/:n returns the stored markdown", async () => {
    const session = mintSession();
    const plan = validPlanFor(session.id);
    await app.request(`/api/sessions/${session.id}/submit`, { method: "POST", body: plan });
    const res = await app.request(`/api/sessions/${session.id}/revisions/1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe(plan);
  });

  test("missing and malformed revision numbers are rejected", async () => {
    const session = mintSession();
    expect((await app.request(`/api/sessions/${session.id}/revisions/1`)).status).toBe(404);
    expect((await app.request(`/api/sessions/${session.id}/revisions/abc`)).status).toBe(400);
    expect((await app.request(`/api/sessions/${session.id}/revisions/0`)).status).toBe(400);
  });

  test("GET /s/:id serves the placeholder page; unknown ids 404", async () => {
    const session = mintSession();
    const res = await app.request(`/s/${session.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(session.id);
    expect((await app.request("/s/otc_zzzzzz")).status).toBe(404);
  });

  test("placeholder page escapes HTML in session titles", async () => {
    const session = store.createSession({ title: "<script>alert(1)</script>", repo });
    const text = await (await app.request(`/s/${session.id}`)).text();
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });
});

describe("socket-bound delivery (fake outgoing)", () => {
  test("an event is acked only once the response 'close' reports it fully written", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/questions`, { body: "q" });
    const outgoing = fakeOutgoing();
    const res = await app.request(`/api/sessions/${session.id}/events`, {}, { outgoing });
    expect(((await res.json()) as { event: string }).event).toBe("question");
    // Delivered but unacked: still durable on disk.
    expect(eventsOnDisk(session.id)).toHaveLength(1);
    outgoing.writableFinished = true;
    outgoing.emit("close");
    expect(eventsOnDisk(session.id)).toEqual([]);
  });

  test("a client abort mid-write requeues the event for the next poll", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/questions`, { body: "q" });
    const outgoing = fakeOutgoing();
    await app.request(`/api/sessions/${session.id}/events`, {}, { outgoing });
    outgoing.emit("close"); // writableFinished still false: aborted
    expect(eventsOnDisk(session.id)).toHaveLength(1);
    const retry = await app.request(`/api/sessions/${session.id}/events`);
    expect(((await retry.json()) as { id: string }).id).toBe("q1");
  });

  test("a response whose socket already closed requeues instead of arming a dead listener", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/questions`, { body: "q" });
    // "close" already fired: a once("close") ack listener would never run.
    const outgoing = fakeOutgoing({ closed: true });
    await app.request(`/api/sessions/${session.id}/events`, {}, { outgoing });
    expect(eventsOnDisk(session.id)).toHaveLength(1);
    const retry = await app.request(`/api/sessions/${session.id}/events`);
    expect(((await retry.json()) as { id: string }).id).toBe("q1");
  });

  test("a poll whose client is already gone times out instead of parking a zombie waiter", async () => {
    const session = mintSession();
    const started = Date.now();
    const res = await app.request(
      `/api/sessions/${session.id}/events?wait=540`,
      {},
      { outgoing: fakeOutgoing({ closed: true }) },
    );
    expect(await res.json()).toEqual({ event: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("shutdown hook fires only after the response is out", async () => {
    const outgoing = fakeOutgoing();
    const res = await app.request("/api/shutdown", { method: "POST" }, { outgoing });
    expect(await res.json()).toEqual({ ok: true });
    expect(shutdowns).toBe(0);
    outgoing.writableFinished = true;
    outgoing.emit("close");
    expect(shutdowns).toBe(1);
  });
});

describe("cross-origin guard", () => {
  test("state-changing API calls with a foreign Origin are refused 403", async () => {
    const res = await app.request("/api/shutdown", {
      method: "POST",
      headers: { origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("E_FORBIDDEN");
    expect(shutdowns).toBe(0);

    const session = mintSession();
    const comment = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ items: [{ body: "x" }] }),
    });
    expect(comment.status).toBe(403);
  });

  test("an opaque 'null' Origin is foreign too", async () => {
    const res = await app.request("/api/shutdown", {
      method: "POST",
      headers: { origin: "null" },
    });
    expect(res.status).toBe(403);
  });

  test("same-origin (the M2 web UI) and origin-less (the CLI) requests pass", async () => {
    const sameOriginRes = await app.request("/api/shutdown", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:4747", host: "127.0.0.1:4747" },
    });
    expect(sameOriginRes.status).toBe(200);
    const cliRes = await app.request("/api/shutdown", { method: "POST" });
    expect(cliRes.status).toBe(200);
    expect(shutdowns).toBe(2);
  });

  test("GETs with a foreign Origin still pass (no state change to protect)", async () => {
    const res = await app.request("/api/health", {
      headers: { origin: "http://evil.example" },
    });
    expect(res.status).toBe(200);
  });
});

describe("counter integrity on rejected batches", () => {
  test("a 400 comment batch mints no ids: the next valid batch starts at t1/b1/seq 1", async () => {
    const session = mintSession();
    const url = `/api/sessions/${session.id}/comments`;
    const rejected = await postJson(url, { items: [{ body: "fine" }, { body: "" }] });
    expect(rejected.status).toBe(400);
    expect(store.readState(session.id).counters).toEqual({
      batch: 0,
      thread: 0,
      question: 0,
      eventSeq: 0,
    });
    const accepted = await postJson(url, { items: [{ body: "valid" }] });
    expect(await accepted.json()).toEqual({ ok: true, batch: "b1", threads: ["t1"], seq: 1 });
  });
});
