import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryPath, sessionDir } from "../shared/paths.js";
import { SessionQueue } from "./queue.js";
import { Store, writeFileAtomic } from "./store.js";

let home: string;
let repo: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.OTACON_HOME;
  home = mkdtempSync(join(tmpdir(), "otacon-home-"));
  repo = mkdtempSync(join(tmpdir(), "otacon-repo-"));
  process.env.OTACON_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("writeFileAtomic", () => {
  test("creates parent directories and writes the content", () => {
    const path = join(repo, "deep", "nested", "file.json");
    writeFileAtomic(path, "hello\n");
    expect(readFileSync(path, "utf8")).toBe("hello\n");
  });

  test("replaces existing content and leaves no temp files", () => {
    const path = join(repo, "file.json");
    writeFileAtomic(path, "one");
    writeFileAtomic(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(readdirSync(repo)).toEqual(["file.json"]);
  });
});

describe("Store session CRUD", () => {
  test("createSession mints an otc_ id and registers the session", () => {
    const store = new Store();
    const session = store.createSession({ title: "auth refactor", repo });
    expect(session.id).toMatch(/^otc_[0-9a-z]{6}$/);
    expect(session.status).toBe("draft");
    expect(session.branch).toBe("");
    expect(session.quick).toBe(false);
    expect(session.createdAt).toBe(session.updatedAt);

    const registry = JSON.parse(readFileSync(registryPath(), "utf8"));
    expect(registry.version).toBe(1);
    expect(registry.sessions[session.id].title).toBe("auth refactor");
  });

  test("createSession seeds session.json and events.json in the repo", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo, branch: "main", quick: true });
    const dir = sessionDir(repo, id);
    const state = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    expect(state).toEqual({
      id,
      revision: 0,
      counters: { batch: 0, thread: 0, question: 0, eventSeq: 0 },
    });
    const events = JSON.parse(readFileSync(join(dir, "events.json"), "utf8"));
    expect(events).toEqual({ version: 1, events: [] });
    expect(store.getSession(id)?.branch).toBe("main");
    expect(store.getSession(id)?.quick).toBe(true);
  });

  test("minted ids are unique within a registry", () => {
    const store = new Store();
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) ids.add(store.createSession({ title: `s${i}`, repo }).id);
    expect(ids.size).toBe(25);
    expect(store.listSessions()).toHaveLength(25);
  });

  test("getSession returns a copy; mutations do not leak into the store", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    const copy = store.getSession(id);
    if (copy) copy.title = "mutated";
    expect(store.getSession(id)?.title).toBe("t");
  });

  test("getSession returns undefined for unknown ids; mutators throw", () => {
    const store = new Store();
    expect(store.getSession("otc_nosuch")).toBeUndefined();
    expect(() => store.updateSession("otc_nosuch", { status: "in_review" })).toThrow(
      /unknown session/,
    );
    expect(() => store.bumpCounter("otc_nosuch", "batch")).toThrow(/unknown session/);
    expect(() => store.saveRevision("otc_nosuch", "x")).toThrow(/unknown session/);
  });

  test("updateSession persists and bumps updatedAt", async () => {
    const store = new Store();
    const created = store.createSession({ title: "t", repo });
    await sleep(5);
    const updated = store.updateSession(created.id, { status: "in_review" });
    expect(updated.status).toBe("in_review");
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    expect(new Store().getSession(created.id)?.status).toBe("in_review");
  });

  test("a corrupt registry throws instead of silently starting empty", () => {
    writeFileSync(registryPath(), "{nope");
    expect(() => new Store()).toThrow(/corrupt registry/);
    writeFileSync(registryPath(), JSON.stringify({ version: 9, sessions: {} }));
    expect(() => new Store()).toThrow(/corrupt registry/);
  });
});

describe("Store counters and revisions", () => {
  test("bumpCounter increments independently per key and persists", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    expect(store.bumpCounter(id, "eventSeq")).toBe(1);
    expect(store.bumpCounter(id, "eventSeq")).toBe(2);
    expect(store.bumpCounter(id, "batch")).toBe(1);
    expect(new Store().bumpCounter(id, "eventSeq")).toBe(3);
    expect(new Store().readState(id).counters).toEqual({
      batch: 1,
      thread: 0,
      question: 0,
      eventSeq: 3,
    });
  });

  test("bumpCounters mints several counters in one persisted write", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    expect(store.bumpCounters(id, { thread: 3, batch: 1, eventSeq: 1 })).toEqual({
      batch: 1,
      thread: 3,
      question: 0,
      eventSeq: 1,
    });
    expect(new Store().readState(id).counters).toEqual({
      batch: 1,
      thread: 3,
      question: 0,
      eventSeq: 1,
    });
    expect(store.bumpCounter(id, "thread")).toBe(4);
  });

  test("a corrupt session.json shape throws instead of silently corrupting counters", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    const statePath = join(sessionDir(repo, id), "session.json");
    writeFileSync(statePath, JSON.stringify({ id })); // missing revision + counters
    expect(() => store.readState(id)).toThrow(/corrupt session state/);
    expect(() => store.bumpCounter(id, "eventSeq")).toThrow(/corrupt session state/);
    writeFileSync(statePath, JSON.stringify({ id, revision: 0, counters: {} }));
    expect(() => store.bumpCounter(id, "eventSeq")).toThrow(/corrupt session state/);
  });

  test("saveRevision writes r<N>.md snapshots and bumps revision", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    expect(store.saveRevision(id, "# plan v1\n")).toBe(1);
    expect(store.saveRevision(id, "# plan v2\n")).toBe(2);
    expect(existsSync(join(sessionDir(repo, id), "r1.md"))).toBe(true);
    expect(store.readRevision(id, 1)).toBe("# plan v1\n");
    expect(store.readRevision(id, 2)).toBe("# plan v2\n");
    expect(store.readState(id).revision).toBe(2);
    // Round-trip: a fresh Store continues the numbering from disk.
    expect(new Store().saveRevision(id, "# plan v3\n")).toBe(3);
  });
});

describe("end to end: store + queue across instances", () => {
  test("mint, enqueue, restart, drain — events survive on disk", () => {
    // First "daemon": mint a session and queue two events.
    const store = new Store();
    const session = store.createSession({ title: "demo", repo });
    const queue = new SessionQueue(store.eventsPath(session.id));
    queue.enqueue(
      { event: "question", session: session.id, id: "q1", anchor: null, body: "why?" },
      store.bumpCounter(session.id, "eventSeq"),
    );
    queue.enqueue(
      {
        event: "comments",
        session: session.id,
        batch: "b1",
        items: [{ thread: "t1", anchor: null, body: "tighten phase 2" }],
      },
      store.bumpCounter(session.id, "eventSeq"),
    );

    // "Restart": brand-new Store and SessionQueue see everything.
    const store2 = new Store();
    expect(store2.getSession(session.id)?.title).toBe("demo");
    const queue2 = new SessionQueue(store2.eventsPath(session.id));
    expect(queue2.size).toBe(2);
    const first = queue2.take();
    expect(first?.seq).toBe(1);
    expect(first?.payload).toMatchObject({ event: "question", id: "q1" });
    if (first) queue2.flush(first);

    // Second "restart": only the comment batch remains, seq continuity intact.
    const store3 = new Store();
    const queue3 = new SessionQueue(store3.eventsPath(session.id));
    expect(queue3.size).toBe(1);
    const second = queue3.take();
    expect(second?.seq).toBe(2);
    expect(second?.payload).toMatchObject({ event: "comments", batch: "b1" });
    expect(store3.bumpCounter(session.id, "eventSeq")).toBe(3);
  });
});
