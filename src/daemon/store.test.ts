import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryPath, sessionDir } from "../shared/paths.js";
import type { CanonicalGitHubRepo } from "../shared/knowledge.js";
import { pullRequestIdentity } from "../shared/review.js";
import type { PullRequestMetadata } from "../shared/review.js";
import type { RegistrySession } from "../shared/types.js";
import { SessionQueue } from "./queue.js";
import { quarantineCorruptFile, Store, writeFileAtomic } from "./store.js";

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

const project = "acme/app" as CanonicalGitHubRepo;
function pullRequest(headSha = "a".repeat(40)): PullRequestMetadata {
  return {
    identity: pullRequestIdentity(project, 42),
    url: "https://github.com/acme/app/pull/42",
    title: "Typed review sessions",
    author: "octo",
    baseRef: "main",
    headRef: "feature",
    headRepository: project,
    headSha,
    state: "open",
    isCrossRepository: false,
    permissions: { maintainerCanModify: true, viewerPermission: "write", readOnly: false },
  };
}

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

describe("quarantineCorruptFile", () => {
  test("does not throw when the file vanished before the rename", () => {
    // Quarantine exists to keep the daemon alive; a corrupt file deleted out
    // from under us mid-recovery must not turn into the new fatal path.
    expect(() => quarantineCorruptFile(join(home, "ghost.json"), "test file")).not.toThrow();
    expect(readdirSync(home)).toEqual([]); // nothing moved, nothing created
  });
});

describe("Store session CRUD", () => {
  test("createSession mints an otc_ id and registers the session", () => {
    const store = new Store();
    const session = store.createSession({ title: "auth refactor", repo });
    expect(session.id).toMatch(/^otc_[0-9a-z]{6}$/);
    expect(session.kind).toBe("plan");
    expect(session.status).toBe("draft");
    expect(session.branch).toBe("");
    expect(session.quick).toBe(false);
    expect(session.socratic).toBe(false);
    expect(session.createdAt).toBe(session.updatedAt);

    const registry = JSON.parse(readFileSync(registryPath(), "utf8"));
    expect(registry.version).toBe(1);
    expect(registry.sessions[session.id].title).toBe("auth refactor");
  });

  test("createSession stores a trimmed prompt only when non-empty", () => {
    const store = new Store();
    const withPrompt = store.createSession({ title: "t", repo, prompt: "  ship it  " });
    expect(withPrompt.prompt).toBe("ship it");
    expect(store.getSession(withPrompt.id)?.prompt).toBe("ship it");

    // A whitespace-only request leaves the field off entirely, like other optionals.
    const blank = store.createSession({ title: "t", repo, prompt: "   " });
    expect("prompt" in blank).toBe(false);
    expect("prompt" in (store.getSession(blank.id) as RegistrySession)).toBe(false);
  });

  test("createSession seeds session.json and events.json under the home store", () => {
    const store = new Store();
    const { id } = store.createSession({
      title: "t",
      repo,
      branch: "main",
      quick: true,
      socratic: true,
    });
    const dir = sessionDir(id);
    // Working state lives in the home store (~/.otacon/sessions/<id>/), keyed by
    // id, not in the repo (confine-otacon-dir-to-config-and-plans).
    expect(dir).toBe(join(home, "sessions", id));
    const state = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    expect(state).toEqual({
      lastReviewedRevision: 0,
      id,
      revision: 0,
      counters: { batch: 0, thread: 0, question: 0, eventSeq: 0 },
    });
    const events = JSON.parse(readFileSync(join(dir, "events.json"), "utf8"));
    expect(events).toEqual({ version: 1, events: [] });
    expect(store.getSession(id)?.branch).toBe("main");
    expect(store.getSession(id)?.quick).toBe(true);
    expect(store.getSession(id)?.socratic).toBe(true);
    // Nothing was created under <repo>/.otacon/ (it holds config + plans only).
    expect(existsSync(join(repo, ".otacon"))).toBe(false);
  });

  test("removeSessionDir permanently deletes the home dir (idempotent)", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    store.saveRevision(id, "# v1\n");
    const dir = sessionDir(id);
    expect(existsSync(dir)).toBe(true);
    // Deregister first (as the daemon does), then remove the home folder.
    store.deleteSession(id);
    store.removeSessionDir(id);
    expect(existsSync(dir)).toBe(false);
    // A second removal is a no-op (force), never a throw.
    expect(() => store.removeSessionDir(id)).not.toThrow();
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

  test("a corrupt registry is quarantined and the store starts fresh", () => {
    writeFileSync(registryPath(), "{nope");
    const store = new Store();
    expect(store.listSessions()).toEqual([]);
    const aside = readdirSync(home).filter((f) => f.startsWith("registry.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(home, aside[0] as string), "utf8")).toBe("{nope");
    // the fresh registry is persisted immediately and works
    expect(JSON.parse(readFileSync(registryPath(), "utf8"))).toEqual({
      version: 1,
      sessions: {},
    });
    expect(store.createSession({ title: "t", repo }).id).toMatch(/^otc_/);
  });

  test("a wrong-shape registry is quarantined the same way", () => {
    writeFileSync(registryPath(), JSON.stringify({ version: 9, sessions: {} }));
    expect(new Store().listSessions()).toEqual([]);
    expect(readdirSync(home).some((f) => f.startsWith("registry.json.corrupt-"))).toBe(true);
  });

  test("a legacy registry entry without kind decodes as a plan", () => {
    const now = "2026-07-14T00:00:00.000Z";
    writeFileSync(registryPath(), JSON.stringify({
      version: 1,
      sessions: {
        otc_legacy: {
          id: "otc_legacy",
          title: "legacy plan",
          repo,
          branch: "main",
          quick: false,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        },
      },
    }));
    const legacy = new Store().getSession("otc_legacy");
    expect(legacy?.kind).toBe("plan");
    expect(legacy?.socratic).toBe(false);
    expect(readdirSync(home).some((file) => file.startsWith("registry.json.corrupt-"))).toBe(false);
  });
});

describe("Store review lifecycle", () => {
  test("creates, reuses unchanged head, and revises changed head in one session", () => {
    const store = new Store();
    const created = store.startReviewSession({ repo, branch: "main", pullRequest: pullRequest() });
    expect(created.action).toBe("created");
    expect(created.session.kind).toBe("review");
    expect(created.session.status).toBe("working");
    expect(created.session.review.revision).toBe(1);
    expect(existsSync(join(sessionDir(created.session.id), "session.json"))).toBe(false);

    const reused = store.startReviewSession({ repo, branch: "main", pullRequest: pullRequest() });
    expect(reused.action).toBe("reused");
    expect(reused.session.id).toBe(created.session.id);
    expect(reused.session.updatedAt).toBe(created.session.updatedAt);

    store.updateSession(created.session.id, { status: "done" });
    const revised = store.startReviewSession({
      repo,
      branch: "main",
      pullRequest: pullRequest("b".repeat(40)),
    });
    expect(revised.action).toBe("revised");
    expect(revised.session.id).toBe(created.session.id);
    expect(revised.session.status).toBe("working");
    expect(revised.session.review.revision).toBe(2);
    expect(revised.session.review.head.sha).toBe("b".repeat(40));
  });

  test("force creates a second session for the same canonical PR", () => {
    const store = new Store();
    const first = store.startReviewSession({ repo, pullRequest: pullRequest() });
    const forced = store.startReviewSession({ repo, pullRequest: pullRequest(), force: true });
    expect(forced.action).toBe("created");
    expect(forced.session.id).not.toBe(first.session.id);
    expect(store.listSessions()).toHaveLength(2);
    expect(store.startReviewSession({ repo, pullRequest: pullRequest() }).session.id)
      .toBe(forced.session.id);
  });

  test("head refresh cannot change canonical PR identity", () => {
    const store = new Store();
    const created = store.startReviewSession({ repo, pullRequest: pullRequest() });
    const other = {
      ...pullRequest("b".repeat(40)),
      identity: pullRequestIdentity(project, 43),
      url: "https://github.com/acme/app/pull/43",
    };
    expect(() => store.refreshReviewHead(created.session.id, other)).toThrow(/identity/);
  });

  test("same-head refresh persists mutable PR metadata without advancing the head generation", () => {
    const store = new Store();
    const created = store.startReviewSession({ repo, pullRequest: pullRequest() });
    const fresh: PullRequestMetadata = {
      ...pullRequest(),
      title: "Renamed review",
      headRef: "renamed-feature",
      permissions: { maintainerCanModify: false, viewerPermission: "read", readOnly: true },
    };
    const refreshed = store.refreshReviewHead(created.session.id, fresh);
    expect(refreshed.review.revision).toBe(1);
    expect(refreshed.title).toBe("#42 Renamed review");
    expect(refreshed.review.head).toMatchObject({ sha: "a".repeat(40), ref: "renamed-feature" });
    expect(refreshed.review.pullRequest.permissions.readOnly).toBe(true);
    expect(new Store().getSession(created.session.id)).toMatchObject({
      review: { revision: 1, pullRequest: { title: "Renamed review", headRef: "renamed-feature" } },
    });
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

  test("a corrupt session.json is quarantined; revision recovers from snapshots", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    store.saveRevision(id, "# v1\n");
    store.saveRevision(id, "# v2\n");
    const statePath = join(sessionDir(id), "session.json");
    writeFileSync(statePath, "{nope");
    const state = store.readState(id);
    // revision comes back from r2.md — restarting at 0 would overwrite history
    expect(state.revision).toBe(2);
    expect(state.counters).toEqual({ batch: 0, thread: 0, question: 0, eventSeq: 0 });
    const names = readdirSync(sessionDir(id));
    expect(names.some((f) => f.startsWith("session.json.corrupt-"))).toBe(true);
    // the rebuilt state is persisted and keeps working
    expect(JSON.parse(readFileSync(statePath, "utf8")).revision).toBe(2);
    expect(store.bumpCounter(id, "eventSeq")).toBe(1);
    expect(store.saveRevision(id, "# v3\n")).toBe(3);
  });

  test("wrong-shape and wrong-id session.json are quarantined too", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    const statePath = join(sessionDir(id), "session.json");
    writeFileSync(statePath, JSON.stringify({ id })); // missing revision + counters
    expect(store.readState(id).revision).toBe(0);
    writeFileSync(statePath, JSON.stringify({ id, revision: 0, counters: {} }));
    expect(store.bumpCounter(id, "eventSeq")).toBe(1);
    // a valid-shaped file for a different session is corruption as well
    writeFileSync(
      statePath,
      JSON.stringify({
        id: "otc_other1",
        revision: 5,
        counters: { batch: 9, thread: 9, question: 9, eventSeq: 9 },
      }),
    );
    expect(store.readState(id).id).toBe(id);
    expect(
      readdirSync(sessionDir(id)).filter((f) => f.startsWith("session.json.corrupt-")),
    ).toHaveLength(3);
  });

  test("a deleted session.json is rebuilt instead of wedging", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    store.saveRevision(id, "# v1\n");
    rmSync(join(sessionDir(id), "session.json"));
    expect(store.readState(id)).toEqual({
      id,
      revision: 1,
      lastReviewedRevision: 0,
      counters: { batch: 0, thread: 0, question: 0, eventSeq: 0 },
    });
  });

  test("saveRevision writes r<N>.md snapshots and bumps revision", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    expect(store.saveRevision(id, "# plan v1\n")).toBe(1);
    expect(store.saveRevision(id, "# plan v2\n")).toBe(2);
    expect(existsSync(join(sessionDir(id), "r1.md"))).toBe(true);
    expect(store.readRevision(id, 1)).toBe("# plan v1\n");
    expect(store.readRevision(id, 2)).toBe("# plan v2\n");
    expect(store.readState(id).revision).toBe(2);
    // Round-trip: a fresh Store continues the numbering from disk.
    expect(new Store().saveRevision(id, "# plan v3\n")).toBe(3);
  });

  test("saveRevision persists the warnings it was accepted with; absent reads as []", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    const warning = {
      rule: "L6" as const,
      code: "W_DETAILS_SOFT_CAP",
      severity: "warning" as const,
      message: "Phase 1 Details is 94 lines (soft cap 80)",
      section: "phase-1",
      actual: 94,
      budget: 80,
    };
    store.saveRevision(id, "# v1\n", [warning]);
    store.saveRevision(id, "# v2\n"); // default: no warnings
    expect(store.readRevisionWarnings(id, 1)).toEqual([warning]);
    expect(store.readRevisionWarnings(id, 2)).toEqual([]);
    // A corrupt warnings file degrades to [] — badges are presentation metadata.
    writeFileSync(join(sessionDir(id), "r1.warnings.json"), "{nope");
    expect(store.readRevisionWarnings(id, 1)).toEqual([]);
  });
});

describe("Store pendingApproval (comment & approve)", () => {
  test("set/clear round-trips on disk and survives a fresh Store", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    expect(store.readState(id).pendingApproval).toBeUndefined();

    store.setPendingApproval(id, { implement: true, threads: ["t1", "t3"] });
    expect(store.readState(id).pendingApproval).toEqual({ implement: true, threads: ["t1", "t3"] });
    // A restart still sees the armed defer (it persists on session.json).
    expect(new Store().readState(id).pendingApproval).toEqual({
      implement: true,
      threads: ["t1", "t3"],
    });

    store.clearPendingApproval(id);
    expect(store.readState(id).pendingApproval).toBeUndefined();
    expect(new Store().readState(id).pendingApproval).toBeUndefined();
  });

  test("setPendingApproval leaves the counters and revision intact", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    store.saveRevision(id, "# v1\n");
    store.bumpCounters(id, { thread: 2, batch: 1, eventSeq: 1 });
    store.setPendingApproval(id, { implement: false, threads: ["t2"] });
    const state = store.readState(id);
    expect(state.revision).toBe(1);
    expect(state.counters).toEqual({ batch: 1, thread: 2, question: 0, eventSeq: 1 });
    expect(state.pendingApproval).toEqual({ implement: false, threads: ["t2"] });
  });

  test("clearPendingApproval is a no-op when nothing is armed", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    expect(() => store.clearPendingApproval(id)).not.toThrow();
    expect(store.readState(id).pendingApproval).toBeUndefined();
  });

  test("a malformed pendingApproval is dropped, not flowed through", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    const statePath = join(sessionDir(id), "session.json");
    // implement must be a boolean and threads a string[]; a wrong shape is
    // dropped (defaulting beats quarantining a recoverable, valid-otherwise file).
    writeFileSync(
      statePath,
      JSON.stringify({
        id,
        revision: 0,
        lastReviewedRevision: 0,
        counters: { batch: 0, thread: 0, question: 0, eventSeq: 0 },
        pendingApproval: { implement: "yes", threads: [1, 2] },
      }),
    );
    expect(store.readState(id).pendingApproval).toBeUndefined();
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

describe("markReviewed and changelog persistence (M3)", () => {
  test("markReviewed is monotonic and clamped to the current revision", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    store.saveRevision(id, "# v1\n");
    store.saveRevision(id, "# v2\n");
    expect(store.markReviewed(id, 1)).toBe(1);
    expect(store.markReviewed(id, 2)).toBe(2);
    expect(store.markReviewed(id, 1)).toBe(2); // never moves backwards
    expect(store.markReviewed(id, 99)).toBe(2); // never beyond what exists
    // Persisted: a fresh Store sees it.
    expect(new Store().readState(id).lastReviewedRevision).toBe(2);
  });

  test("a pre-M3 session.json without lastReviewedRevision reads as 0, not corrupt", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    const statePath = join(sessionDir(id), "session.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    delete state.lastReviewedRevision;
    writeFileSync(statePath, JSON.stringify(state));
    expect(store.readState(id).lastReviewedRevision).toBe(0);
    expect(readdirSync(sessionDir(id)).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  test("a hand-edited lastReviewedRevision is clamped into 0..revision, not trusted", () => {
    // Out of range it would poison the diff endpoint's default baseline:
    // beyond the revision 400s a parameterless GET /diff, a non-integer 500s
    // via readRevision(1.5).
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    store.saveRevision(id, "# v1\n");
    store.saveRevision(id, "# v2\n");
    const statePath = join(sessionDir(id), "session.json");
    const tamper = (value: unknown): void => {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      state.lastReviewedRevision = value;
      writeFileSync(statePath, JSON.stringify(state));
    };
    tamper(99); // beyond what exists → clamp to the current revision
    expect(store.readState(id).lastReviewedRevision).toBe(2);
    tamper(1.5); // not an integer → restart at 0
    expect(store.readState(id).lastReviewedRevision).toBe(0);
    tamper(-3); // negative → restart at 0
    expect(store.readState(id).lastReviewedRevision).toBe(0);
    expect(readdirSync(sessionDir(id)).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  test("saveRevision stores the changelog; readRevisionChangelog returns null when none", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    store.saveRevision(id, "# v1\n");
    store.saveRevision(id, "# v2\n", [], "Tightened phase 1 per t1; dropped the cache idea.");
    expect(store.readRevisionChangelog(id, 1)).toBeNull();
    expect(store.readRevisionChangelog(id, 2)).toBe(
      "Tightened phase 1 per t1; dropped the cache idea.",
    );
    expect(existsSync(join(sessionDir(id), "r2.changelog.md"))).toBe(true);
    // Blank changelogs are not written.
    store.saveRevision(id, "# v3\n", [], "   ");
    expect(store.readRevisionChangelog(id, 3)).toBeNull();
  });
});

describe("counter recovery high-water scans threads and events (M3)", () => {
  test("rebuilt counters never re-mint ids present in threads.json or events.json", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    const dir = sessionDir(id);
    writeFileSync(
      join(dir, "threads.json"),
      JSON.stringify({
        version: 1,
        threads: [
          { id: "t3", kind: "comment", batch: "b2", anchor: null, body: "x", createdAt: "2026-06-13" },
          { id: "q2", kind: "question", anchor: null, body: "y", createdAt: "2026-06-13" },
        ],
      }),
    );
    writeFileSync(
      join(dir, "events.json"),
      JSON.stringify({
        version: 1,
        events: [
          {
            seq: 7,
            queuedAt: "2026-06-13",
            payload: {
              event: "comments",
              session: id,
              batch: "b4",
              items: [{ thread: "t5", anchor: null, body: "z" }],
            },
          },
          { seq: 8, queuedAt: "2026-06-13", payload: { event: "question", session: id, id: "q9", anchor: null, body: "w" } },
        ],
      }),
    );
    // Grill questions share the q counter — the transcript is scanned too (M4).
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        version: 1,
        entries: [{ id: "q12", question: "algo?", askedAt: "2026-06-13" }],
      }),
    );
    writeFileSync(join(dir, "session.json"), "{nope");
    expect(store.readState(id).counters).toEqual({
      batch: 4,
      thread: 5,
      question: 12,
      eventSeq: 8,
    });
    // The next minted ids are fresh: t6 / q13 / b5.
    expect(store.bumpCounters(id, { thread: 1, question: 1, batch: 1 })).toMatchObject({
      thread: 6,
      question: 13,
      batch: 5,
    });
  });

  test("corrupt or missing scan sources degrade to zeros, never throw", () => {
    const store = new Store();
    const { id } = store.createSession({ title: "t", repo });
    const dir = sessionDir(id);
    writeFileSync(join(dir, "threads.json"), "{nope");
    writeFileSync(join(dir, "events.json"), JSON.stringify({ version: 1, events: "x" }));
    writeFileSync(join(dir, "session.json"), "{nope");
    expect(store.readState(id).counters).toEqual({
      batch: 0,
      thread: 0,
      question: 0,
      eventSeq: 0,
    });
  });
});
