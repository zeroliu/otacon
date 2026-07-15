import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  eventsPath,
  globalConfigPath,
  homeSessionDir,
  projectKnowledgePath,
  otaconPort,
  repoConfigPath,
  repoLocalConfigPath,
  reviewEventSeqPath,
  reviewRevisionQuizStatePath,
  reviewRevisionQuizPath,
  reviewRevisionReportPath,
  revisionPath,
  sessionDir,
  sessionStatePath,
  threadsPath,
} from "../shared/paths.js";
import { canonicalizeGitHubRepo, defaultKnowledgeMarkdown } from "../shared/knowledge.js";
import type { CanonicalGitHubRepo } from "../shared/knowledge.js";
import { pullRequestIdentity } from "../shared/review.js";
import type { PullRequestMetadata } from "../shared/review.js";
import type { RegistrySession } from "../shared/types.js";
import { VERSION } from "../shared/version.js";
import type { NodeBindings } from "./app.js";
import { createApp } from "./app.js";
import type { DesktopNotification } from "./desktop-notify.js";
import { Presence } from "./presence.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { ReviewQuizConflictError, ReviewQuizStore } from "./review-quiz-store.js";
import { ReviewStore } from "./review-store.js";
import { createReviewThread, requestReviewCodeAction } from "./review-threads.js";
import { Store } from "./store.js";
import { Viewers } from "./viewers.js";

let home: string;
let repo: string;
let uiDir: string;
let savedHome: string | undefined;
let store: Store;
let app: Hono<{ Bindings: NodeBindings }>;
let shutdowns: number;
// A recorder notify sink for the shared app. Every createApp call in this file
// injects a notify (this recorder, or a no-op sink in helpers that don't assert
// on notifications), so the real macOS notifier never fires a banner during
// `bun test` on the dev Mac. The desktop-notify suite covers the real tool
// selection.
let notifyCalls: DesktopNotification[];
let presence: Presence;
// The live-tab tracker (open-tab reuse) on a hand-cranked clock + short TTL, so
// the heartbeat tests drive expiry deterministically instead of waiting 90s.
let viewers: Viewers;
let viewerNow: number;
const VIEWER_TTL = 1_000;
const reviewRepo = "acme/app" as CanonicalGitHubRepo;

function reviewMetadata(headSha = "a".repeat(40), number = 42): PullRequestMetadata {
  return {
    identity: pullRequestIdentity(reviewRepo, number),
    url: `https://github.com/acme/app/pull/${number}`,
    title: "Typed review sessions",
    author: "octo",
    baseRef: "main",
    headRef: "feature",
    headRepository: reviewRepo,
    headSha,
    state: "open",
    isCrossRepository: false,
    permissions: { maintainerCanModify: true, viewerPermission: "write", readOnly: false },
  };
}

beforeEach(() => {
  savedHome = process.env.OTACON_HOME;
  home = mkdtempSync(join(tmpdir(), "otacon-home-"));
  repo = mkdtempSync(join(tmpdir(), "otacon-repo-"));
  // A fake built SPA, so tests never depend on whether dist/ui exists.
  uiDir = mkdtempSync(join(tmpdir(), "otacon-ui-"));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><div id=\"root\"></div>\n");
  mkdirSync(join(uiDir, "assets"));
  writeFileSync(join(uiDir, "assets", "app-abc123.js"), "console.log(\"shell\");\n");
  process.env.OTACON_HOME = home;
  store = new Store();
  shutdowns = 0;
  notifyCalls = [];
  presence = new Presence();
  viewerNow = 10_000;
  viewers = new Viewers(() => viewerNow, VIEWER_TTL);
  app = createApp({
    store,
    onShutdown: () => (shutdowns += 1),
    uiDir,
    notify: (n) => notifyCalls.push(n),
    presence,
    viewers,
  });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(uiDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Capture process.stderr.write across an async body, then restore it. Returns the joined output. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const orig = process.stderr.write;
  let captured = "";
  process.stderr.write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return captured;
}

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

function validReviewReport(id: string, revision: number, snapshot: string, head = "a".repeat(40)): string {
  const group = (layer: string, title: string) => `### ${layer} — ${title}

**Purpose:** Explain why this boundary belongs in the reader's causal path.
**Changed behavior:** Calls now preserve the frozen value instead of mutable state.
**Surfaces:** \`src/example.ts#${title.replaceAll(" ", "")}\`

This paragraph explains the handoff.`;
  return `---
type: otacon-pr-review
version: 1
session: ${id}
revision: ${revision}
pr: github.com/acme/app#42
head: ${head}
knowledge-snapshot: ${snapshot}
altitude: balanced
---

## Background

The old input could move while the report was open.
That made the explanation impossible to reproduce.

## Intuition

The snapshot is a labeled photograph of reader knowledge.
A later report can take another photograph.

## Code

Read the contract before runtime wiring.

${group("Interface changes", "Snapshot contract")}

${group("Integration path", "Capture handoff")}

${group("Implementation walkthrough", "Atomic commit")}

## Quiz

Structured cards render at this stable insertion point.
`;
}

function validReviewQuiz(id: string, revision: number, head = "a".repeat(40), headRevision = 1): string {
  return JSON.stringify({
    version: 1,
    session: id,
    revision,
    headRevision,
    headSha: head,
    questions: [{
      id: "q1",
      concept: { id: "snapshot-boundary", label: "Snapshot boundary", scope: "project" },
      prompt: "Why is the snapshot immutable?",
      mode: "open",
      rubric: { criteria: ["Connects stable input to reproducible explanation"] },
    }],
  });
}

function validReviewChoiceQuiz(id: string, revision: number, head = "a".repeat(40), headRevision = 1): string {
  return JSON.stringify({
    version: 1,
    session: id,
    revision,
    headRevision,
    headSha: head,
    questions: [{
      id: "q1",
      concept: { id: "snapshot-boundary", label: "Snapshot boundary", scope: "project" },
      prompt: "Which input keeps the explanation reproducible?",
      mode: "choice",
      rubric: { criteria: ["Identifies the immutable snapshot"] },
      options: ["Immutable snapshot", "Mutable profile"],
      answerKey: "Immutable snapshot",
    }],
  });
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
  return (JSON.parse(readFileSync(eventsPath(id), "utf8")) as { events: unknown[] }).events;
}

describe("health and shutdown", () => {
  test("GET /api/health reports app, version, pid, and viewers", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      app: "otacond",
      version: VERSION,
      pid: process.pid,
      viewers: 0,
    });
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

describe("knowledge API", () => {
  const projectRepo = canonicalizeGitHubRepo("acme/app");
  if (projectRepo === undefined) throw new Error("fixture repository should canonicalize");

  async function putKnowledge(body: unknown): Promise<Response> {
    return app.request("/api/knowledge", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("GET returns a no-history baseline without writing a personal file", async () => {
    const res = await app.request("/api/knowledge?scope=project&repo=ACME%2FApp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { document: { repo: string; markdown: string; hash: string } };
    expect(body.document.repo).toBe("acme/app");
    expect(body.document.markdown).toBe(defaultKnowledgeMarkdown({ scope: "project", repo: projectRepo }));
    expect(body.document.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(projectKnowledgePath(projectRepo))).toBe(false);
    expect(existsSync(join(repo, ".otacon"))).toBe(false);
  });

  test("canonical clone spellings address the same project document", async () => {
    const first = await app.request(
      "/api/knowledge?scope=project&repo=https%3A%2F%2Fgithub.com%2FAcme%2FApp.git",
    );
    const second = await app.request(
      "/api/knowledge?scope=project&repo=git%40github.com%3Aacme%2Fapp.git",
    );
    const a = (await first.json()) as { document: { path: string; hash: string } };
    const b = (await second.json()) as { document: { path: string; hash: string } };
    expect(a.document).toEqual(b.document);
  });

  test("a stale PUT returns current disk text and does not overwrite it", async () => {
    const loaded = await app.request("/api/knowledge?scope=project&repo=acme%2Fapp");
    const baseline = (await loaded.json()) as { document: { markdown: string; hash: string } };
    const firstText = baseline.document.markdown.replace("- None yet.", "- Understands CAS.");
    const first = await putKnowledge({
      scope: "project",
      repo: "acme/app",
      markdown: firstText,
      baseHash: baseline.document.hash,
    });
    expect(first.status).toBe(200);

    const staleText = baseline.document.markdown.replace("- None yet.", "- My unsaved draft.");
    const stale = await putKnowledge({
      scope: "project",
      repo: "acme/app",
      markdown: staleText,
      baseHash: baseline.document.hash,
    });
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as {
      error: { code: string };
      document: { markdown: string };
    };
    expect(conflict.error.code).toBe("E_KNOWLEDGE_CONFLICT");
    expect(conflict.document.markdown).toContain("Understands CAS");
    expect(conflict.document.markdown).not.toContain("My unsaved draft");
  });

  test("invalid scope, repository, hash, and Markdown write nothing", async () => {
    expect((await app.request("/api/knowledge?scope=project&repo=gitlab.com%2Facme%2Fapp")).status).toBe(400);
    expect((await app.request("/api/knowledge?scope=nope")).status).toBe(400);
    expect((await putKnowledge({ scope: "project", repo: "acme/app", markdown: "# Bad\n", baseHash: "nope" })).status).toBe(400);

    const loaded = await app.request("/api/knowledge?scope=project&repo=acme%2Fapp");
    const { document } = (await loaded.json()) as { document: { hash: string } };
    const invalid = await putKnowledge({
      scope: "project",
      repo: "acme/app",
      markdown: "# Missing standard sections\n",
      baseHash: document.hash,
    });
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe("E_INVALID_KNOWLEDGE");
    expect(existsSync(projectKnowledgePath(projectRepo))).toBe(false);
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

  test("a fresh session writes its state under OTACON_HOME/sessions/<id>/, not the repo", async () => {
    // Regression for confine-otacon-dir-to-config-and-plans: working state moved
    // out of <repo>/.otacon/ into the home store. A brand-new session creates its
    // session.json + events.json under ~/.otacon/sessions/<id>/ and touches
    // nothing under <repo>/.otacon/ (which holds config + plans only).
    const res = await postJson("/api/sessions", { title: "fresh", repo });
    expect(res.status).toBe(201);
    const session = (await res.json()) as RegistrySession;
    const dir = homeSessionDir(session.id);
    expect(dir).toBe(join(home, "sessions", session.id));
    expect(existsSync(join(dir, "session.json"))).toBe(true);
    expect(existsSync(join(dir, "events.json"))).toBe(true);
    // Nothing new appeared under the repo's .otacon/ from creating the session.
    expect(existsSync(join(repo, ".otacon", session.id))).toBe(false);
    expect(existsSync(join(repo, ".otacon"))).toBe(false);
  });

  test("POST /api/sessions rejects missing title and relative repo", async () => {
    expect((await postJson("/api/sessions", { repo })).status).toBe(400);
    const res = await postJson("/api/sessions", { title: "x", repo: "not/absolute" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("E_BAD_REQUEST");
  });

  test("POST /api/sessions persists an explicit socratic:true", async () => {
    const res = await postJson("/api/sessions", { title: "grill", repo, socratic: true });
    expect(res.status).toBe(201);
    const session = (await res.json()) as RegistrySession;
    expect(session.socratic).toBe(true);
    expect(store.getSession(session.id)?.socratic).toBe(true);
  });

  test("POST /api/sessions defaults socratic to false when omitted (no config)", async () => {
    const res = await postJson("/api/sessions", { title: "plain", repo });
    expect(res.status).toBe(201);
    const session = (await res.json()) as RegistrySession;
    expect(session.socratic).toBe(false);
  });

  test("an omitted socratic falls back to the repo's socratic.default config", async () => {
    mkdirSync(join(repo, ".otacon"), { recursive: true });
    writeFileSync(repoConfigPath(repo), JSON.stringify({ socratic: { default: true } }));
    const res = await postJson("/api/sessions", { title: "config-default", repo });
    expect(res.status).toBe(201);
    const session = (await res.json()) as RegistrySession;
    // The config default applies because the request omitted socratic.
    expect(session.socratic).toBe(true);
    expect(store.getSession(session.id)?.socratic).toBe(true);
  });

  test("an explicit socratic:false overrides a socratic.default:true config", async () => {
    mkdirSync(join(repo, ".otacon"), { recursive: true });
    writeFileSync(repoConfigPath(repo), JSON.stringify({ socratic: { default: true } }));
    const res = await postJson("/api/sessions", { title: "override", repo, socratic: false });
    expect(res.status).toBe(201);
    const session = (await res.json()) as RegistrySession;
    expect(session.socratic).toBe(false);
  });

  test("POST /api/sessions rejects a non-boolean socratic", async () => {
    const res = await postJson("/api/sessions", { title: "bad", repo, socratic: "yes" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("E_BAD_REQUEST");
  });

  test("POST /api/sessions rejects socratic + quick (mutually exclusive)", async () => {
    const res = await postJson("/api/sessions", {
      title: "contradiction",
      repo,
      quick: true,
      socratic: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("mutually exclusive");
  });

  test("POST /api/sessions persists a trimmed prompt and surfaces it on GET", async () => {
    const res = await postJson("/api/sessions", {
      title: "with prompt",
      repo,
      prompt: "  do the thing  ",
    });
    expect(res.status).toBe(201);
    const session = (await res.json()) as RegistrySession;
    expect(session.prompt).toBe("do the thing");
    expect(store.getSession(session.id)?.prompt).toBe("do the thing");
    const got = await app.request(`/api/sessions/${session.id}`);
    expect(((await got.json()) as RegistrySession).prompt).toBe("do the thing");
  });

  test("POST /api/sessions stores no prompt for a whitespace-only value", async () => {
    const res = await postJson("/api/sessions", { title: "blank prompt", repo, prompt: "   " });
    expect(res.status).toBe(201);
    const session = (await res.json()) as RegistrySession;
    expect("prompt" in session).toBe(false);
    expect("prompt" in (store.getSession(session.id) as RegistrySession)).toBe(false);
  });

  test("POST /api/sessions rejects a non-string prompt", async () => {
    const res = await postJson("/api/sessions", { title: "bad prompt", repo, prompt: 42 });
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

describe("review session identity and lifecycle", () => {
  const startReview = (overrides: Record<string, unknown> = {}) => postJson("/api/reviews", {
    repo,
    repository: reviewRepo,
    branch: "main",
    pullRequest: reviewMetadata(),
    ...overrides,
  });

  const submittedReview = async (): Promise<{ id: string; snapshot: string }> => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    expect((await postJson(`/api/reviews/${first.session.id}/submit`, {
      report: validReviewReport(first.session.id, 1, first.preparation.snapshot.hash),
      quiz: validReviewQuiz(first.session.id, 1),
    })).status).toBe(201);
    return { id: first.session.id, snapshot: first.preparation.snapshot.hash };
  };

  test("create and lookup use canonical PR identity without plan state", async () => {
    const created = await startReview();
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      action: string;
      session: { id: string; kind: string; review: { revision: number } };
      preparation: { revision: { revision: number }; snapshot: { hash: string } };
    };
    expect(body.action).toBe("created");
    expect(body.session.kind).toBe("review");
    expect(body.session.review.revision).toBe(1);
    expect(body.preparation.revision.revision).toBe(1);
    expect(body.preparation.snapshot.hash).toHaveLength(64);
    expect(existsSync(join(sessionDir(body.session.id), "session.json"))).toBe(false);

    const lookup = await app.request("/api/reviews?repo=ACME%2FAPP&number=42");
    expect(lookup.status).toBe(200);
    const found = (await lookup.json()) as { session: { id: string; revision: number } };
    expect(found.session.id).toBe(body.session.id);
    expect(found.session.revision).toBe(0);
  });

  test("unchanged active head reuses; changed active head revises the same session", async () => {
    const created = await startReview();
    const first = (await created.json()) as { session: { id: string } };
    const reused = await startReview();
    expect(reused.status).toBe(200);
    expect(((await reused.json()) as { action: string }).action).toBe("reused");

    const revised = await startReview({ pullRequest: reviewMetadata("b".repeat(40)) });
    expect(revised.status).toBe(200);
    const body = (await revised.json()) as {
      action: string;
      session: { id: string; status: string; review: { revision: number; head: { sha: string } } };
    };
    expect(body.action).toBe("revised");
    expect(body.session.id).toBe(first.session.id);
    expect(body.session.status).toBe("working");
    expect(body.session.review.revision).toBe(2);
    expect(body.session.review.head.sha).toBe("b".repeat(40));
  });

  test("Done warns with public unresolved counts, then force-closes without rewriting history", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const id = first.session.id;
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 1, first.preparation.snapshot.hash),
      quiz: validReviewQuiz(id, 1),
    })).status).toBe(201);
    expect((await postJson(`/api/reviews/${id}/threads`, {
      intent: "question",
      anchor: { section: "background", exact: "The old input could move while the report was open." },
      body: "Why is movement harmful?",
      reportRevision: 1,
      headRevision: 1,
      headSha: "a".repeat(40),
      idempotencyKey: "done-question",
    })).status).toBe(201);
    const before = {
      report: readFileSync(reviewRevisionReportPath(id, 1), "utf8"),
      quiz: readFileSync(reviewRevisionQuizPath(id, 1), "utf8"),
      threads: readFileSync(threadsPath(id), "utf8"),
    };

    const warned = await postJson(`/api/reviews/${id}/done`, {});
    expect(warned.status).toBe(409);
    expect((await warned.json()) as unknown).toMatchObject({
      error: { code: "E_REVIEW_INCOMPLETE" },
      warning: { unresolved: { conversations: 1, quizzes: 1 } },
    });
    expect(store.getSession(id)?.status).toBe("reviewing");

    const closed = await postJson(`/api/reviews/${id}/done`, { force: true });
    expect(closed.status).toBe(200);
    const body = (await closed.json()) as {
      session: { status: string; pendingEvents: number };
      completion: { forced: boolean; unresolved: { conversations: number; quizzes: number }; wake: string };
    };
    expect(body.session).toMatchObject({ status: "done", pendingEvents: 0 });
    expect(body.completion).toMatchObject({
      forced: true,
      unresolved: { conversations: 1, quizzes: 1 },
      wake: "queued",
    });
    expect(readFileSync(reviewRevisionReportPath(id, 1), "utf8")).toBe(before.report);
    expect(readFileSync(reviewRevisionQuizPath(id, 1), "utf8")).toBe(before.quiz);
    expect(readFileSync(threadsPath(id), "utf8")).toBe(before.threads);
  });

  test("clean Done wakes a parked reviewer once and repeated Done is idempotent", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const id = first.session.id;
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 1, first.preparation.snapshot.hash),
      quiz: validReviewChoiceQuiz(id, 1),
    })).status).toBe(201);
    expect((await postJson(`/api/reviews/${id}/quiz/q1/answer`, {
      revision: 1,
      answer: "Immutable snapshot",
      idempotencyKey: "done-pass",
    })).status).toBe(201);

    const parked = app.request(`/api/sessions/${id}/events?wait=1`);
    await sleep(10);
    const closed = await postJson(`/api/reviews/${id}/done`, {});
    expect(closed.status).toBe(200);
    const wake = (await (await parked).json()) as { event: string; completion: { forced: boolean } };
    expect(wake).toMatchObject({ event: "review-done", completion: { forced: false } });

    const repeated = await postJson(`/api/reviews/${id}/done`, {});
    expect(repeated.status).toBe(200);
    expect((await repeated.json()) as unknown).toMatchObject({ repeated: true });
    expect(await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()).toEqual({ event: "timeout" });
    expect(() => new Store()).not.toThrow();
  });

  test("completion records an explicit force choice even when unresolved counts are zero", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const id = first.session.id;
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 1, first.preparation.snapshot.hash),
      quiz: validReviewChoiceQuiz(id, 1),
    })).status).toBe(201);
    expect((await postJson(`/api/reviews/${id}/quiz/q1/answer`, {
      revision: 1,
      answer: "Immutable snapshot",
      idempotencyKey: "done-explicit-force-pass",
    })).status).toBe(201);

    const closed = await postJson(`/api/reviews/${id}/done`, { force: true });
    expect(closed.status).toBe(200);
    expect((await closed.json()) as unknown).toMatchObject({
      completion: { forced: true, unresolved: { conversations: 0, quizzes: 0 } },
    });
  });

  test("concurrent Done requests commit one completion and one terminal wake", async () => {
    const { id } = await submittedReview();

    const [first, second] = await Promise.all([
      postJson(`/api/reviews/${id}/done`, { force: true }),
      postJson(`/api/reviews/${id}/done`, { force: true }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const repeated = [await first.json(), await second.json()] as Array<{ repeated: boolean }>;
    expect(repeated.map((body) => body.repeated).sort()).toEqual([false, true]);

    const completed = store.getSession(id);
    expect(completed?.kind).toBe("review");
    if (completed?.kind !== "review") throw new Error("expected review session");
    expect(completed.review.completions).toHaveLength(1);
    expect((await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()) as unknown)
      .toMatchObject({ event: "review-done", session: id });
    expect(await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()).toEqual({ event: "timeout" });
  });

  test("completed reviews reuse unchanged heads and reopen changed heads with stale old quizzes", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const id = first.session.id;
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 1, first.preparation.snapshot.hash),
      quiz: validReviewQuiz(id, 1),
    })).status).toBe(201);
    expect((await postJson(`/api/reviews/${id}/done`, { force: true })).status).toBe(200);

    const unchanged = await startReview();
    expect(unchanged.status).toBe(200);
    expect((await unchanged.json()) as unknown).toMatchObject({
      action: "reused-complete",
      session: { id, status: "done" },
    });

    const changed = await startReview({ pullRequest: reviewMetadata("b".repeat(40)) });
    expect(changed.status).toBe(200);
    const reopened = (await changed.json()) as {
      action: string;
      session: { id: string; status: string; review: { revision: number; completions: unknown[] } };
      preparation: { revision: { revision: number } };
    };
    expect(reopened).toMatchObject({
      action: "reopened-changed",
      session: { id, status: "working", review: { revision: 2 } },
      preparation: { revision: { revision: 2 } },
    });
    expect(reopened.session.review.completions).toHaveLength(1);
    const old = await app.request(`/api/reviews/${id}/revisions/1`);
    expect(old.status).toBe(200);
    expect((await old.json()) as unknown).toMatchObject({ revision: { quiz: { stale: true } } });
  });

  test("restart after a changed-head reopen drops stale Done and ignores old-head unresolved history", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const id = first.session.id;
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 1, first.preparation.snapshot.hash),
      quiz: validReviewChoiceQuiz(id, 1),
    })).status).toBe(201);
    expect((await postJson(`/api/reviews/${id}/threads`, {
      intent: "question",
      anchor: { section: "background", exact: "The old input could move while the report was open." },
      body: "Why is movement harmful?",
      reportRevision: 1,
      headRevision: 1,
      headSha: "a".repeat(40),
      idempotencyKey: "old-head-question",
    })).status).toBe(201);
    expect((await postJson(`/api/reviews/${id}/done`, { force: true })).status).toBe(200);

    // Mimic a crash after the registry head commit but before the route can
    // prune the old terminal wake from this session's durable queue.
    store.refreshReviewHead(id, reviewMetadata("b".repeat(40)));
    store = new Store();
    app = createApp({ store, uiDir, notify: () => {}, presence, viewers });
    expect(await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()).toEqual({ event: "timeout" });

    const reused = await startReview({ pullRequest: reviewMetadata("b".repeat(40)) });
    const reopened = (await reused.json()) as { preparation: { revision: { revision: number }; snapshot: { hash: string } } };
    expect(reopened.preparation.revision.revision).toBe(2);
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 2, reopened.preparation.snapshot.hash, "b".repeat(40)),
      quiz: validReviewChoiceQuiz(id, 2, "b".repeat(40), 2),
    })).status).toBe(201);
    expect((await postJson(`/api/reviews/${id}/quiz/q1/answer`, {
      revision: 2,
      answer: "Immutable snapshot",
      idempotencyKey: "new-head-pass",
    })).status).toBe(201);
    const finished = await postJson(`/api/reviews/${id}/done`, {});
    expect(finished.status).toBe(200);
    expect((await finished.json()) as unknown).toMatchObject({
      completion: { unresolved: { conversations: 0, quizzes: 0 } },
    });
    expect(readFileSync(threadsPath(id), "utf8").includes("old-head-question")).toBe(true);
  });

  test("restart preserves exactly one queued review-done wake", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const id = first.session.id;
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 1, first.preparation.snapshot.hash),
      quiz: validReviewQuiz(id, 1),
    })).status).toBe(201);
    expect((await postJson(`/api/reviews/${id}/done`, { force: true })).status).toBe(200);

    store = new Store();
    app = createApp({ store, uiDir, notify: () => {}, presence, viewers });
    expect((await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()) as unknown)
      .toMatchObject({ event: "review-done", session: id });
    expect(await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()).toEqual({ event: "timeout" });
  });

  test("restart repairs a completion persisted before its terminal wake", async () => {
    const { id } = await submittedReview();
    const current = store.getSession(id);
    if (current?.kind !== "review") throw new Error("expected review session");
    const eventSeq = store.bumpCounter(id, "eventSeq");
    store.completeReviewSession(id, {
      version: 1,
      session: id,
      completedAt: new Date().toISOString(),
      reportRevision: 1,
      headRevision: current.review.revision,
      headSha: current.review.head.sha,
      forced: true,
      unresolved: { conversations: 0, quizzes: 1 },
      eventSeq,
      wake: "pending",
    });

    store = new Store();
    app = createApp({ store, uiDir, notify: () => {}, presence, viewers });
    const repaired = store.getSession(id);
    expect(repaired?.kind).toBe("review");
    if (repaired?.kind !== "review") throw new Error("expected review session");
    expect(repaired.review.completions?.at(-1)?.wake).toBe("queued");
    expect((await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()) as unknown)
      .toMatchObject({ event: "review-done", session: id });
    expect(await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()).toEqual({ event: "timeout" });
  });

  test("force creates a separate session", async () => {
    const first = await startReview();
    const firstId = ((await first.json()) as { session: { id: string } }).session.id;
    const forced = await startReview({ force: true });
    expect(forced.status).toBe(201);
    expect(((await forced.json()) as { session: { id: string } }).session.id).not.toBe(firstId);
  });

  test("repo mismatch is rejected before creation", async () => {
    const mismatch = await startReview({ repository: "other/repo" });
    expect(mismatch.status).toBe(409);
    expect(((await mismatch.json()) as { error: { code: string } }).error.code).toBe("E_REPO_MISMATCH");
    expect(store.listSessions()).toEqual([]);
  });

  test("explicit head refresh preserves canonical identity", async () => {
    const created = await startReview();
    const id = ((await created.json()) as { session: { id: string } }).session.id;
    const refreshed = await postJson(`/api/reviews/${id}/head`, {
      pullRequest: reviewMetadata("c".repeat(40)),
    });
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { action: string }).action).toBe("revised");

    const changedIdentity = await postJson(`/api/reviews/${id}/head`, {
      pullRequest: reviewMetadata("d".repeat(40), 43),
    });
    expect(changedIdentity.status).toBe(409);
    expect(((await changedIdentity.json()) as { error: { code: string } }).error.code).toBe("E_REVIEW_IDENTITY");
  });

  test("review ids are rejected by plan-only routes before plan artifacts are written", async () => {
    const created = await startReview();
    const id = ((await created.json()) as { session: { id: string } }).session.id;

    const submit = await app.request(`/api/sessions/${id}/submit`, {
      method: "POST",
      body: validPlanFor(id),
    });
    const comments = await postJson(`/api/sessions/${id}/comments`, {
      items: [{ anchor: null, body: "change this" }],
    });

    expect(submit.status).toBe(400);
    expect(((await submit.json()) as { error: { code: string } }).error.code).toBe("E_SESSION_KIND");
    expect(comments.status).toBe(400);
    expect(((await comments.json()) as { error: { code: string } }).error.code).toBe("E_SESSION_KIND");
    expect(existsSync(sessionStatePath(id))).toBe(false);
    expect(existsSync(threadsPath(id))).toBe(false);
  });

  test("review ids keep the generic session SSE snapshot used by SessionScreen", async () => {
    const created = await startReview();
    const id = ((await created.json()) as { session: { id: string } }).session.id;
    const response = await app.request(`/api/sessions/${id}/stream`);
    expect(response.status).toBe(200);
    const reader = sseReader(response);
    const snapshot = await reader.next();
    expect(snapshot.event).toBe("snapshot");
    expect(snapshot.data).toMatchObject({
      session: { id, kind: "review", revision: 0, status: "working" },
      threads: [],
      transcript: [],
      activity: [],
      stream: [],
    });
    await reader.cancel();
    expect(existsSync(sessionStatePath(id))).toBe(false);
  });

  test("submits immutable report revisions and exposes detail, revision, and diff endpoints", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { revision: { revision: number }; snapshot: { hash: string } };
    };
    const id = first.session.id;
    const submitted = await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 1, first.preparation.snapshot.hash),
      quiz: validReviewQuiz(id, 1),
    });
    expect(submitted.status).toBe(201);
    expect(((await submitted.json()) as { revision: { revision: { status: string } } }).revision.revision.status).toBe("submitted");

    const detail = await app.request(`/api/reviews/${id}`);
    const detailBody = (await detail.json()) as {
      session: { revision: number; review: { revision: number } };
      report: { report: string; snapshot: { user: { markdown: string }; project: { markdown: string } } };
    };
    expect(detailBody.session.revision).toBe(1);
    expect(detailBody.session.review.revision).toBe(1);
    expect(detailBody.report.report).toContain("## Background");
    expect(detailBody.report.snapshot.user.markdown).toContain("# User knowledge");
    expect(detailBody.report.snapshot.project.markdown).toContain("# Project knowledge");

    const next = await postJson(`/api/reviews/${id}/revisions`, {});
    const nextBody = (await next.json()) as { preparation: { revision: { revision: number }; snapshot: { hash: string } } };
    expect(nextBody.preparation.revision.revision).toBe(2);
    const second = await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 2, nextBody.preparation.snapshot.hash).replace("old input", "prior input"),
      quiz: validReviewQuiz(id, 2),
    });
    expect(second.status).toBe(201);
    expect((await app.request(`/api/reviews/${id}/revisions/1`)).status).toBe(200);
    const exactFirst = await app.request(`/api/reviews/${id}?revision=1`);
    expect(exactFirst.status).toBe(200);
    expect(((await exactFirst.json()) as { report: { revision: { revision: number } } }).report.revision.revision).toBe(1);
    const exactSecond = await app.request(`/api/reviews/${id}?revision=2`);
    expect(((await exactSecond.json()) as { report: { revision: { revision: number } } }).report.revision.revision).toBe(2);
    const diff = await app.request(`/api/reviews/${id}/diff?from=1&to=2`);
    expect(diff.status).toBe(200);
    expect(((await diff.json()) as { from: number; to: number }).from).toBe(1);
  });

  test("returns useful lint issues without publishing an invalid report", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const invalid = await postJson(`/api/reviews/${first.session.id}/submit`, {
      report: validReviewReport(first.session.id, 1, first.preparation.snapshot.hash)
        .replace("## Background", "## Intuition"),
      quiz: validReviewQuiz(first.session.id, 1),
    });
    expect(invalid.status).toBe(422);
    const body = (await invalid.json()) as { issues: Array<{ code: string }> };
    expect(body.issues.map((issue) => issue.code)).toContain("E_REPORT_SECTION_ORDER");
    expect((await app.request(`/api/reviews/${first.session.id}`)).status).toBe(200);
  });

  test("reports an unavailable prepared revision as a conflict instead of an internal error", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const unavailable = await postJson(`/api/reviews/${first.session.id}/submit`, {
      report: validReviewReport(first.session.id, 99, first.preparation.snapshot.hash),
      quiz: validReviewQuiz(first.session.id, 99),
    });
    expect(unavailable.status).toBe(409);
    expect((await unavailable.json()) as object).toMatchObject({
      error: { code: "E_REVIEW_REVISION_UNAVAILABLE" },
    });
  });

  test("returns a typed conflict when immutable report bytes are corrupt", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const id = first.session.id;
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 1, first.preparation.snapshot.hash),
      quiz: validReviewQuiz(id, 1),
    })).status).toBe(201);
    writeFileSync(reviewRevisionReportPath(id, 1), "corrupt\n");
    const corrupted = await app.request(`/api/reviews/${id}?revision=1`);
    expect(corrupted.status).toBe(409);
    expect((await corrupted.json()) as object).toMatchObject({
      error: { code: "E_REVIEW_REVISION_UNAVAILABLE" },
    });
  });

  test("keeps quiz secrets private while choice and open grading update live state", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const id = first.session.id;
    const privateQuiz = JSON.stringify({
      version: 1,
      session: id,
      revision: 1,
      headRevision: 1,
      headSha: "a".repeat(40),
      questions: [
        {
          id: "q-open",
          concept: { id: "boundary", label: "Boundary", scope: "project" },
          prompt: "Explain the handoff.",
          mode: "open",
          rubric: { criteria: ["SECRET_RUBRIC_SENTINEL"] },
        },
        {
          id: "q-choice",
          concept: { id: "mode", label: "Mode", scope: "user" },
          prompt: "Which mode wakes the agent?",
          mode: "choice",
          rubric: { criteria: ["Bounded response"] },
          options: ["choice", "open"],
          answerKey: "open",
        },
      ],
    });
    const submitted = await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 1, first.preparation.snapshot.hash),
      quiz: privateQuiz,
    });
    expect(submitted.status).toBe(201);
    expect(JSON.stringify(await submitted.json())).not.toContain("SECRET_RUBRIC_SENTINEL");
    const detailWire = JSON.stringify(await (await app.request(`/api/reviews/${id}`)).json());
    const revisionWire = JSON.stringify(await (await app.request(`/api/reviews/${id}/revisions/1`)).json());
    for (const wire of [detailWire, revisionWire]) {
      expect(wire).not.toContain("SECRET_RUBRIC_SENTINEL");
      expect(wire).not.toContain("answerKey");
      expect(wire).toContain("q-choice");
    }

    const choice = await postJson(`/api/reviews/${id}/quiz/q-choice/answer`, {
      revision: 1,
      answer: "open",
      idempotencyKey: "choice-1",
    });
    expect(choice.status).toBe(201);
    expect((await choice.json()) as object).toMatchObject({ attempt: { status: "pass" } });
    expect(((await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()) as { event: string }).event).toBe("timeout");

    const open = await postJson(`/api/reviews/${id}/quiz/q-open/answer`, {
      revision: 1,
      answer: "The daemon hands a sanitized projection to the UI.",
      idempotencyKey: "open-1",
    });
    expect(open.status).toBe(201);
    expect(readFileSync(reviewEventSeqPath(id), "utf8").trim()).toBe("1");
    const replayWhileQueued = await postJson(`/api/reviews/${id}/quiz/q-open/answer`, {
      revision: 1,
      answer: "The daemon hands a sanitized projection to the UI.",
      idempotencyKey: "open-1",
    });
    expect(replayWhileQueued.status).toBe(200);
    expect(eventsOnDisk(id)).toHaveLength(1);
    expect(readFileSync(reviewEventSeqPath(id), "utf8").trim()).toBe("1");
    const outgoing = fakeOutgoing();
    const deliveredInFlight = await app.request(`/api/sessions/${id}/events?wait=0`, {}, { outgoing });
    const privateEvent = (await deliveredInFlight.json()) as {
      event: string;
      revision: number;
      headRevision: number;
      headSha: string;
      question: string;
      attempt: string;
      rubric: { criteria: string[] };
      knowledge: { baseHash: string };
    };
    expect(privateEvent).toMatchObject({ event: "quiz-answer", rubric: { criteria: ["SECRET_RUBRIC_SENTINEL"] } });
    const replayWhileInFlight = await postJson(`/api/reviews/${id}/quiz/q-open/answer`, {
      revision: 1,
      answer: "The daemon hands a sanitized projection to the UI.",
      idempotencyKey: "open-1",
    });
    expect(replayWhileInFlight.status).toBe(200);
    expect(eventsOnDisk(id)).toHaveLength(1);
    expect(readFileSync(reviewEventSeqPath(id), "utf8").trim()).toBe("1");
    outgoing.writableFinished = true;
    outgoing.emit("close");
    expect(eventsOnDisk(id)).toEqual([]);
    const replayAfterAck = await postJson(`/api/reviews/${id}/quiz/q-open/answer`, {
      revision: 1,
      answer: "The daemon hands a sanitized projection to the UI.",
      idempotencyKey: "open-1",
    });
    expect(replayAfterAck.status).toBe(200);
    expect(eventsOnDisk(id)).toHaveLength(1);
    expect(readFileSync(reviewEventSeqPath(id), "utf8").trim()).toBe("2");
    expect((await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()) as object)
      .toMatchObject({ event: "quiz-answer", attempt: privateEvent.attempt });
    // Consuming the wake does not complete the cognition task.
    expect((await (await app.request(`/api/sessions/${id}`)).json()) as object).toMatchObject({ pendingEvents: 1 });

    const stream = sseReader(await app.request(`/api/sessions/${id}/stream`));
    const snapshot = await stream.next();
    const snapshotWire = JSON.stringify(snapshot.data);
    expect(snapshotWire).not.toContain("SECRET_RUBRIC_SENTINEL");
    expect(snapshotWire).not.toContain("knowledgeBaseHash");
    expect(snapshotWire).not.toContain("idempotencyKey");
    expect(snapshotWire).not.toContain("gradeStartedAt");
    expect(snapshotWire).not.toContain(privateEvent.knowledge.baseHash);
    expect((snapshot.data as { quiz: { questions: unknown[] } }).quiz.questions[0]).toMatchObject({ id: "q-open", status: "grading" });
    const grade = await postJson(`/api/reviews/${id}/quiz/q-open/grade`, {
      version: 1,
      session: id,
      revision: privateEvent.revision,
      headRevision: privateEvent.headRevision,
      headSha: privateEvent.headSha,
      question: privateEvent.question,
      attempt: privateEvent.attempt,
      verdict: "pass",
      feedback: "You named both sides of the handoff.",
      knowledgeBaseHash: privateEvent.knowledge.baseHash,
    });
    expect(grade.status).toBe(200);
    const quizFrame = await stream.next();
    expect(quizFrame.event).toBe("quiz");
    const quizWire = JSON.stringify(quizFrame.data);
    expect(quizWire).not.toContain("SECRET_RUBRIC_SENTINEL");
    expect(quizWire).not.toContain("knowledgeBaseHash");
    expect(quizWire).not.toContain("idempotencyKey");
    expect(quizWire).not.toContain("gradeStartedAt");
    expect((quizFrame.data as { quiz: { questions: unknown[] } }).quiz.questions[0]).toMatchObject({ id: "q-open", status: "passed" });
    expect((await (await app.request(`/api/sessions/${id}`)).json()) as object).toMatchObject({ pendingEvents: 0 });
    for (const wire of [
      JSON.stringify(await (await app.request(`/api/reviews/${id}`)).json()),
      JSON.stringify(await (await app.request(`/api/reviews/${id}/revisions/1`)).json()),
    ]) {
      expect(wire).not.toContain("knowledgeBaseHash");
      expect(wire).not.toContain("idempotencyKey");
      expect(wire).not.toContain("gradeStartedAt");
    }
    await stream.cancel();
  });

  test("keeps the session index and SSE alive when mutable quiz state is corrupt", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const id = first.session.id;
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 1, first.preparation.snapshot.hash),
      quiz: validReviewQuiz(id, 1),
    })).status).toBe(201);
    expect((await postJson(`/api/reviews/${id}/quiz/q1/answer`, {
      revision: 1,
      answer: "The daemon owns the boundary.",
      idempotencyKey: "corrupt-state",
    })).status).toBe(201);

    const path = reviewRevisionQuizStatePath(id, 1);
    writeFileSync(path, "{broken\n");
    writeFileSync(`${path}.backup`, "{also broken\n");

    const index = await app.request("/api/sessions");
    expect(index.status).toBe(200);
    expect(((await index.json()) as { sessions: Array<{ id: string }> }).sessions.map((item) => item.id)).toContain(id);
    const detailSummary = await app.request(`/api/sessions/${id}`);
    expect(detailSummary.status).toBe(200);
    expect((await detailSummary.json()) as object).toMatchObject({ id, pendingEvents: 0 });

    const stream = sseReader(await app.request(`/api/sessions/${id}/stream`));
    const snapshot = await stream.next();
    expect(snapshot.event).toBe("snapshot");
    expect(snapshot.data).not.toHaveProperty("quiz");
    await stream.cancel();

    const detail = await app.request(`/api/reviews/${id}`);
    expect(detail.status).toBe(409);
    expect((await detail.json()) as object).toMatchObject({
      error: { code: "E_REVIEW_REVISION_UNAVAILABLE" },
    });
  });

  test("repairs the durable-before-enqueue crash window once across daemon restarts", async () => {
    const created = await startReview();
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    const id = first.session.id;
    const quiz = JSON.stringify({
      version: 1,
      session: id,
      revision: 1,
      headRevision: 1,
      headSha: "a".repeat(40),
      questions: [
        {
          id: "q-open",
          concept: { id: "handoff", label: "Handoff", scope: "project" },
          prompt: "Explain the handoff.",
          mode: "open",
          rubric: { criteria: ["Names both sides"] },
        },
        {
          id: "q-choice",
          concept: { id: "mode", label: "Mode", scope: "user" },
          prompt: "Which answer wakes the agent?",
          mode: "choice",
          rubric: { criteria: ["Picks open"] },
          options: ["choice", "open"],
          answerKey: "open",
        },
      ],
    });
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 1, first.preparation.snapshot.hash),
      quiz,
    })).status).toBe(201);

    const knowledge = new KnowledgeStore();
    const reviews = new ReviewStore(knowledge);
    const quizzes = new ReviewQuizStore(reviews, knowledge);
    const session = store.getSession(id);
    if (session?.kind !== "review") throw new Error("fixture review disappeared");
    const pendingOpen = quizzes.answer(session, {
      revision: 1, question: "q-open", answer: "daemon to browser", idempotencyKey: "crash-open",
    });
    expect(pendingOpen.event?.event).toBe("quiz-answer");

    const originalReplace = knowledge.replace.bind(knowledge);
    knowledge.replace = ((target, _markdown, _baseHash) => ({ ok: false as const, current: knowledge.read(target) })) as KnowledgeStore["replace"];
    expect(() => quizzes.answer(session, {
      revision: 1, question: "q-choice", answer: "open", idempotencyKey: "crash-choice",
    })).toThrow(ReviewQuizConflictError);

    const conflictedApp = createApp({ store, knowledge, reviews, quizzes, uiDir, notify: () => {} });
    const conflict = await conflictedApp.request(`/api/reviews/${id}/quiz/q-choice/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, answer: "open", idempotencyKey: "crash-choice" }),
    });
    expect(conflict.status).toBe(409);
    const conflictWire = JSON.stringify(await conflict.json());
    expect(conflictWire).not.toContain("currentHash");
    expect(conflictWire).not.toMatch(/[a-f0-9]{64}/);

    knowledge.replace = originalReplace;
    const restartedStore = new Store();
    const restartedKnowledge = new KnowledgeStore();
    const restartedReviews = new ReviewStore(restartedKnowledge);
    const restartedQuizzes = new ReviewQuizStore(restartedReviews, restartedKnowledge);
    createApp({
      store: restartedStore,
      knowledge: restartedKnowledge,
      reviews: restartedReviews,
      quizzes: restartedQuizzes,
      uiDir,
      notify: () => {},
    });
    const restartedSession = restartedStore.getSession(id);
    if (restartedSession?.kind !== "review") throw new Error("restarted review disappeared");
    expect(restartedQuizzes.publicState(restartedSession, 1).questions.find((question) => question.id === "q-choice")?.status).toBe("passed");
    expect((JSON.parse(readFileSync(eventsPath(id), "utf8")) as { events: unknown[] }).events).toHaveLength(1);
    expect(readFileSync(reviewEventSeqPath(id), "utf8").trim()).toBe("1");

    const restartedAgain = createApp({ store: new Store(), uiDir, notify: () => {} });
    expect((JSON.parse(readFileSync(eventsPath(id), "utf8")) as { events: unknown[] }).events).toHaveLength(1);
    expect(readFileSync(reviewEventSeqPath(id), "utf8").trim()).toBe("1");
    const delivered = await restartedAgain.request(`/api/sessions/${id}/events?wait=0`);
    expect(delivered.status).toBe(200);
    expect((await delivered.json()) as object).toMatchObject({ event: "quiz-answer", question: "q-open" });
    expect(((await (await restartedAgain.request(`/api/sessions/${id}/events?wait=0`)).json()) as { event: string }).event).toBe("timeout");
  });

  test("persists anchored Ask/Comment threads before private work and sanitizes SSE", async () => {
    const { id } = await submittedReview();
    const stream = sseReader(await app.request(`/api/sessions/${id}/stream`));
    expect((await stream.next()).event).toBe("snapshot");
    const source = { reportRevision: 1, headRevision: 1, headSha: "a".repeat(40) };
    const anchor = {
      section: "background",
      exact: "The old input could move while the report was open.",
      prefix: "",
      suffix: " That made",
    };
    const created = await postJson(`/api/reviews/${id}/threads`, {
      intent: "question",
      anchor,
      body: "Why can it move?",
      ...source,
      idempotencyKey: "ask-create-1",
      rememberScope: "user",
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { thread: { id: string; anchor: unknown; saved?: unknown }; seq: number };
    expect(createdBody.thread).toMatchObject({ id: "q1", anchor, remember: { scope: "user" } });
    expect(createdBody.thread).not.toHaveProperty("idempotencyKey");
    expect(createdBody.thread).not.toHaveProperty("saved");
    expect(createdBody.seq).toBe(1);

    const frame = await stream.next();
    expect(frame.event).toBe("thread");
    expect(JSON.stringify(frame.data)).not.toContain("ask-create-1");
    expect(frame.data).toMatchObject({ thread: { id: "q1", anchor } });
    const event = (await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()) as object;
    expect(event).toMatchObject({
      event: "review-thread",
      work: "question",
      session: id,
      thread: "q1",
      ...source,
      anchor,
      remember: { scope: "user" },
    });

    const response = await postJson(`/api/reviews/${id}/threads/q1/respond`, {
      source,
      body: "The input was previously read live during rendering.",
      saved: { scope: "user", updated: true },
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      thread: {
        response: { body: "The input was previously read live during rendering." },
        saved: { scope: "user" },
      },
    });
    const replayAfterResponse = await postJson(`/api/reviews/${id}/threads`, {
      intent: "question",
      anchor,
      body: "Why can it move?",
      ...source,
      idempotencyKey: "ask-create-1",
      rememberScope: "user",
    });
    expect(replayAfterResponse.status).toBe(200);
    expect(eventsOnDisk(id)).toHaveLength(0);
    expect((await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()) as object)
      .toEqual({ event: "timeout" });
    expect((await (await app.request(`/api/sessions/${id}`)).json()) as object).toMatchObject({ pendingEvents: 0 });
    await stream.cancel();
  });

  test("Comment escalation is explicit/idempotent, Ask is refused, and report response names a real newer revision", async () => {
    const { id } = await submittedReview();
    const source = { reportRevision: 1, headRevision: 1, headSha: "a".repeat(40) };
    const create = await postJson(`/api/reviews/${id}/threads`, {
      intent: "comment",
      anchor: { section: "code", exact: "Read the contract before runtime wiring." },
      body: "Keep this boundary explicit.",
      ...source,
      idempotencyKey: "comment-create-1",
      rememberScope: "project",
    });
    expect(create.status).toBe(201);
    const createdThread = (await create.json()) as { thread: Record<string, unknown> };
    expect(createdThread).toMatchObject({ thread: { id: "t1" } });
    expect(createdThread.thread).not.toHaveProperty("codeAction");
    const replay = await postJson(`/api/reviews/${id}/threads`, {
      intent: "comment",
      anchor: { section: "code", exact: "Read the contract before runtime wiring." },
      body: "Keep this boundary explicit.",
      ...source,
      idempotencyKey: "comment-create-1",
      rememberScope: "project",
    });
    expect(replay.status).toBe(200);
    expect(eventsOnDisk(id)).toHaveLength(1);

    const action = await postJson(`/api/reviews/${id}/threads/t1/code-action`, { source });
    expect(action.status).toBe(202);
    expect((await action.json()) as object).toMatchObject({ thread: { codeAction: { status: "requested" } } });
    expect((await (await app.request(`/api/sessions/${id}`)).json()) as object).toMatchObject({ pendingEvents: 1 });
    expect((await postJson(`/api/reviews/${id}/threads/t1/code-action`, { source })).status).toBe(200);
    expect(eventsOnDisk(id)).toHaveLength(2);
    expect((await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()) as object)
      .toMatchObject({ event: "review-thread", work: "report-feedback", thread: "t1" });
    expect((await (await app.request(`/api/sessions/${id}/events?wait=0`)).json()) as object)
      .toMatchObject({ event: "review-thread", work: "code-change", thread: "t1" });

    expect((await postJson(`/api/reviews/${id}/threads/t1/respond`, {
      source, body: "changed", responseReportRevision: 2,
    })).status).toBe(409);
    const next = await postJson(`/api/reviews/${id}/revisions`, {});
    const preparation = (await next.json()) as { preparation: { snapshot: { hash: string } } };
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 2, preparation.preparation.snapshot.hash).replace("old input", "prior input"),
      quiz: validReviewQuiz(id, 2),
    })).status).toBe(201);
    const responded = await postJson(`/api/reviews/${id}/threads/t1/respond`, {
      source,
      body: "The report now makes the boundary explicit.",
      responseReportRevision: 2,
      saved: { scope: "project", updated: true },
    });
    expect(responded.status).toBe(200);
    expect((await responded.json()) as object).toMatchObject({
      thread: { response: { reportRevision: 2 }, saved: { scope: "project" } },
    });
    expect((await postJson(`/api/reviews/${id}/threads/t1/code-action/status`, {
      source,
      status: "completed",
      message: "pushed reviewed change",
    })).status).toBe(200);
    const terminalReplay = await postJson(`/api/reviews/${id}/threads/t1/code-action`, { source });
    expect(terminalReplay.status).toBe(200);
    expect(eventsOnDisk(id)).toHaveLength(0);

    const ask = await postJson(`/api/reviews/${id}/threads`, {
      intent: "question",
      anchor: { section: "code", exact: "Read the contract before runtime wiring." },
      body: "Why this order?",
      reportRevision: 2,
      headRevision: 1,
      headSha: "a".repeat(40),
      idempotencyKey: "ask-create-2",
    });
    expect(ask.status).toBe(201);
    const askId = ((await ask.json()) as { thread: { id: string } }).thread.id;
    expect((await postJson(`/api/reviews/${id}/threads/${askId}/code-action`, {
      source: { reportRevision: 2, headRevision: 1, headSha: "a".repeat(40) },
    })).status).toBe(409);
  });

  test("a responded Comment can still escalate when its immutable source report is older on the same PR head", async () => {
    const { id } = await submittedReview();
    const source = { reportRevision: 1, headRevision: 1, headSha: "a".repeat(40) };
    expect((await postJson(`/api/reviews/${id}/threads`, {
      intent: "comment",
      anchor: { section: "code", exact: "Read the contract before runtime wiring." },
      body: "Please make the boundary explicit.",
      ...source,
      idempotencyKey: "respond-then-change",
    })).status).toBe(201);
    await app.request(`/api/sessions/${id}/events?wait=0`);
    const next = await postJson(`/api/reviews/${id}/revisions`, {});
    const preparation = (await next.json()) as { preparation: { snapshot: { hash: string } } };
    expect((await postJson(`/api/reviews/${id}/submit`, {
      report: validReviewReport(id, 2, preparation.preparation.snapshot.hash),
      quiz: validReviewQuiz(id, 2),
    })).status).toBe(201);
    expect((await postJson(`/api/reviews/${id}/threads/t1/respond`, {
      source,
      body: "The report explanation is clearer in r2.",
      responseReportRevision: 2,
    })).status).toBe(200);
    const escalated = await postJson(`/api/reviews/${id}/threads/t1/code-action`, { source });
    expect(escalated.status).toBe(202);
    expect((await escalated.json()) as object).toMatchObject({ thread: { response: { reportRevision: 2 }, codeAction: { status: "requested" } } });
  });

  test("a fork Comment remains conversational but cannot enqueue code work", async () => {
    const pullRequest = {
      ...reviewMetadata(),
      headRepository: "contributor/app" as CanonicalGitHubRepo,
      isCrossRepository: true,
      permissions: { maintainerCanModify: true, viewerPermission: "write" as const, readOnly: true },
    };
    const created = await startReview({ pullRequest });
    const first = (await created.json()) as {
      session: { id: string };
      preparation: { snapshot: { hash: string } };
    };
    expect((await postJson(`/api/reviews/${first.session.id}/submit`, {
      report: validReviewReport(first.session.id, 1, first.preparation.snapshot.hash),
      quiz: validReviewQuiz(first.session.id, 1),
    })).status).toBe(201);
    const source = { reportRevision: 1, headRevision: 1, headSha: "a".repeat(40) };
    expect((await postJson(`/api/reviews/${first.session.id}/threads`, {
      intent: "comment",
      anchor: { section: "code", exact: "Read the contract before runtime wiring." },
      body: "Explain this boundary.",
      ...source,
      idempotencyKey: "fork-comment",
    })).status).toBe(201);
    const denied = await postJson(`/api/reviews/${first.session.id}/threads/t1/code-action`, { source });
    expect(denied.status).toBe(409);
    expect((await denied.json()) as object).toMatchObject({ error: { code: "E_REVIEW_READ_ONLY" } });
    expect(eventsOnDisk(first.session.id)).toHaveLength(1);
    expect((await (await app.request(`/api/sessions/${first.session.id}/threads`)).json()) as object)
      .toMatchObject({ threads: [{ id: "t1" }] });
    expect(JSON.stringify(await (await app.request(`/api/sessions/${first.session.id}/threads`)).json()))
      .not.toContain("codeAction");
  });

  test("generic plan thread endpoints reject a review without quarantining its v2 file", async () => {
    const { id } = await submittedReview();
    const source = { reportRevision: 1, headRevision: 1, headSha: "a".repeat(40) };
    expect((await postJson(`/api/reviews/${id}/threads`, {
      intent: "question",
      anchor: { section: "background", exact: "The old input could move while the report was open." },
      body: "Why?",
      ...source,
      idempotencyKey: "isolation-1",
    })).status).toBe(201);
    const before = readFileSync(threadsPath(id), "utf8");
    for (const response of [
      await postJson(`/api/sessions/${id}/questions`, { body: "plan question" }),
      await postJson(`/api/sessions/${id}/questions/q1/answer`, { body: "plan answer" }),
      await postJson(`/api/sessions/${id}/threads/q1/resolve`, { resolved: true }),
      await postJson(`/api/sessions/${id}/comments`, { items: [{ body: "plan comment", anchor: null }] }),
    ]) {
      expect(response.status).toBe(400);
      expect((await response.json()) as object).toMatchObject({ error: { code: "E_SESSION_KIND" } });
    }
    const listed = await app.request(`/api/sessions/${id}/threads`);
    const listedBody = await listed.json();
    expect({ status: listed.status, body: listedBody }).toMatchObject({ status: 200, body: { threads: [{ id: "q1", surface: "review" }] } });
    expect(readFileSync(threadsPath(id), "utf8")).toBe(before);
    expect(existsSync(`${threadsPath(id)}.corrupt-`)).toBe(false);
  });

  test("repairs persisted-before-enqueue review work once after restart", async () => {
    const { id } = await submittedReview();
    const session = store.getSession(id);
    if (session?.kind !== "review") throw new Error("review fixture disappeared");
    const thread = {
      id: "t1",
      surface: "review" as const,
      intent: "comment" as const,
      anchor: { section: "code", exact: "Read the contract before runtime wiring." },
      body: "Change this.",
      createdAt: "2026-07-15T10:00:00.000Z",
      identity: { session: id, reportRevision: 1, headRevision: 1, headSha: "a".repeat(40) },
      idempotencyKey: "crash-thread",
    };
    createReviewThread(threadsPath(id), thread);
    requestReviewCodeAction(threadsPath(id), "t1", "2026-07-15T10:01:00.000Z");
    expect(existsSync(eventsPath(id))).toBe(true);
    const restarted = createApp({ store: new Store(), uiDir, notify: () => {} });
    expect(eventsOnDisk(id)).toHaveLength(1);
    expect(eventsOnDisk(id)[0]).toMatchObject({ payload: { event: "review-thread", work: "code-change", thread: "t1" } });
    createApp({ store: new Store(), uiDir, notify: () => {} });
    expect(eventsOnDisk(id)).toHaveLength(1);
    expect((await (await restarted.request(`/api/sessions/${id}/events?wait=0`)).json()) as object)
      .toMatchObject({ event: "review-thread", work: "code-change", thread: "t1" });
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
    expect(existsSync(revisionPath(session.id, 1))).toBe(true);
    expect(store.getSession(session.id)?.status).toBe("in_review");
  });

  test("an unrenderable mermaid fence is a blocking L8 422; a fixed resubmit passes", async () => {
    const session = mintSession();
    // Start from the otherwise-valid fixture (passes every L1/L2/L3/L5 rule) and
    // swap only its mermaid fence body for a bogus diagram type. "notadiagram"
    // deterministically fails mermaid.parse ("No diagram type detected…"), so the
    // diagram is the ONLY error the submit can carry.
    const valid = validPlanFor(session.id);
    const broken = valid.replace("flowchart LR", "notadiagram");
    expect(broken).not.toBe(valid); // guard the fixture still has the fence

    const blocked = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: broken,
    });
    expect(blocked.status).toBe(422);
    const body = (await blocked.json()) as {
      ok: boolean;
      errors: { rule: string; code: string }[];
    };
    expect(body.ok).toBe(false);
    expect(
      body.errors.some((e) => e.rule === "L8" && e.code === "E_DIAGRAM_UNRENDERABLE"),
    ).toBe(true);
    // A blocked submit stores nothing and leaves the session untouched.
    expect(store.readState(session.id).revision).toBe(0);
    expect(store.getSession(session.id)?.status).toBe("draft");

    // The fix-and-resubmit loop: the valid plan (valid mermaid) now passes.
    const fixed = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: valid,
    });
    expect(fixed.status).toBe(200);
    expect((await fixed.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(store.getSession(session.id)?.status).toBe("in_review");
  });

  test("accepts a JSON body carrying the plan, for the CLI's resolutions rider", async () => {
    const session = mintSession();
    const res = await postJson(`/api/sessions/${session.id}/submit`, {
      plan: validPlanFor(session.id),
      resolutions: {},
    });
    expect(res.status).toBe(200);
  });

  test("a malformed resolutions shape is a 400, not a lint run", async () => {
    const session = mintSession();
    for (const resolutions of [
      { t1: "done" }, // pre-M3 flat map: unknown top-level key
      { threads: { t1: 7 } }, // reply must be a string
      { changelog: 7 },
      "done",
    ]) {
      const res = await postJson(`/api/sessions/${session.id}/submit`, {
        plan: validPlanFor(session.id),
        resolutions,
      });
      expect(res.status).toBe(400);
    }
  });

  test('a "__proto__" reply key surfaces as an unknown thread, never a silent drop', async () => {
    // JSON.parse creates it as an own key; a plain-object copy would eat the
    // assignment and the strict resolutions shape would leak a typo through.
    const session = mintSession();
    const res = await postJson(`/api/sessions/${session.id}/submit`, {
      plan: validPlanFor(session.id),
      resolutions: { threads: JSON.parse('{"__proto__": "x"}') as Record<string, string> },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { code: string; thread?: string }[] };
    expect(body.errors.some((e) => e.code === "E_UNKNOWN_THREAD" && e.thread === "__proto__")).toBe(true);
  });

  test("a resubmit with a stale frontmatter revision passes with a warning", async () => {
    const session = mintSession();
    const plan = validPlanFor(session.id);
    await app.request(`/api/sessions/${session.id}/submit`, { method: "POST", body: plan });
    const res = await postJson(`/api/sessions/${session.id}/submit`, {
      plan, // still says revision: 1; daemon is at 2 now
      resolutions: { changelog: "tightened phase 2" },
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

describe("comment follow-ups (a comment becomes a conversation)", () => {
  test("a follow-up links to the root, inherits its anchor/orphan, and the event carries replyTo", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ anchor: { section: "phase-1", exact: "RS256" }, body: "why RS256?" }], // t1
    });
    // Drain the root's comments event so the next /events returns the follow-up.
    await app.request(`/api/sessions/${session.id}/events`);

    const res = await postJson(`/api/sessions/${session.id}/comments`, {
      items: [
        {
          replyTo: "t1",
          anchor: { section: "decisions", exact: "ignored" }, // ignored on a follow-up
          body: "still unconvinced",
        },
      ],
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, batch: "b2", threads: ["t2"], seq: 2 });
    // A follow-up is still a revision request.
    expect(store.getSession(session.id)?.status).toBe("revising");

    const threads = (await (await app.request(`/api/sessions/${session.id}/threads`)).json()) as {
      threads: { id: string; replyTo?: string; anchor: unknown }[];
    };
    const followup = threads.threads.find((t) => t.id === "t2");
    expect(followup?.replyTo).toBe("t1");
    // Inherited the root's anchor; the client-sent anchor was ignored.
    expect(followup?.anchor).toEqual({ section: "phase-1", exact: "RS256" });

    const event = await app.request(`/api/sessions/${session.id}/events`);
    expect(await event.json()).toEqual({
      event: "comments",
      session: session.id,
      batch: "b2",
      items: [
        {
          thread: "t2",
          anchor: { section: "phase-1", exact: "RS256" },
          body: "still unconvinced",
          replyTo: "t1",
        },
      ],
    });
  });

  test("a follow-up on a follow-up collapses to the same root", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ anchor: null, body: "root" }] }); // t1
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ replyTo: "t1", body: "f1" }] }); // t2
    const res = await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ replyTo: "t2", body: "f2" }], // t3 follows t2, keys on root t1
    });
    expect(res.status).toBe(202);
    const threads = (await (await app.request(`/api/sessions/${session.id}/threads`)).json()) as {
      threads: { id: string; replyTo?: string }[];
    };
    expect(threads.threads.find((t) => t.id === "t3")?.replyTo).toBe("t1");
  });

  test("a batch may mix a new comment and a follow-up", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ anchor: { section: "phase-1", exact: "RS256" }, body: "root" }], // t1
    });
    const res = await postJson(`/api/sessions/${session.id}/comments`, {
      items: [
        { anchor: null, body: "a fresh nit" }, // t2: new root
        { replyTo: "t1", body: "and on the first one" }, // t3: follow-up of t1
      ],
    });
    expect(await res.json()).toEqual({ ok: true, batch: "b2", threads: ["t2", "t3"], seq: 2 });
    const threads = (await (await app.request(`/api/sessions/${session.id}/threads`)).json()) as {
      threads: { id: string; replyTo?: string; anchor: unknown }[];
    };
    const t2 = threads.threads.find((t) => t.id === "t2");
    const t3 = threads.threads.find((t) => t.id === "t3");
    expect(t2?.replyTo).toBeUndefined();
    expect(t2?.anchor).toBeNull();
    expect(t3?.replyTo).toBe("t1");
    expect(t3?.anchor).toEqual({ section: "phase-1", exact: "RS256" });
  });

  test("replyTo to an unknown or non-comment id is a 404 E_UNKNOWN_COMMENT, no id burned", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "c" }] }); // t1
    await postJson(`/api/sessions/${session.id}/questions`, { body: "q" }); // q1

    const unknown = await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ replyTo: "t9", body: "x" }],
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      "E_UNKNOWN_COMMENT",
    );
    // A question thread is not a comment — a comment follow-up can't link to it.
    const question = await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ replyTo: "q1", body: "x" }],
    });
    expect(question.status).toBe(404);
    const nonString = await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ replyTo: 7, body: "x" }],
    });
    expect(nonString.status).toBe(400);
    const empty = await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ replyTo: "", body: "x" }],
    });
    expect(empty.status).toBe(400);

    // A real root still mints the next id — no t was burned by the rejects.
    const ok = await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ replyTo: "t1", body: "real" }],
    });
    expect(((await ok.json()) as { threads: string[] }).threads).toEqual(["t2"]);
  });

  test("a finalizing session refuses a follow-up too (E_ALREADY_FINALIZING)", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/submit`, { plan: validPlanFor(session.id) });
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ anchor: null, body: "open" }] }); // t1
    await postJson(`/api/sessions/${session.id}/approve`, { sendOpenComments: true });
    await app.request(`/api/sessions/${session.id}/events`); // drain the final batch

    const res = await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ replyTo: "t1", body: "one more thought" }],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "E_ALREADY_FINALIZING",
    );
  });
});

describe("threads", () => {
  test("comments and questions persist threads, readable via GET /threads", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/comments`, {
      items: [
        { anchor: { section: "phase-1", exact: "RS256" }, body: "why not HS256?" },
        { anchor: null, body: "overall: too broad" },
      ],
    });
    await postJson(`/api/sessions/${session.id}/questions`, {
      anchor: { section: "decisions" },
      body: "what about refresh tokens?",
    });
    const res = await app.request(`/api/sessions/${session.id}/threads`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: string;
      threads: { id: string; kind: string; batch?: string; anchor: unknown; body: string }[];
    };
    expect(body.session).toBe(session.id);
    expect(body.threads.map((t) => [t.id, t.kind])).toEqual([
      ["t1", "comment"],
      ["t2", "comment"],
      ["q1", "question"],
    ]);
    expect(body.threads[0]).toMatchObject({
      batch: "b1",
      anchor: { section: "phase-1", exact: "RS256" },
      body: "why not HS256?",
    });
  });

  test("answering a question stores the answer and returns it on later reads", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/questions`, { body: "why?" });
    const res = await postJson(`/api/sessions/${session.id}/questions/q1/answer`, {
      body: "because of key rotation",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; question: string; answeredAt: string };
    expect(body.ok).toBe(true);
    expect(body.question).toBe("q1");
    expect(typeof body.answeredAt).toBe("string");
    // Status untouched — answers never flip the session (threaded review and revision).
    expect(store.getSession(session.id)?.status).toBe("draft");

    const threads = (await (await app.request(`/api/sessions/${session.id}/threads`)).json()) as {
      threads: { id: string; answer?: { body: string } }[];
    };
    expect(threads.threads[0]?.answer?.body).toBe("because of key rotation");
  });

  test("answer validation: unknown question, comment id, empty body", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "c" }] });
    await postJson(`/api/sessions/${session.id}/questions`, { body: "q" });

    const unknown = await postJson(`/api/sessions/${session.id}/questions/q9/answer`, { body: "x" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      "E_UNKNOWN_QUESTION",
    );
    // A comment thread is resolved by resubmit, never answered.
    const comment = await postJson(`/api/sessions/${session.id}/questions/t1/answer`, { body: "x" });
    expect(comment.status).toBe(404);
    const empty = await postJson(`/api/sessions/${session.id}/questions/q1/answer`, { body: "  " });
    expect(empty.status).toBe(400);
    const noSession = await postJson("/api/sessions/otc_zzzzzz/questions/q1/answer", { body: "x" });
    expect(noSession.status).toBe(404);
  });

  test("the per-session stream snapshots threads and pushes thread frames live", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/questions`, { body: "first?" });
    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    const snapshot = await reader.next();
    expect(snapshot.event).toBe("snapshot");
    const snapData = snapshot.data as { threads: { id: string }[] };
    expect(snapData.threads.map((t) => t.id)).toEqual(["q1"]);

    // The agent's answer lands as a thread frame — the "answering…" flip.
    await postJson(`/api/sessions/${session.id}/questions/q1/answer`, { body: "an answer" });
    const frame = await reader.next();
    expect(frame.event).toBe("thread");
    expect(frame.data).toMatchObject({
      session: session.id,
      thread: { id: "q1", kind: "question", answer: { body: "an answer" } },
    });
    await reader.cancel();
  });

  test("a follow-up links to the root, inherits its anchor, and the event carries replyTo", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/questions`, {
      anchor: { section: "phase-1", exact: "RS256" },
      body: "why RS256?",
    });
    // Drain the root's question event so the next /events returns the follow-up.
    await app.request(`/api/sessions/${session.id}/events`);

    const res = await postJson(`/api/sessions/${session.id}/questions`, {
      replyTo: "q1",
      anchor: { section: "decisions", exact: "ignored" }, // ignored on a follow-up
      body: "and key rotation?",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, id: "q2", seq: 2 });

    const threads = (await (await app.request(`/api/sessions/${session.id}/threads`)).json()) as {
      threads: { id: string; replyTo?: string; anchor: unknown }[];
    };
    const followup = threads.threads.find((t) => t.id === "q2");
    expect(followup?.replyTo).toBe("q1");
    // Inherited the root's anchor; the client-sent anchor was ignored.
    expect(followup?.anchor).toEqual({ section: "phase-1", exact: "RS256" });

    const event = await app.request(`/api/sessions/${session.id}/events`);
    expect(await event.json()).toEqual({
      event: "question",
      session: session.id,
      id: "q2",
      anchor: { section: "phase-1", exact: "RS256" },
      body: "and key rotation?",
      replyTo: "q1",
    });
  });

  test("a follow-up on a follow-up collapses to the same root", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/questions`, { anchor: null, body: "root" });
    await postJson(`/api/sessions/${session.id}/questions`, { replyTo: "q1", body: "f1" });
    const res = await postJson(`/api/sessions/${session.id}/questions`, { replyTo: "q2", body: "f2" });
    expect(res.status).toBe(202);
    const threads = (await (await app.request(`/api/sessions/${session.id}/threads`)).json()) as {
      threads: { id: string; replyTo?: string }[];
    };
    // q3 follows q2, but its replyTo points at the root q1 (one key per chain).
    expect(threads.threads.find((t) => t.id === "q3")?.replyTo).toBe("q1");
  });

  test("replyTo to an unknown or non-question id is a 404 E_UNKNOWN_QUESTION, no id burned", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "c" }] }); // t1
    await postJson(`/api/sessions/${session.id}/questions`, { body: "q" }); // q1

    const unknown = await postJson(`/api/sessions/${session.id}/questions`, { replyTo: "q9", body: "x" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      "E_UNKNOWN_QUESTION",
    );
    // A comment thread is not a question — a follow-up can't link to it.
    const comment = await postJson(`/api/sessions/${session.id}/questions`, { replyTo: "t1", body: "x" });
    expect(comment.status).toBe(404);
    const nonString = await postJson(`/api/sessions/${session.id}/questions`, { replyTo: 7, body: "x" });
    expect(nonString.status).toBe(400);
    // An empty id is a malformed request (400), not a missing question (404).
    const empty = await postJson(`/api/sessions/${session.id}/questions`, { replyTo: "", body: "x" });
    expect(empty.status).toBe(400);

    // A real root still mints the next id — no q was burned by the rejects.
    const ok = await postJson(`/api/sessions/${session.id}/questions`, { replyTo: "q1", body: "real" });
    expect(((await ok.json()) as { id: string }).id).toBe("q2");
  });
});

describe("the reviewer Resolve route (POST .../threads/:tid/resolve)", () => {
  const resolve = (id: string, tid: string, body: unknown) =>
    postJson(`/api/sessions/${id}/threads/${tid}/resolve`, body);

  test("a 202 + a `thread` SSE upsert carrying the reviewer close", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/submit`, { plan: validPlanFor(session.id) });
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "a nit" }] }); // t1
    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    await reader.next(); // snapshot

    const res = await resolve(session.id, "t1", { resolved: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });

    const frame = await reader.next();
    expect(frame.event).toBe("thread");
    expect(frame.data).toMatchObject({
      session: session.id,
      thread: { id: "t1", kind: "comment", resolved: { revision: 1 } },
    });

    // It's durable: the close is on disk.
    const threads = (await (await app.request(`/api/sessions/${session.id}/threads`)).json()) as {
      threads: { id: string; resolved?: { revision: number } }[];
    };
    expect(threads.threads.find((t) => t.id === "t1")?.resolved?.revision).toBe(1);
    await reader.cancel();
  });

  test("resolved:false reopens the thread", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/submit`, { plan: validPlanFor(session.id) });
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "a nit" }] }); // t1
    await resolve(session.id, "t1", { resolved: true });
    const res = await resolve(session.id, "t1", { resolved: false });
    expect(res.status).toBe(202);
    const threads = (await (await app.request(`/api/sessions/${session.id}/threads`)).json()) as {
      threads: { id: string; resolved?: unknown }[];
    };
    expect(threads.threads.find((t) => t.id === "t1")?.resolved).toBeUndefined();
  });

  test("an unknown thread id is a 404 E_UNKNOWN_THREAD", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/submit`, { plan: validPlanFor(session.id) });
    const res = await resolve(session.id, "t9", { resolved: true });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_UNKNOWN_THREAD");
    const noSession = await resolve("otc_zzzzzz", "t1", { resolved: true });
    expect(noSession.status).toBe(404);
  });

  test("a non-boolean `resolved` is a 400", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/submit`, { plan: validPlanFor(session.id) });
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "a nit" }] }); // t1
    expect((await resolve(session.id, "t1", {})).status).toBe(400);
    expect((await resolve(session.id, "t1", { resolved: "yes" })).status).toBe(400);
  });

  test("Resolve refuses a terminal (approved) session with E_SESSION_OVER", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/submit`, { plan: validPlanFor(session.id) });
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "a nit" }] }); // t1
    expect((await postJson(`/api/sessions/${session.id}/approve`, { force: true })).status).toBe(200);
    const res = await resolve(session.id, "t1", { resolved: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_SESSION_OVER");
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
    const file = JSON.parse(readFileSync(eventsPath(session.id), "utf8"));
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

describe("revisions", () => {
  test("GET /revisions/:n returns the stored markdown", async () => {
    const session = mintSession();
    const plan = validPlanFor(session.id);
    await app.request(`/api/sessions/${session.id}/submit`, { method: "POST", body: plan });
    const res = await app.request(`/api/sessions/${session.id}/revisions/1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe(plan);
  });

  test("Accept: application/json returns markdown plus the warnings the revision was accepted with", async () => {
    const session = mintSession();
    // Blow Phase 1's Details past the 80-line soft cap so the submit records an L6 warning.
    const longDetails = Array.from({ length: 85 }, (_, i) => `detail line ${i + 1}`).join("\n");
    const plan = validPlanFor(session.id).replace(
      "The issuer reads the signing key from the keychain at boot.",
      longDetails,
    );
    const submit = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: plan,
    });
    expect(submit.status).toBe(200);

    const res = await app.request(`/api/sessions/${session.id}/revisions/1`, {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const payload = (await res.json()) as {
      session: string;
      revision: number;
      markdown: string;
      warnings: { rule: string; section?: string }[];
    };
    expect(payload.session).toBe(session.id);
    expect(payload.revision).toBe(1);
    expect(payload.markdown).toBe(plan);
    expect(payload.warnings.some((w) => w.rule === "L6" && w.section === "phase-1")).toBe(true);

    // The default (no Accept) read-back stays byte-identical raw markdown.
    const raw = await app.request(`/api/sessions/${session.id}/revisions/1`);
    expect(raw.headers.get("content-type")).toContain("text/markdown");
    expect(await raw.text()).toBe(plan);
  });

  test("missing and malformed revision numbers are rejected", async () => {
    const session = mintSession();
    expect((await app.request(`/api/sessions/${session.id}/revisions/1`)).status).toBe(404);
    expect((await app.request(`/api/sessions/${session.id}/revisions/abc`)).status).toBe(400);
    expect((await app.request(`/api/sessions/${session.id}/revisions/0`)).status).toBe(400);
  });
});

describe("SPA shell and static assets", () => {
  test("GET /, settings, knowledge, and /s/:id serve the same persistent shell", async () => {
    const session = mintSession();
    for (const path of ["/", "/settings", "/knowledge", `/s/${session.id}`, "/s/otc_zzzzzz"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("<div id=\"root\">");
    }
  });

  test("assets are served with their content type and an immutable cache header", async () => {
    const res = await app.request("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toContain("shell");
  });

  test("traversal attempts and unknown asset names 404", async () => {
    expect((await app.request("/assets/../index.html")).status).toBe(404);
    expect((await app.request("/assets/..%2Findex.html")).status).toBe(404);
    expect((await app.request("/assets/nope.js")).status).toBe(404);
    expect((await app.request("/assets/app-abc123.exe")).status).toBe(404);
  });

  test("without a UI build the browser pages answer 503, never a crash", async () => {
    const bare = createApp({ store, uiDir: null, notify: () => {} });
    expect((await bare.request("/")).status).toBe(503);
    expect((await bare.request("/s/otc_zzzzzz")).status).toBe(503);
    expect((await bare.request("/knowledge")).status).toBe(503);
    expect((await bare.request("/assets/app-abc123.js")).status).toBe(404);
  });
});

/** Incremental SSE frame parser over a fetch Response body. */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<{ event?: string; data?: unknown; comment?: string }> {
      for (;;) {
        const index = buffer.indexOf("\n\n");
        if (index !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const frame: { event?: string; data?: unknown; comment?: string } = {};
          for (const line of raw.split("\n")) {
            if (line.startsWith("event: ")) frame.event = line.slice(7);
            else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
            else if (line.startsWith(": ")) frame.comment = line.slice(2);
          }
          return frame;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream ended unexpectedly");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async cancel(): Promise<void> {
      await reader.cancel();
    },
  };
}

describe("UI SSE streams", () => {
  test("the index stream opens with a snapshot, then carries session and revision frames", async () => {
    const reader = sseReader(await app.request("/api/stream"));
    // The snapshot stamps the daemon version so open tabs can self-heal on an
    // update-restart (install/update).
    expect(await reader.next()).toEqual({
      event: "snapshot",
      data: { version: VERSION, sessions: [] },
    });

    const created = (await (await postJson("/api/sessions", { title: "live", repo })).json()) as {
      id: string;
    };
    const sessionFrame = await reader.next();
    expect(sessionFrame.event).toBe("session");
    const summary = (sessionFrame.data as { session: Record<string, unknown> }).session;
    expect(summary).toMatchObject({ id: created.id, status: "draft", revision: 0, pendingEvents: 0 });

    await app.request(`/api/sessions/${created.id}/submit`, {
      method: "POST",
      body: validPlanFor(created.id),
    });
    const updated = await reader.next();
    expect(updated.event).toBe("session");
    expect((updated.data as { session: { status: string } }).session.status).toBe("in_review");
    expect(await reader.next()).toEqual({
      event: "revision",
      data: { session: created.id, revision: 1, changelog: null },
    });
    await reader.cancel();
  });

  test("a per-session stream only carries its own session's frames", async () => {
    const mine = mintSession();
    const other = mintSession();
    const reader = sseReader(await app.request(`/api/sessions/${mine.id}/stream`));
    const snapshot = await reader.next();
    expect(snapshot.event).toBe("snapshot");
    expect((snapshot.data as { session: { id: string } }).session.id).toBe(mine.id);
    // The per-session snapshot also carries the daemon version (self-heal, install/update).
    expect((snapshot.data as { version: string }).version).toBe(VERSION);

    await postJson(`/api/sessions/${other.id}/questions`, { body: "other" });
    await postJson(`/api/sessions/${mine.id}/questions`, { body: "mine" });
    // The very next frame is mine's queue activity — other's never appears here.
    expect(await reader.next()).toEqual({
      event: "queue",
      data: { session: mine.id, pending: 1 },
    });
    await reader.cancel();
  });

  test("delivering a queued event publishes the drained pending count", async () => {
    const session = mintSession();
    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    await reader.next(); // snapshot
    await postJson(`/api/sessions/${session.id}/questions`, { body: "q" });
    expect(await reader.next()).toEqual({
      event: "queue",
      data: { session: session.id, pending: 1 },
    });
    expect((await reader.next()).event).toBe("thread"); // the question's rail thread
    await app.request(`/api/sessions/${session.id}/events`); // agent picks it up (test path acks immediately)
    expect(await reader.next()).toEqual({
      event: "queue",
      data: { session: session.id, pending: 0 },
    });
    await reader.cancel();
  });

  test("streams for unknown sessions 404", async () => {
    expect((await app.request("/api/sessions/otc_zzzzzz/stream")).status).toBe(404);
  });

  test("heartbeat comments keep flowing on an idle stream", async () => {
    const beating = createApp({ store, uiDir: null, sseHeartbeatMs: 15, notify: () => {} });
    const reader = sseReader(await beating.request("/api/stream"));
    await reader.next(); // snapshot
    expect((await reader.next()).comment).toBe("hb");
    await reader.cancel();
  });
});

// The live-tab heartbeat (open-tab reuse): the SPA POSTs /api/viewers/heartbeat
// and /api/health.viewers reports the live count so `otacon open` can skip a
// duplicate tab. A TTL self-heals a closed/crashed tab; a `gone` beacon drops a
// cleanly-closed one immediately. The tracker rides a hand-cranked clock here.
describe("live-tab heartbeat (open-tab reuse)", () => {
  async function liveViewers(): Promise<number> {
    return ((await (await app.request("/api/health")).json()) as { viewers: number }).viewers;
  }

  test("a heartbeat makes /api/health.viewers report a live tab", async () => {
    expect(await liveViewers()).toBe(0);
    const res = await postJson("/api/viewers/heartbeat", { clientId: "tab-a" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await liveViewers()).toBe(1);
  });

  test("a tab self-expires once its heartbeat passes the TTL", async () => {
    await postJson("/api/viewers/heartbeat", { clientId: "tab-a" });
    expect(await liveViewers()).toBe(1);
    viewerNow += VIEWER_TTL; // now - lastSeen === TTL: the tab is stale
    expect(await liveViewers()).toBe(0);
  });

  test("a `gone` beacon drops the tab immediately", async () => {
    await postJson("/api/viewers/heartbeat", { clientId: "tab-a" });
    expect(await liveViewers()).toBe(1);
    const res = await postJson("/api/viewers/heartbeat", { clientId: "tab-a", gone: true });
    expect(res.status).toBe(200);
    expect(await liveViewers()).toBe(0);
  });

  test("a missing or empty clientId is a 400", async () => {
    const missing = await postJson("/api/viewers/heartbeat", {});
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("E_BAD_REQUEST");
    const empty = await postJson("/api/viewers/heartbeat", { clientId: "" });
    expect(empty.status).toBe(400);
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

describe("the revise loop: L5, resolutions, changelog, re-anchoring (M3)", () => {
  /** Submit r1, flush one comment batch (t1 quotes RS256 in phase-1). */
  async function reviewedR1(sessionId: string): Promise<void> {
    await postJson(`/api/sessions/${sessionId}/submit`, { plan: validPlanFor(sessionId) });
    await postJson(`/api/sessions/${sessionId}/comments`, {
      items: [
        {
          anchor: { section: "phase-1", exact: "RS256 JWTs from the auth service" },
          body: "why not ES256?",
        },
      ],
    });
  }

  test("a resubmit without resolutions is a 422 carrying the L5 errors", async () => {
    const session = mintSession();
    await reviewedR1(session.id);
    const res = await postJson(`/api/sessions/${session.id}/submit`, {
      plan: validPlanFor(session.id),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { rule: string; code: string; thread?: string }[] };
    const codes = body.errors.map((e) => e.code);
    expect(codes).toContain("E_THREAD_UNRESOLVED");
    expect(codes).toContain("E_CHANGELOG_MISSING");
    expect(body.errors.find((e) => e.code === "E_THREAD_UNRESOLVED")?.thread).toBe("t1");
    expect(body.errors.every((e) => e.code.startsWith("E_CHANGELOG") || e.code.startsWith("E_THREAD") ? e.rule === "L5" : true)).toBe(true);
    expect(store.readState(session.id).revision).toBe(1); // nothing stored
  });

  test("a resubmit with resolutions + changelog resolves the thread and stores r2", async () => {
    const session = mintSession();
    await reviewedR1(session.id);
    const res = await postJson(`/api/sessions/${session.id}/submit`, {
      plan: validPlanFor(session.id),
      resolutions: { changelog: "Kept RS256; explained why in Decisions.", threads: { t1: "RS256 verifiers only need the public key." } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revision: number; resolved: string[] };
    expect(body.revision).toBe(2);
    expect(body.resolved).toEqual(["t1"]);

    const threads = (await (await app.request(`/api/sessions/${session.id}/threads`)).json()) as {
      threads: { id: string; reply?: { body: string; revision: number } }[];
    };
    expect(threads.threads[0]?.reply).toMatchObject({
      body: "RS256 verifiers only need the public key.",
      revision: 2,
    });

    // The changelog rides the JSON revision read.
    const rev = await app.request(`/api/sessions/${session.id}/revisions/2`, {
      headers: { accept: "application/json" },
    });
    expect(((await rev.json()) as { changelog: string }).changelog).toBe(
      "Kept RS256; explained why in Decisions.",
    );
  });

  test("deleting the quoted text in r2 orphans the thread, visibly over SSE", async () => {
    const session = mintSession();
    await reviewedR1(session.id);
    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    await reader.next(); // snapshot

    const r2 = validPlanFor(session.id).replaceAll("RS256", "ES256");
    const res = await postJson(`/api/sessions/${session.id}/submit`, {
      plan: r2,
      resolutions: { changelog: "Switched to ES256 everywhere.", threads: { t1: "Switched as asked." } },
    });
    expect(res.status).toBe(200);

    const threads = (await (await app.request(`/api/sessions/${session.id}/threads`)).json()) as {
      threads: { id: string; anchorState?: string }[];
    };
    expect(threads.threads[0]?.anchorState).toBe("orphaned");

    // session frame, then the revision frame with changelog, then the thread upsert.
    expect((await reader.next()).event).toBe("session");
    expect(await reader.next()).toEqual({
      event: "revision",
      data: { session: session.id, revision: 2, changelog: "Switched to ES256 everywhere." },
    });
    const threadFrame = await reader.next();
    expect(threadFrame.event).toBe("thread");
    expect((threadFrame.data as { thread: { id: string; anchorState?: string } }).thread).toMatchObject({
      id: "t1",
      anchorState: "orphaned",
    });
    await reader.cancel();
  });
});

describe("last-reviewed tracking and the diff endpoint (M3)", () => {
  test("a comment flush marks the current revision reviewed", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/submit`, { plan: validPlanFor(session.id) });
    expect(store.readState(session.id).lastReviewedRevision).toBe(0);
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "x" }] });
    expect(store.readState(session.id).lastReviewedRevision).toBe(1);
    const detail = (await (await app.request(`/api/sessions/${session.id}`)).json()) as {
      lastReviewedRevision: number;
    };
    expect(detail.lastReviewedRevision).toBe(1);
  });

  test("POST /reviewed validates and is monotonic; the session frame carries it", async () => {
    const session = mintSession();
    expect((await postJson(`/api/sessions/${session.id}/reviewed`, {})).status).toBe(400);
    await postJson(`/api/sessions/${session.id}/submit`, { plan: validPlanFor(session.id) });

    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    await reader.next(); // snapshot
    const ok = await postJson(`/api/sessions/${session.id}/reviewed`, {});
    expect(await ok.json()).toEqual({ ok: true, session: session.id, lastReviewedRevision: 1 });
    const frame = await reader.next();
    expect(frame.event).toBe("session");
    expect((frame.data as { session: { lastReviewedRevision: number } }).session.lastReviewedRevision).toBe(1);
    await reader.cancel();

    expect((await postJson(`/api/sessions/${session.id}/reviewed`, { revision: 2 })).status).toBe(400);
    expect((await postJson(`/api/sessions/${session.id}/reviewed`, { revision: 0.5 })).status).toBe(400);
  });

  test("GET /diff defaults to last-reviewed → latest; ?from= selects the baseline", async () => {
    const session = mintSession();
    const r1 = validPlanFor(session.id);
    await postJson(`/api/sessions/${session.id}/submit`, { plan: r1 });
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "x" }] }); // reviews r1
    await postJson(`/api/sessions/${session.id}/submit`, {
      plan: r1.replace("Goal: Issue RS256 JWTs from the auth service.", "Goal: Issue and rotate RS256 JWTs."),
      resolutions: { changelog: "c", threads: { t1: "done" } },
    });

    const res = await app.request(`/api/sessions/${session.id}/diff`);
    const diff = (await res.json()) as {
      from: number;
      to: number;
      sections: { id: string; status: string; hunks: unknown[] }[];
    };
    expect(diff.from).toBe(1);
    expect(diff.to).toBe(2);
    const byId = new Map(diff.sections.map((s) => [s.id, s]));
    expect(byId.get("phase-1")?.status).toBe("changed");
    expect(byId.get("phase-1")?.hunks.length).toBeGreaterThan(0);
    expect(byId.get("summary")?.status).toBe("unchanged");
    expect(byId.get("summary")?.hunks).toEqual([]);

    // Explicit baseline: r2 vs r2 is all unchanged; from=0 is all added.
    const same = (await (await app.request(`/api/sessions/${session.id}/diff?from=2&to=2`)).json()) as {
      sections: { status: string }[];
    };
    expect(same.sections.every((s) => s.status === "unchanged")).toBe(true);
    const fresh = (await (await app.request(`/api/sessions/${session.id}/diff?from=0`)).json()) as {
      sections: { status: string }[];
    };
    expect(fresh.sections.every((s) => s.status === "added")).toBe(true);
  });

  test("diff validation: no revisions is 404; out-of-range from/to are 400", async () => {
    const session = mintSession();
    expect((await app.request(`/api/sessions/${session.id}/diff`)).status).toBe(404);
    await postJson(`/api/sessions/${session.id}/submit`, { plan: validPlanFor(session.id) });
    expect((await app.request(`/api/sessions/${session.id}/diff?to=2`)).status).toBe(400);
    expect((await app.request(`/api/sessions/${session.id}/diff?from=9`)).status).toBe(400);
    expect((await app.request(`/api/sessions/${session.id}/diff?from=x`)).status).toBe(400);
    expect((await app.request(`/api/sessions/otc_zzzzzz/diff`)).status).toBe(404);
  });
});

describe("the grill loop: ask, answers, transcript, L3 (M4)", () => {
  const ask = (id: string, body: unknown) => postJson(`/api/sessions/${id}/ask`, body);
  const answers = (id: string, body: unknown) => postJson(`/api/sessions/${id}/answers`, body);

  test("ask persists a transcript entry and queues nothing for the agent", async () => {
    const session = mintSession();
    const res = await ask(session.id, {
      question: "RS256 or HS256?",
      options: ["RS256", "HS256"],
      recommend: "RS256",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, session: session.id, id: "q1" });

    const transcript = await app.request(`/api/sessions/${session.id}/transcript`);
    const listed = (await transcript.json()) as { transcript: Record<string, unknown>[] };
    expect(listed.transcript[0]).toMatchObject({
      id: "q1",
      question: "RS256 or HS256?",
      options: ["RS256", "HS256"],
      recommend: "RS256",
    });
    // The asker goes back to wait — no event exists until the user answers.
    const event = await app.request(`/api/sessions/${session.id}/events`);
    expect(await event.json()).toEqual({ event: "timeout" });
  });

  test("agent questions share the q counter with user-question threads", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/questions`, { body: "user asks first" });
    const res = await ask(session.id, { question: "agent asks second" });
    expect(((await res.json()) as { id: string }).id).toBe("q2");
  });

  test("ask validates its shape", async () => {
    const session = mintSession();
    expect((await ask(session.id, {})).status).toBe(400);
    expect((await ask(session.id, { question: "x", options: ["only one"] })).status).toBe(400);
    expect((await ask(session.id, { question: "x", options: ["A", "A"] })).status).toBe(400);
    expect(
      (await ask(session.id, { question: "x", options: ["A", "B"], recommend: "C" })).status,
    ).toBe(400);
    expect((await ask(session.id, { question: "x", recommend: "A" })).status).toBe(400);
    expect((await ask(session.id, { question: "x", multi: true })).status).toBe(400);
    expect((await ask("otc_zzzzzz", { question: "x" })).status).toBe(404);
  });

  test("a batch mints N independent cards atomically and shares the q counter", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/questions`, { body: "user asks first" }); // q1
    const res = await ask(session.id, {
      questions: [
        { question: "free text?" },
        { question: "pick one?", options: ["A", "B"], recommend: "B" },
        { question: "pick any?", options: ["x", "y", "z"], multi: true },
      ],
    });
    expect(res.status).toBe(201);
    // The batch reports every minted id, continuing the shared q counter.
    expect(await res.json()).toEqual({ ok: true, session: session.id, ids: ["q2", "q3", "q4"] });

    const listed = (await (await app.request(`/api/sessions/${session.id}/transcript`)).json()) as {
      transcript: Record<string, unknown>[];
    };
    expect(listed.transcript.map((e) => e.id)).toEqual(["q2", "q3", "q4"]);
    expect(listed.transcript[1]).toMatchObject({ id: "q3", options: ["A", "B"], recommend: "B" });
    expect(listed.transcript[2]).toMatchObject({ id: "q4", multi: true });
    expect(listed.transcript[0]).not.toHaveProperty("options"); // free text
  });

  test("a malformed batch member fails the whole batch — no partial queue", async () => {
    const session = mintSession();
    expect((await ask(session.id, { questions: [] })).status).toBe(400);
    expect((await ask(session.id, { questions: "nope" })).status).toBe(400);
    // First member is fine, second is bad: the whole batch rejects.
    const res = await ask(session.id, {
      questions: [{ question: "ok" }, { question: "x", options: ["only one"] }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "questions[1]",
    );
    // Nothing was minted — the transcript is still empty (no burned ids either).
    const listed = (await (await app.request(`/api/sessions/${session.id}/transcript`)).json()) as {
      transcript: unknown[];
    };
    expect(listed.transcript).toEqual([]);
    // A subsequent single ask still mints q1 — the failed batch burned no counter.
    expect(((await (await ask(session.id, { question: "ok now" })).json()) as { id: string }).id).toBe(
      "q1",
    );
  });

  test("socratic mode refuses chips (options/recommend) but accepts free text", async () => {
    const session = store.createSession({ title: "grill", repo, socratic: true });
    const withOptions = await ask(session.id, { question: "x", options: ["A", "B"] });
    expect(withOptions.status).toBe(400);
    expect(((await withOptions.json()) as { error: { code: string } }).error.code).toBe(
      "E_SOCRATIC_FREE_TEXT_ONLY",
    );
    const withRecommend = await ask(session.id, {
      question: "x",
      options: ["A", "B"],
      recommend: "A",
    });
    expect(withRecommend.status).toBe(400);
    expect(((await withRecommend.json()) as { error: { code: string } }).error.code).toBe(
      "E_SOCRATIC_FREE_TEXT_ONLY",
    );
    // A pure free-text question is the only allowed shape and mints q1.
    const freeText = await ask(session.id, { question: "why this approach?" });
    expect(freeText.status).toBe(201);
    expect(((await freeText.json()) as { id: string }).id).toBe("q1");
    // The two rejected asks burned no counter.
    const listed = (await (await app.request(`/api/sessions/${session.id}/transcript`)).json()) as {
      transcript: { id: string }[];
    };
    expect(listed.transcript.map((e) => e.id)).toEqual(["q1"]);
  });

  test("socratic mode: one chip member fails the whole batch with the coded 400", async () => {
    const session = store.createSession({ title: "grill", repo, socratic: true });
    const res = await ask(session.id, {
      questions: [{ question: "free?" }, { question: "pick?", options: ["A", "B"] }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("E_SOCRATIC_FREE_TEXT_ONLY");
    expect(body.error.message).toContain("questions[1]");
    // Nothing minted — the whole batch was refused.
    const listed = (await (await app.request(`/api/sessions/${session.id}/transcript`)).json()) as {
      transcript: unknown[];
    };
    expect(listed.transcript).toEqual([]);
  });

  test("non-socratic sessions still accept chips (regression guard)", async () => {
    const session = mintSession(); // socratic: false
    const res = await ask(session.id, { question: "x", options: ["A", "B"], recommend: "A" });
    expect(res.status).toBe(201);
  });

  test("an answer lands on the transcript and wakes the agent with an answer event", async () => {
    const session = mintSession();
    await ask(session.id, { question: "algo?", options: ["RS256", "HS256"] });
    const res = await answers(session.id, {
      question: "q1",
      choice: "RS256",
      text: "rotation matters",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, session: session.id, question: "q1" });

    const event = await app.request(`/api/sessions/${session.id}/events`);
    expect(await event.json()).toEqual({
      event: "answer",
      session: session.id,
      question: "q1",
      choice: "RS256",
      text: "rotation matters",
    });
    const transcript = await app.request(`/api/sessions/${session.id}/transcript`);
    const listed = (await transcript.json()) as { transcript: { answer?: unknown }[] };
    expect(listed.transcript[0]?.answer).toMatchObject({ choice: "RS256", text: "rotation matters" });
  });

  test("answers validate against the question's shape", async () => {
    const session = mintSession();
    await ask(session.id, { question: "single", options: ["A", "B"] });
    await ask(session.id, { question: "multi", options: ["A", "B", "C"], multi: true });
    await ask(session.id, { question: "free text" });

    expect((await answers(session.id, { question: "q9", choice: "A" })).status).toBe(404);
    expect((await answers(session.id, { question: "q1", choice: "Z" })).status).toBe(400);
    expect((await answers(session.id, { question: "q1", choices: ["A"] })).status).toBe(400);
    expect((await answers(session.id, { question: "q2", choice: "A" })).status).toBe(400);
    expect((await answers(session.id, { question: "q2", choices: ["A", "Z"] })).status).toBe(400);
    expect((await answers(session.id, { question: "q2", choices: [] })).status).toBe(400);
    expect((await answers(session.id, { question: "q3", choice: "A" })).status).toBe(400);
    expect((await answers(session.id, { question: "q3" })).status).toBe(400);

    expect((await answers(session.id, { question: "q2", choices: ["A", "C"] })).status).toBe(202);
    expect((await answers(session.id, { question: "q3", text: "like so" })).status).toBe(202);
  });

  test("a custom free-form answer with no chip lands on option questions (single + multi)", async () => {
    const session = mintSession();
    await ask(session.id, { question: "single", options: ["A", "B"], recommend: "A" });
    await ask(session.id, { question: "multi", options: ["A", "B", "C"], multi: true });

    // Native-"Other" parity: text alone is a valid answer on an option question.
    const single = await answers(session.id, { question: "q1", text: "none of these — option D" });
    expect(single.status).toBe(202);
    const multi = await answers(session.id, { question: "q2", text: "a different cut entirely" });
    expect(multi.status).toBe(202);

    const listed = (await (await app.request(`/api/sessions/${session.id}/transcript`)).json()) as {
      transcript: {
        answer?: { choice?: string; choices?: string[]; text?: string; answeredAt?: string };
      }[];
    };
    // The custom answer carries text with no choice/choices.
    expect(listed.transcript[0]?.answer).toEqual({
      text: "none of these — option D",
      answeredAt: expect.any(String),
    });
    expect(listed.transcript[1]?.answer).toEqual({
      text: "a different cut entirely",
      answeredAt: expect.any(String),
    });

    // No chip-less empty answers: whitespace/empty/absent text still rejects.
    expect((await answers(session.id, { question: "q1", text: "   " })).status).toBe(400);
    expect((await answers(session.id, { question: "q1" })).status).toBe(400);
    expect((await answers(session.id, { question: "q2", text: "" })).status).toBe(400);
  });

  test("re-answering overwrites the stored answer (at-least-once)", async () => {
    const session = mintSession();
    await ask(session.id, { question: "algo?", options: ["A", "B"] });
    await answers(session.id, { question: "q1", choice: "A" });
    await answers(session.id, { question: "q1", choice: "B" });
    const transcript = await app.request(`/api/sessions/${session.id}/transcript`);
    const listed = (await transcript.json()) as { transcript: { answer?: { choice?: string } }[] };
    expect(listed.transcript[0]?.answer?.choice).toBe("B");
  });

  test("a first answer omits revised and prior", async () => {
    const session = mintSession();
    await ask(session.id, { question: "algo?", options: ["A", "B"] });
    await answers(session.id, { question: "q1", choice: "A" });

    const event = (await (await app.request(`/api/sessions/${session.id}/events`)).json()) as Record<
      string,
      unknown
    >;
    expect(event).toEqual({
      event: "answer",
      session: session.id,
      question: "q1",
      choice: "A",
    });
    expect(event).not.toHaveProperty("revised");
    expect(event).not.toHaveProperty("prior");
  });

  test("a re-answer stamps revised:true and prior with the previous answer's content", async () => {
    const session = mintSession();
    await ask(session.id, { question: "algo?", options: ["A", "B"] });
    await answers(session.id, { question: "q1", choice: "A" });
    // Drain the first answer event so the next /events returns the re-answer.
    await app.request(`/api/sessions/${session.id}/events`);

    await answers(session.id, { question: "q1", choice: "B" });
    const event = (await (await app.request(`/api/sessions/${session.id}/events`)).json()) as Record<
      string,
      unknown
    >;
    expect(event).toEqual({
      event: "answer",
      session: session.id,
      question: "q1",
      choice: "B",
      revised: true,
      prior: { choice: "A" },
    });
  });

  test("L3: citing a q id missing from the transcript rejects 422; a real one passes", async () => {
    const session = mintSession();
    const cited = validPlanFor(session.id).replace(
      "- D1: RS256 over HS256 [assumed]",
      "- D1: RS256 over HS256 ← q1",
    );
    const rejected = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: cited,
    });
    expect(rejected.status).toBe(422);
    const issues = (await rejected.json()) as { errors: { code: string; rule: string }[] };
    expect(issues.errors.map((e) => e.code)).toContain("E_UNKNOWN_QUESTION_CITED");
    expect(issues.errors.find((e) => e.code === "E_UNKNOWN_QUESTION_CITED")?.rule).toBe("L3");

    await ask(session.id, { question: "algo?", options: ["RS256", "HS256"] });
    const accepted = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: cited,
    });
    expect(accepted.status).toBe(200);
  });

  test("L3: an untraced decision rejects normal sessions, only warns --quick ones", async () => {
    const strict = mintSession();
    const untraced = (id: string) => validPlanFor(id).replace(" [assumed]", "");
    const rejected = await app.request(`/api/sessions/${strict.id}/submit`, {
      method: "POST",
      body: untraced(strict.id),
    });
    expect(rejected.status).toBe(422);

    const quick = store.createSession({ title: "quick plan", repo, quick: true });
    const accepted = await app.request(`/api/sessions/${quick.id}/submit`, {
      method: "POST",
      body: untraced(quick.id),
    });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { warnings: { code: string; severity: string }[] };
    const downgraded = body.warnings.find((w) => w.code === "E_DECISION_UNTRACED");
    expect(downgraded?.severity).toBe("warning");
  });

  test("the per-session stream snapshots the transcript and pushes grill frames", async () => {
    const session = mintSession();
    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    const snapshot = await reader.next();
    expect((snapshot.data as { transcript: unknown[] }).transcript).toEqual([]);
    expect((snapshot.data as { session: { openQuestions: number } }).session.openQuestions).toBe(0);

    await ask(session.id, { question: "algo?", options: ["A", "B"] });
    const askedFrame = await reader.next();
    expect(askedFrame.event).toBe("grill");
    expect((askedFrame.data as { entry: { id: string } }).entry.id).toBe("q1");
    // The transcript change publishes a session frame: openQuestions feeds the
    // index's "questions pending" chip (review UI).
    const askedSession = await reader.next();
    expect(askedSession.event).toBe("session");
    expect((askedSession.data as { session: { openQuestions: number } }).session.openQuestions).toBe(1);

    await answers(session.id, { question: "q1", choice: "A" });
    // queue frame (the enqueue), the grill upsert carrying the answer, then
    // the session frame with openQuestions back at 0.
    expect((await reader.next()).event).toBe("queue");
    const answeredFrame = await reader.next();
    expect(answeredFrame.event).toBe("grill");
    expect((answeredFrame.data as { entry: { answer?: { choice: string } } }).entry.answer?.choice).toBe("A");
    const answeredSession = await reader.next();
    expect(answeredSession.event).toBe("session");
    expect((answeredSession.data as { session: { openQuestions: number } }).session.openQuestions).toBe(0);
    await reader.cancel();
  });

  test("session detail counts unanswered grill questions as openQuestions", async () => {
    const session = mintSession();
    await ask(session.id, { question: "one?", options: ["A", "B"] });
    await ask(session.id, { question: "two?" });
    const before = (await (await app.request(`/api/sessions/${session.id}`)).json()) as {
      openQuestions: number;
    };
    expect(before.openQuestions).toBe(2);
    await answers(session.id, { question: "q1", choice: "A" });
    const after = (await (await app.request(`/api/sessions/${session.id}`)).json()) as {
      openQuestions: number;
    };
    expect(after.openQuestions).toBe(1);
  });
});

describe("progress and live activity (live-agent-activity)", () => {
  const progress = (id: string, note: unknown) =>
    postJson(`/api/sessions/${id}/progress`, { note });

  test("POST /progress appends a note and returns {ok, session, note}", async () => {
    const session = mintSession();
    const res = await progress(session.id, "reading the auth module");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      session: session.id,
      note: "reading the auth module",
    });
    // It lands on the feed: session detail exposes it as latestActivity.
    const detail = (await (await app.request(`/api/sessions/${session.id}`)).json()) as {
      latestActivity?: { text: string };
    };
    expect(detail.latestActivity?.text).toBe("reading the auth module");
  });

  test("a progress note pushes an activity frame, a stream highlight, then a session frame for the chip", async () => {
    const session = mintSession();
    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    const snapshot = await reader.next();
    expect((snapshot.data as { activity: unknown[] }).activity).toEqual([]);
    expect((snapshot.data as { stream: unknown[] }).stream).toEqual([]);

    await progress(session.id, "drafting plan");
    const activityFrame = await reader.next();
    expect(activityFrame.event).toBe("activity");
    expect((activityFrame.data as { note: { text: string } }).note.text).toBe("drafting plan");
    // The same note flows into the new live-activity stream as a `highlight`
    // (live-agent-activity), with a daemon-assigned seq.
    const streamFrame = await reader.next();
    expect(streamFrame.event).toBe("stream");
    const events = (streamFrame.data as { events: { kind: string; label: string; seq: number }[] })
      .events;
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("highlight");
    expect(events[0]?.label).toBe("drafting plan");
    expect(events[0]?.seq).toBe(1);
    // The draft chip rides the session frame's latestActivity (review UI).
    const sessionFrame = await reader.next();
    expect(sessionFrame.event).toBe("session");
    const summary = (
      sessionFrame.data as { session: { latestActivity?: { text: string }; lastContactAt?: number } }
    ).session;
    expect(summary.latestActivity?.text).toBe("drafting plan");
    expect(typeof summary.lastContactAt).toBe("number");
    await reader.cancel();
  });

  test("progress highlights land in the per-session stream snapshot, oldest first, with monotonic seq", async () => {
    const session = mintSession();
    await progress(session.id, "one");
    await progress(session.id, "two");
    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    const snapshot = await reader.next();
    const stream = (snapshot.data as { stream: { kind: string; label: string; seq: number }[] })
      .stream;
    expect(stream.map((e) => e.label)).toEqual(["one", "two"]);
    expect(stream.every((e) => e.kind === "highlight")).toBeTrue();
    expect(stream.map((e) => e.seq)).toEqual([1, 2]);
    await reader.cancel();
  });

  test("a progress note carrying an API key and a ~5 KB body: redacted + truncated in the stream detail", async () => {
    const session = mintSession();
    const secret = "sk-abcdEFGHijklMNOPqrstUVWX1234567890";
    const note = `deploying with token=${secret} ` + "X".repeat(5000);
    await progress(session.id, note);
    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    const snapshot = await reader.next();
    const event = (
      snapshot.data as { stream: { kind: string; detail?: string; label: string }[] }
    ).stream[0];
    expect(event?.kind).toBe("highlight");
    const detail = event?.detail ?? "";
    expect(detail).not.toContain(secret);
    expect(detail).toContain("[redacted]");
    // Truncated to the configured stream detail cap (default 600), not the 5 KB body.
    expect(detail.length).toBeLessThanOrEqual(600);
    await reader.cancel();
  });

  test("the per-session snapshot carries the activity feed, oldest first", async () => {
    const session = mintSession();
    await progress(session.id, "one");
    await progress(session.id, "two");
    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    const snapshot = await reader.next();
    expect((snapshot.data as { activity: { text: string }[] }).activity.map((n) => n.text)).toEqual([
      "one",
      "two",
    ]);
    await reader.cancel();
  });

  test("a long note is trimmed to the configured max and ellipsized", async () => {
    const session = mintSession();
    const res = await progress(session.id, "x".repeat(500));
    const body = (await res.json()) as { note: string };
    expect(body.note.length).toBeLessThanOrEqual(200);
    expect(body.note.endsWith("…")).toBeTrue();
  });

  test("an empty note is refused with 400", async () => {
    const session = mintSession();
    const res = await progress(session.id, "   ");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_BAD_REQUEST");
  });

  test("progress refuses an approved session with E_SESSION_OVER", async () => {
    const session = mintSession();
    await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: validPlanFor(session.id),
    });
    expect((await postJson(`/api/sessions/${session.id}/approve`, { force: true })).status).toBe(200);
    const res = await progress(session.id, "too late");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_SESSION_OVER");
  });

  test("a parked wait publishes presence: a session frame with parked=true + fresh lastContactAt", async () => {
    const session = mintSession();
    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    const snapshot = await reader.next();
    expect((snapshot.data as { session: { parked: boolean } }).session.parked).toBeFalse();

    const parked = app.request(`/api/sessions/${session.id}/events?wait=5`);
    // Entering the park broadcasts presence before any event arrives.
    const onPark = await reader.next();
    expect(onPark.event).toBe("session");
    const parkedSummary = (
      onPark.data as { session: { parked: boolean; lastContactAt?: number } }
    ).session;
    expect(parkedSummary.parked).toBeTrue();
    expect(typeof parkedSummary.lastContactAt).toBe("number");

    // Wake it so the parked request resolves (and the test doesn't dangle).
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "wake" }] });
    await parked;
    await reader.cancel();
  });
});

describe("transcript tailer lifecycle (live-progress-activity-redesign)", () => {
  // A stub tailer factory records start/stop per repo so the test observes the
  // lifecycle wiring without a real fs poll or any ~/.claude dependency.
  type Stub = { start(): void; stop(): void; started: number; stopped: number };
  function tailedApp() {
    const stubs: Stub[] = [];
    const tailed = createApp({
      store,
      uiDir,
      presence,
      notify: () => {},
      makeTailer: () => {
        const stub: Stub = {
          started: 0,
          stopped: 0,
          start() {
            this.started += 1;
          },
          stop() {
            this.stopped += 1;
          },
        };
        stubs.push(stub);
        return stub;
      },
    });
    return { tailed, stubs };
  }
  const post = (a: Hono<{ Bindings: NodeBindings }>, path: string, body: unknown = {}) =>
    a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("creating a session starts exactly one tailer", async () => {
    const { tailed, stubs } = tailedApp();
    const res = await post(tailed, "/api/sessions", { title: "tailed", repo });
    expect(res.status).toBe(201);
    expect(stubs).toHaveLength(1);
    expect(stubs[0]?.started).toBe(1);
    expect(stubs[0]?.stopped).toBe(0);
  });

  test("Save (approve) stops the tailer; the session is terminal", async () => {
    const { tailed, stubs } = tailedApp();
    const { id } = (await (await post(tailed, "/api/sessions", { title: "t", repo })).json()) as { id: string };
    await tailed.request(`/api/sessions/${id}/submit`, { method: "POST", body: validPlanFor(id) });
    const approved = await post(tailed, `/api/sessions/${id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(stubs[0]?.stopped).toBe(1);
  });

  test("Implement keeps the tailer alive until implement-done", async () => {
    const { tailed, stubs } = tailedApp();
    const { id } = (await (await post(tailed, "/api/sessions", { title: "t", repo })).json()) as { id: string };
    await tailed.request(`/api/sessions/${id}/submit`, { method: "POST", body: validPlanFor(id) });
    await post(tailed, `/api/sessions/${id}/approve`, { implement: true });
    expect(stubs[0]?.stopped).toBe(0); // still building → still tailing
    await post(tailed, `/api/sessions/${id}/implement-done`, { pr: "https://example.com/pr/1" });
    expect(stubs[0]?.stopped).toBe(1); // build over → tailer torn down
  });

  test("deleting a session stops the tailer", async () => {
    const { tailed, stubs } = tailedApp();
    const { id } = (await (await post(tailed, "/api/sessions", { title: "t", repo })).json()) as { id: string };
    await tailed.request(`/api/sessions/${id}`, { method: "DELETE" });
    expect(stubs[0]?.stopped).toBe(1);
  });

  test("FLOOR: with no adapter, no tailer activity occurs yet progress still streams", async () => {
    // The default app (no makeTailer override) uses the real Tailer; the temp
    // repo has no ~/.claude transcript, so findAdapter returns null and the
    // tailer no-ops. The progress floor must be entirely unaffected.
    const session = mintSession();
    const res = await postJson(`/api/sessions/${session.id}/progress`, { note: "floor still flows" });
    expect(res.status).toBe(200);
    // The highlight landed in the stream snapshot — the floor is intact.
    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    const snapshot = await reader.next();
    const stream = (snapshot.data as { stream: { kind: string; label: string }[] }).stream;
    expect(stream.some((e) => e.kind === "highlight" && e.label === "floor still flows")).toBe(true);
    await reader.cancel();
  });
});

describe("approve and the status machine (M4)", () => {
  const submitValid = async (id: string) => {
    const res = await app.request(`/api/sessions/${id}/submit`, {
      method: "POST",
      body: validPlanFor(id),
    });
    expect(res.status).toBe(200);
  };
  const approve = (id: string, body: unknown = {}) =>
    postJson(`/api/sessions/${id}/approve`, body);

  test("approve refuses a session with no revisions", async () => {
    const session = mintSession();
    const res = await approve(session.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_NO_REVISION");
  });

  test("unresolved threads 409 with the count unless forced", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "open comment" }] });
    await postJson(`/api/sessions/${session.id}/questions`, { body: "open question" });

    const refused = await approve(session.id);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { code: string }; unresolved: number };
    expect(body.error.code).toBe("E_UNRESOLVED_THREADS");
    expect(body.unresolved).toBe(2);

    const forced = await approve(session.id, { force: true });
    expect(forced.status).toBe(200);
  });

  test("an answered question no longer counts as unresolved", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await postJson(`/api/sessions/${session.id}/questions`, { body: "open question" });
    await postJson(`/api/sessions/${session.id}/questions/q1/answer`, { body: "answered" });
    expect((await approve(session.id)).status).toBe(200);
  });

  test("a responded-but-unresolved comment STILL counts unresolved (a reply is not a close)", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ anchor: { section: "phase-1", exact: "RS256 JWTs from the auth service" }, body: "why not ES256?" }],
    });
    // The agent replies on a clean r2 — a response, not a close.
    await postJson(`/api/sessions/${session.id}/submit`, {
      plan: validPlanFor(session.id),
      resolutions: { changelog: "Explained the choice.", threads: { t1: "Kept RS256." } },
    });
    const refused = await approve(session.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { unresolved: number }).unresolved).toBe(1);
  });

  test("a reviewer-Resolved comment does NOT count unresolved", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "a nit" }] }); // t1
    await postJson(`/api/sessions/${session.id}/threads/t1/resolve`, { resolved: true });
    expect((await approve(session.id)).status).toBe(200);
  });

  test("an unanswered ask counts; an unanswered-but-Resolved ask does NOT", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await postJson(`/api/sessions/${session.id}/questions`, { body: "open question" }); // q1
    const refused = await approve(session.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { unresolved: number }).unresolved).toBe(1);
    // The reviewer Resolves the ask instead of waiting for an answer.
    await postJson(`/api/sessions/${session.id}/threads/q1/resolve`, { resolved: true });
    expect((await approve(session.id)).status).toBe(200);
  });

  test("resolving a question root clears its unanswered follow-up too (count keys on the root)", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await postJson(`/api/sessions/${session.id}/questions`, { body: "root question" }); // q1
    await postJson(`/api/sessions/${session.id}/questions`, { replyTo: "q1", body: "follow up" }); // q2
    // Two unanswered turns in ONE conversation → counts once (per-conversation).
    const refused = await approve(session.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { unresolved: number }).unresolved).toBe(1);
    // Resolving the ROOT clears the whole chain — the follow-up keys on q1.
    await postJson(`/api/sessions/${session.id}/threads/q1/resolve`, { resolved: true });
    expect((await approve(session.id)).status).toBe(200);
  });

  test("a multi-turn comment conversation counts once; resolving the root drops it to 0", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "root nit" }] }); // t1
    await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ replyTo: "t1", body: "still wrong" }], // t2
    });
    await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ replyTo: "t2", body: "and again" }], // t3 → collapses to root t1
    });
    // Three turns, one conversation → exactly 1 unresolved.
    const refused = await approve(session.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { unresolved: number }).unresolved).toBe(1);
    // Resolving the ROOT withdraws the whole conversation → approve passes.
    await postJson(`/api/sessions/${session.id}/threads/t1/resolve`, { resolved: true });
    expect((await approve(session.id)).status).toBe(200);
  });

  test("approve writes the artifact, flips status, and queues the approved event", async () => {
    const session = mintSession();
    await postJson(`/api/sessions/${session.id}/ask`, {
      question: "algo?",
      options: ["RS256", "HS256"],
      recommend: "RS256",
    });
    await postJson(`/api/sessions/${session.id}/answers`, { question: "q1", choice: "RS256" });
    await app.request(`/api/sessions/${session.id}/events`); // drain the answer event
    const cited = validPlanFor(session.id).replace(
      "- D1: RS256 over HS256 [assumed]",
      "- D1: RS256 over HS256 ← q1",
    );
    const submitted = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: cited,
    });
    expect(submitted.status).toBe(200);

    const res = await approve(session.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; home: string; revision: number };
    expect(body.revision).toBe(1);
    // Save (plain approve) writes the project copy under the default plans.dir.
    expect(body.path).toMatch(/^\.otacon\/plans\/\d{4}-\d{2}-\d{2}-e2e-plan\.md$/);
    // The canonical home copy lands under ~/.otacon/sessions/<id>/, always.
    expect(body.home).toBe(join(homeSessionDir(session.id), body.path.split("/").pop() as string));

    const artifact = readFileSync(join(repo, body.path), "utf8");
    expect(artifact).toContain("status: approved");
    expect(artifact).toContain("## Interview");
    expect(artifact).toContain("### q1 — algo?");
    expect(artifact).toContain("- Answer: RS256");
    // Both copies exist and are identical (no git ran — otacon never commits).
    expect(readFileSync(body.home, "utf8")).toBe(artifact);
    expect(store.getSession(session.id)?.status).toBe("approved");

    const event = await app.request(`/api/sessions/${session.id}/events`);
    expect(await event.json()).toEqual({
      event: "approved",
      session: session.id,
      path: body.path,
      home: body.home,
    });
  });

  test("a same-title re-approve suffixes the project copy instead of overwriting", async () => {
    const first = mintSession();
    await submitValid(first.id);
    const a = (await (await approve(first.id)).json()) as { path: string };
    const second = mintSession(); // same "e2e plan" title
    await submitValid(second.id);
    const b = (await (await approve(second.id)).json()) as { path: string };
    // Same title + date → the project copy under plans.dir gets a -2 suffix.
    expect(b.path).not.toBe(a.path);
    expect(b.path).toMatch(/-e2e-plan-2\.md$/);
    expect(readFileSync(join(repo, a.path), "utf8")).toContain(first.id);
    expect(readFileSync(join(repo, b.path), "utf8")).toContain(second.id);
  });

  /** A body whose bytes arrive only when released — parks a handler on its body await. */
  const gatedBody = (content: string): { body: ReadableStream<Uint8Array>; release: () => void } => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },
    });
    return { body, release };
  };

  test("a submit whose body is still streaming when approve lands is refused", async () => {
    const session = mintSession();
    await submitValid(session.id);
    // The submit passes its 404 lookup, then parks on the body read; approve
    // completes in that window. The pre-await status snapshot must not be
    // trusted — without the post-await re-check this submit would save r2 and
    // flip the approved session back to in_review.
    const { body, release } = gatedBody(validPlanFor(session.id));
    const racing = app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    await sleep(10); // let the handler reach its body await
    expect((await approve(session.id)).status).toBe(200);
    release();
    const res = await racing;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_SESSION_OVER");
    // The race wrote nothing: no r2 snapshot, and the session stayed approved.
    expect(store.getSession(session.id)?.status).toBe("approved");
    expect(existsSync(revisionPath(session.id, 2))).toBeFalse();
  });

  test("the slower of two racing approves refuses instead of writing a twin artifact", async () => {
    const session = mintSession();
    await submitValid(session.id);
    const { body, release } = gatedBody("{}");
    const racing = app.request(`/api/sessions/${session.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    await sleep(10);
    const winner = (await (await approve(session.id)).json()) as { path: string };
    release();
    const res = await racing;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_SESSION_OVER");
    // Exactly one artifact: the loser never minted the -2 suffixed twin.
    expect(existsSync(join(repo, winner.path))).toBeTrue();
    expect(existsSync(join(repo, winner.path.replace(/\.md$/, "-2.md")))).toBeFalse();
    // And only one approved event sits in the queue.
    const event = await app.request(`/api/sessions/${session.id}/events`);
    expect(((await event.json()) as { event: string }).event).toBe("approved");
    const drained = await app.request(`/api/sessions/${session.id}/events`);
    expect(((await drained.json()) as { event: string }).event).toBe("timeout");
  });

  test("every mutating verb refuses an approved session with E_SESSION_OVER", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await postJson(`/api/sessions/${session.id}/questions`, { body: "pre-approve question" });
    await postJson(`/api/sessions/${session.id}/questions/q1/answer`, { body: "answered" });
    expect((await approve(session.id)).status).toBe(200);

    const attempts: [string, Response | Promise<Response>][] = [
      ["submit", app.request(`/api/sessions/${session.id}/submit`, { method: "POST", body: validPlanFor(session.id) })],
      ["comments", postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "x" }] })],
      ["questions", postJson(`/api/sessions/${session.id}/questions`, { body: "x" })],
      ["question answer", postJson(`/api/sessions/${session.id}/questions/q1/answer`, { body: "x" })],
      ["ask", postJson(`/api/sessions/${session.id}/ask`, { question: "x" })],
      ["answers", postJson(`/api/sessions/${session.id}/answers`, { question: "q1", text: "x" })],
      ["progress", postJson(`/api/sessions/${session.id}/progress`, { note: "x" })],
      ["approve", approve(session.id, { force: true })],
    ];
    for (const [verb, pending] of attempts) {
      const res = await pending;
      expect(res.status, `${verb} should 409 on an approved session`).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code, verb).toBe("E_SESSION_OVER");
    }
  });
});

describe("Approve & Implement and the implement lifecycle (implement-approved-plan)", () => {
  const submitValid = async (id: string) => {
    const res = await app.request(`/api/sessions/${id}/submit`, {
      method: "POST",
      body: validPlanFor(id),
    });
    expect(res.status).toBe(200);
  };
  const approve = (id: string, body: unknown = {}) =>
    postJson(`/api/sessions/${id}/approve`, body);
  const implementDone = (id: string, body: unknown = {}) =>
    postJson(`/api/sessions/${id}/implement-done`, body);
  const statusOf = async (id: string): Promise<string> =>
    ((await (await app.request(`/api/sessions/${id}`)).json()) as { status: string }).status;

  test("approve {implement:true} flips to implementing and queues approved {implement:true}", async () => {
    const session = mintSession();
    await submitValid(session.id);

    const res = await approve(session.id, { implement: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { implement: boolean; path: string; home: string };
    expect(body.implement).toBe(true);
    // Non-terminal: the session is now building, not over.
    expect(await statusOf(session.id)).toBe("implementing");
    expect(store.getSession(session.id)?.status).toBe("implementing");
    // Implement writes the home copy ONLY; path equals home (absolute), and
    // nothing is written into the project — the agent builds from the home copy.
    expect(body.home).toBe(join(homeSessionDir(session.id), body.home.split("/").pop() as string));
    expect(body.path).toBe(body.home);
    expect(existsSync(body.home)).toBeTrue();
    expect(existsSync(join(repo, ".otacon", "plans"))).toBeFalse();

    // The wake-up carries the implement flag plus path=home.
    const event = await app.request(`/api/sessions/${session.id}/events`);
    expect(await event.json()).toEqual({
      event: "approved",
      session: session.id,
      path: body.path,
      home: body.home,
      implement: true,
    });
  });

  test("plain approve (no flag / implement:false) flips to approved and queues no flag", async () => {
    const noFlag = mintSession();
    await submitValid(noFlag.id);
    const a = await approve(noFlag.id);
    const aBody = (await a.json()) as { implement: boolean; path: string; home: string };
    expect(aBody.implement).toBe(false);
    expect(await statusOf(noFlag.id)).toBe("approved");
    const aEvent = await app.request(`/api/sessions/${noFlag.id}/events`);
    expect(await aEvent.json()).toEqual({
      event: "approved",
      session: noFlag.id,
      path: expect.stringMatching(/^\.otacon\/plans\//),
      home: aBody.home,
    });

    const falseFlag = mintSession();
    await submitValid(falseFlag.id);
    const b = await approve(falseFlag.id, { implement: false });
    expect(((await b.json()) as { implement: boolean }).implement).toBe(false);
    expect(await statusOf(falseFlag.id)).toBe("approved");
    const bEvent = await app.request(`/api/sessions/${falseFlag.id}/events`);
    const bPayload = (await bEvent.json()) as Record<string, unknown>;
    expect(bPayload).not.toHaveProperty("implement");
  });

  test("approve validates implement is a boolean", async () => {
    const session = mintSession();
    await submitValid(session.id);
    const res = await approve(session.id, { implement: "yes" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_BAD_REQUEST");
  });

  test("mutating verbs stay open while implementing, then refuse once terminal", async () => {
    const session = mintSession();
    await submitValid(session.id);
    expect((await approve(session.id, { implement: true })).status).toBe(200);
    await app.request(`/api/sessions/${session.id}/events`); // drain the wake-up

    // While implementing, the agent keeps narrating and asking.
    expect((await postJson(`/api/sessions/${session.id}/progress`, { note: "phase 1" })).status).toBe(200);
    const asked = await postJson(`/api/sessions/${session.id}/ask`, { question: "retry or skip?" });
    expect(asked.status).toBe(201);

    // Build finishes → implemented (terminal): every mutating verb now refuses.
    expect((await implementDone(session.id, { pr: "https://example.test/pr/1" })).status).toBe(200);
    expect(await statusOf(session.id)).toBe("implemented");
    const attempts: [string, Response | Promise<Response>][] = [
      ["progress", postJson(`/api/sessions/${session.id}/progress`, { note: "x" })],
      ["ask", postJson(`/api/sessions/${session.id}/ask`, { question: "x" })],
      ["comments", postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "x" }] })],
    ];
    for (const [verb, pending] of attempts) {
      const res = await pending;
      expect(res.status, `${verb} should 409 once implemented`).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code, verb).toBe(
        "E_SESSION_OVER",
      );
    }
  });

  test("implement_failed is terminal too — mutating verbs refuse", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await approve(session.id, { implement: true });
    expect((await implementDone(session.id, { failed: true })).status).toBe(200);
    expect(await statusOf(session.id)).toBe("implement_failed");
    const res = await postJson(`/api/sessions/${session.id}/progress`, { note: "x" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_SESSION_OVER");
  });

  test("a second approve on an implementing session is refused E_ALREADY_IMPLEMENTING", async () => {
    const session = mintSession();
    await submitValid(session.id);
    expect((await approve(session.id, { implement: true })).status).toBe(200);
    const again = await approve(session.id, { implement: true });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      "E_ALREADY_IMPLEMENTING",
    );
    // A plain re-approve is refused the same way.
    const plain = await approve(session.id);
    expect(plain.status).toBe(409);
    expect(((await plain.json()) as { error: { code: string } }).error.code).toBe(
      "E_ALREADY_IMPLEMENTING",
    );
  });

  test("implement-done records the PR url, visible in the summary frame", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await approve(session.id, { implement: true });

    const reader = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    expect((await reader.next()).event).toBe("snapshot");

    const res = await implementDone(session.id, { pr: "https://example.test/pr/42" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      status: string;
      prUrl?: string;
      session: { status: string; prUrl?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("implemented");
    expect(body.prUrl).toBe("https://example.test/pr/42");
    expect(body.session.status).toBe("implemented");
    expect(body.session.prUrl).toBe("https://example.test/pr/42");

    // The live session frame carries the flipped chip + the PR link.
    const frame = await reader.next();
    expect(frame.event).toBe("session");
    const summary = (frame.data as { session: { status: string; prUrl?: string } }).session;
    expect(summary.status).toBe("implemented");
    expect(summary.prUrl).toBe("https://example.test/pr/42");
    await reader.cancel();

    // It persists on the registry session (and re-reads via the detail route).
    expect(store.getSession(session.id)?.prUrl).toBe("https://example.test/pr/42");
    const detail = (await (await app.request(`/api/sessions/${session.id}`)).json()) as {
      prUrl?: string;
    };
    expect(detail.prUrl).toBe("https://example.test/pr/42");
  });

  test("implement-done {failed:true} flips to implement_failed; no pr is fine", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await approve(session.id, { implement: true });
    const res = await implementDone(session.id, { failed: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; prUrl?: string };
    expect(body.status).toBe("implement_failed");
    expect(body.prUrl).toBeUndefined();
    expect(store.getSession(session.id)?.prUrl).toBeUndefined();
  });

  test("implement-done on a non-implementing session 409s E_NOT_IMPLEMENTING", async () => {
    // Fresh draft: never implementing.
    const draft = mintSession();
    const onDraft = await implementDone(draft.id, { pr: "https://example.test/pr/1" });
    expect(onDraft.status).toBe(409);
    expect(((await onDraft.json()) as { error: { code: string } }).error.code).toBe(
      "E_NOT_IMPLEMENTING",
    );

    // Plain-approved (terminal, never entered implementing) is refused too.
    const approved = mintSession();
    await submitValid(approved.id);
    await approve(approved.id);
    const onApproved = await implementDone(approved.id, { failed: true });
    expect(onApproved.status).toBe(409);
    expect(((await onApproved.json()) as { error: { code: string } }).error.code).toBe(
      "E_NOT_IMPLEMENTING",
    );

    // Unknown session 404s before the status check.
    expect((await implementDone("otc_zzzzzz", {})).status).toBe(404);
  });

  test("a double implement-done refuses the second call", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await approve(session.id, { implement: true });
    expect((await implementDone(session.id, { pr: "https://example.test/pr/1" })).status).toBe(200);
    const second = await implementDone(session.id, { pr: "https://example.test/pr/2" });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      "E_NOT_IMPLEMENTING",
    );
    // The second call never overwrote the first PR url.
    expect(store.getSession(session.id)?.prUrl).toBe("https://example.test/pr/1");
  });

  test("implement-done validates pr is a non-empty string and failed is a boolean", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await approve(session.id, { implement: true });
    expect((await implementDone(session.id, { pr: "   " })).status).toBe(400);
    expect((await implementDone(session.id, { pr: 7 })).status).toBe(400);
    expect((await implementDone(session.id, { failed: "yes" })).status).toBe(400);
    // The session is still implementing — a rejected report changed nothing.
    expect(await statusOf(session.id)).toBe("implementing");
  });

  test("approve {implement:true} records the build worktree + branch on the session", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await approve(session.id, { implement: true });

    // slugify("e2e plan") === "e2e-plan"; the worktree dir defaults to
    // ~/.otacon/worktrees, so the recorded path ends in the slug and the
    // branch follows otacon/impl-<slug>.
    const impl = store.getSession(session.id)?.impl;
    expect(impl).toBeDefined();
    expect(impl?.worktree.endsWith("e2e-plan")).toBeTrue();
    expect(impl?.branch).toBe("otacon/impl-e2e-plan");

    // It surfaces on the detail route too.
    const detail = (await (await app.request(`/api/sessions/${session.id}`)).json()) as {
      impl?: { worktree: string; branch: string };
    };
    expect(detail.impl?.branch).toBe("otacon/impl-e2e-plan");
  });

  test("a plain approve (Save) records no impl", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await approve(session.id);
    expect(store.getSession(session.id)?.impl).toBeUndefined();
  });
});

describe("reopen a terminal session (resurrect-plan-amend)", () => {
  const submitValid = async (id: string) => {
    const res = await app.request(`/api/sessions/${id}/submit`, {
      method: "POST",
      body: validPlanFor(id),
    });
    expect(res.status).toBe(200);
  };
  const approve = (id: string, body: unknown = {}) =>
    postJson(`/api/sessions/${id}/approve`, body);
  const implementDone = (id: string, body: unknown = {}) =>
    postJson(`/api/sessions/${id}/implement-done`, body);
  const reopen = (id: string) => postJson(`/api/sessions/${id}/reopen`, {});
  const statusOf = async (id: string): Promise<string> =>
    ((await (await app.request(`/api/sessions/${id}`)).json()) as { status: string }).status;

  test("reopen flips an implemented session back to revising and keeps impl", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await approve(session.id, { implement: true });
    await implementDone(session.id, { pr: "https://example.test/pr/7" });
    expect(await statusOf(session.id)).toBe("implemented");

    const revisionBefore = store.readState(session.id).revision;
    const res = await reopen(session.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      status: string;
      revision: number;
      lastReviewedRevision: number;
      impl: { worktree: string; branch: string } | null;
      prUrl: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("revising");
    // Revision is unchanged; the baseline is pinned at the approved revision.
    expect(body.revision).toBe(revisionBefore);
    expect(body.lastReviewedRevision).toBe(revisionBefore);
    expect(store.readState(session.id).lastReviewedRevision).toBe(revisionBefore);
    expect(store.readState(session.id).revision).toBe(revisionBefore);
    // impl survives the reopen.
    expect(body.impl?.branch).toBe("otacon/impl-e2e-plan");
    expect(store.getSession(session.id)?.impl?.branch).toBe("otacon/impl-e2e-plan");
    // The session is back to active (revising), mutating verbs re-open.
    expect(await statusOf(session.id)).toBe("revising");
  });

  test("reopen preserves prUrl set at implement-done", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await approve(session.id, { implement: true });
    await implementDone(session.id, { pr: "https://example.test/pr/99" });
    expect(store.getSession(session.id)?.prUrl).toBe("https://example.test/pr/99");

    const res = await reopen(session.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prUrl: string | null };
    expect(body.prUrl).toBe("https://example.test/pr/99");
    // It is still on the registry session after the flip.
    expect(store.getSession(session.id)?.prUrl).toBe("https://example.test/pr/99");
  });

  test("reopen works on a plain-approved (terminal, Save) session too", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await approve(session.id);
    expect(await statusOf(session.id)).toBe("approved");
    const res = await reopen(session.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("revising");
    expect(await statusOf(session.id)).toBe("revising");
  });

  test("reopen refuses a non-terminal session with E_NOT_REOPENABLE", async () => {
    const session = mintSession();
    await submitValid(session.id);
    // in_review (the default after a first submit) is non-terminal.
    expect(await statusOf(session.id)).toBe("in_review");
    const res = await reopen(session.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "E_NOT_REOPENABLE",
    );
    // Unchanged: the refusal mutated nothing.
    expect(await statusOf(session.id)).toBe("in_review");
  });

  test("reopen 404s an unknown session", async () => {
    expect((await reopen("otc_zzzzzz")).status).toBe(404);
  });
});

describe("comment & approve: send-to-agent deferred finalize (comment-and-approve)", () => {
  const submitValid = async (id: string) => {
    const res = await app.request(`/api/sessions/${id}/submit`, { method: "POST", body: validPlanFor(id) });
    expect(res.status).toBe(200);
  };
  const approve = (id: string, body: unknown = {}) => postJson(`/api/sessions/${id}/approve`, body);
  const statusOf = async (id: string): Promise<string> =>
    ((await (await app.request(`/api/sessions/${id}`)).json()) as { status: string }).status;
  // r1 plus one open comment thread t1, anchored in phase-1; the wake-up drained.
  const r1WithOpenComment = async (id: string) => {
    await submitValid(id);
    const res = await postJson(`/api/sessions/${id}/comments`, {
      items: [
        { anchor: { section: "phase-1", exact: "RS256 JWTs from the auth service" }, body: "why not ES256?" },
      ],
    });
    expect(res.status).toBe(202);
    await app.request(`/api/sessions/${id}/events`); // drain the comment wake-up
  };
  // The agent's fold-in pass: resolve t1 with a changelog (a clean r2 submit).
  const foldInSubmit = (id: string) =>
    postJson(`/api/sessions/${id}/submit`, {
      plan: validPlanFor(id),
      resolutions: {
        changelog: "Addressed the open comment.",
        threads: { t1: "Kept RS256 — verifiers only need the public key." },
      },
    });

  test("send-to-agent defers: flips to finalizing and queues a final:true comments batch", async () => {
    const session = mintSession();
    await r1WithOpenComment(session.id);

    const res = await approve(session.id, { sendOpenComments: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { finalizing: boolean; sent: string[]; implement: boolean };
    expect(body.finalizing).toBe(true);
    expect(body.sent).toEqual(["t1"]);
    expect(body.implement).toBe(false);
    // Non-terminal: the agent's submit must still mutate.
    expect(await statusOf(session.id)).toBe("finalizing");
    expect(store.readState(session.id).pendingApproval).toEqual({ implement: false, threads: ["t1"] });

    // The wake-up is a comments batch carrying the open thread, marked final.
    const event = await app.request(`/api/sessions/${session.id}/events`);
    const payload = (await event.json()) as {
      event: string;
      final?: boolean;
      items: { thread: string; anchor: unknown; body: string }[];
    };
    expect(payload.event).toBe("comments");
    expect(payload.final).toBe(true);
    expect(payload.items).toEqual([
      {
        thread: "t1",
        anchor: { section: "phase-1", exact: "RS256 JWTs from the auth service" },
        body: "why not ES256?",
      },
    ]);
  });

  test("the agent's clean fold-in submit finalizes to approved with ## Review notes", async () => {
    const session = mintSession();
    await r1WithOpenComment(session.id);
    await approve(session.id, { sendOpenComments: true });
    await app.request(`/api/sessions/${session.id}/events`); // drain the final batch

    const res = await foldInSubmit(session.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      finalized: boolean;
      status: string;
      path: string;
      home: string;
    };
    expect(body.finalized).toBe(true);
    expect(body.status).toBe("approved");
    expect(await statusOf(session.id)).toBe("approved");
    expect(store.readState(session.id).pendingApproval).toBeUndefined();
    // Save writes the project copy under plans.dir and the canonical home copy.
    expect(body.path).toMatch(/^\.otacon\/plans\//);
    expect(body.home).toBe(join(homeSessionDir(session.id), body.path.split("/").pop() as string));

    const artifact = readFileSync(join(repo, body.path), "utf8");
    expect(artifact).toContain("status: approved");
    expect(artifact).toContain("## Review notes");
    expect(artifact).toContain("### t1 — phase-1");
    expect(artifact).toContain("> why not ES256?");
    expect(artifact).toContain("Kept RS256 — verifiers only need the public key.");

    // The agent then drains the approved wake-up — a plain Save (otacon never commits).
    const event = await app.request(`/api/sessions/${session.id}/events`);
    expect(await event.json()).toEqual({
      event: "approved",
      session: session.id,
      path: body.path,
      home: body.home,
    });
  });

  test("send + Implement carries the implement choice through the finalize", async () => {
    const session = mintSession();
    await r1WithOpenComment(session.id);
    const sent = await approve(session.id, { sendOpenComments: true, implement: true });
    expect(((await sent.json()) as { implement: boolean }).implement).toBe(true);
    expect(store.readState(session.id).pendingApproval).toEqual({ implement: true, threads: ["t1"] });
    await app.request(`/api/sessions/${session.id}/events`); // drain the final batch

    const res = await foldInSubmit(session.id);
    const body = (await res.json()) as { status: string; path: string; home: string };
    expect(body.status).toBe("implementing");
    expect(await statusOf(session.id)).toBe("implementing");
    // Implement: path equals the home copy; no project copy is written.
    expect(body.path).toBe(body.home);

    // The wake-up flows straight into the build loop (implement:true).
    const event = await app.request(`/api/sessions/${session.id}/events`);
    expect(await event.json()).toEqual({
      event: "approved",
      session: session.id,
      path: body.path,
      home: body.home,
      implement: true,
    });
  });

  test("E_UNRESOLVED_THREADS carries the open-comment count for the warn stage", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await postJson(`/api/sessions/${session.id}/comments`, { items: [{ body: "open comment" }] });
    await postJson(`/api/sessions/${session.id}/questions`, { body: "open question" });
    const res = await approve(session.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string };
      unresolved: number;
      openComments: number;
    };
    expect(body.error.code).toBe("E_UNRESOLVED_THREADS");
    expect(body.unresolved).toBe(2); // comment + question
    expect(body.openComments).toBe(1); // only the comment is foldable
  });

  test('"commit anyway" finalizes now and drops threads — no Review notes', async () => {
    const session = mintSession();
    await r1WithOpenComment(session.id);
    const res = await approve(session.id, { force: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(await statusOf(session.id)).toBe("approved");
    const artifact = readFileSync(join(repo, body.path), "utf8");
    expect(artifact).not.toContain("## Review notes"); // a force drop addresses nothing
  });

  test("sendOpenComments with only open questions falls through to the warning", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await postJson(`/api/sessions/${session.id}/questions`, { body: "open question" });
    const res = await approve(session.id, { sendOpenComments: true });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string }; openComments: number };
    expect(body.error.code).toBe("E_UNRESOLVED_THREADS");
    expect(body.openComments).toBe(0); // nothing to fold in
    expect(await statusOf(session.id)).not.toBe("finalizing"); // unchanged
  });

  test("a hung finalize is escapable: commit anyway mid-finalize force-drops", async () => {
    const session = mintSession();
    await r1WithOpenComment(session.id);
    await approve(session.id, { sendOpenComments: true });
    expect(await statusOf(session.id)).toBe("finalizing");
    await app.request(`/api/sessions/${session.id}/events`); // drain the final batch

    // "Finalize anyway" (force) while finalizing writes the current revision now.
    const res = await approve(session.id, { force: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(await statusOf(session.id)).toBe("approved");
    expect(store.readState(session.id).pendingApproval).toBeUndefined();
    const artifact = readFileSync(join(repo, body.path), "utf8");
    expect(artifact).not.toContain("## Review notes"); // force-dropped, never folded in
  });

  test("the force escape mid-finalize honors the original Implement choice", async () => {
    const session = mintSession();
    await r1WithOpenComment(session.id);
    await approve(session.id, { sendOpenComments: true, implement: true });
    await app.request(`/api/sessions/${session.id}/events`);
    // Force with no implement flag — the pendingApproval choice wins.
    const res = await approve(session.id, { force: true });
    expect(((await res.json()) as { implement: boolean }).implement).toBe(true);
    expect(await statusOf(session.id)).toBe("implementing");
  });

  test("a second send-to-agent while finalizing is refused E_ALREADY_FINALIZING", async () => {
    const session = mintSession();
    await r1WithOpenComment(session.id);
    await approve(session.id, { sendOpenComments: true });
    await app.request(`/api/sessions/${session.id}/events`);
    const again = await approve(session.id, { sendOpenComments: true });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      "E_ALREADY_FINALIZING",
    );
    // A plain approve (no force) is refused the same way.
    const plain = await approve(session.id);
    expect(((await plain.json()) as { error: { code: string } }).error.code).toBe(
      "E_ALREADY_FINALIZING",
    );
    expect(await statusOf(session.id)).toBe("finalizing"); // unchanged
  });

  test("a comment while finalizing is refused E_ALREADY_FINALIZING (status and pendingApproval intact)", async () => {
    const session = mintSession();
    await r1WithOpenComment(session.id);
    await approve(session.id, { sendOpenComments: true });
    await app.request(`/api/sessions/${session.id}/events`); // drain the final batch

    // A new comment landing mid-finalize must not flip status back to revising
    // (which would leave pendingApproval armed and silently finalize a later
    // clean submit) nor hand the agent an un-swept thread that wedges L5.
    const res = await postJson(`/api/sessions/${session.id}/comments`, {
      items: [{ anchor: null, body: "one more thought" }],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "E_ALREADY_FINALIZING",
    );
    expect(await statusOf(session.id)).toBe("finalizing"); // unchanged
    expect(store.readState(session.id).pendingApproval).toEqual({ implement: false, threads: ["t1"] });
  });

  test("approve validates sendOpenComments is a boolean", async () => {
    const session = mintSession();
    await submitValid(session.id);
    const res = await approve(session.id, { sendOpenComments: "yes" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_BAD_REQUEST");
  });

  test("a submit cannot land while implementing (double-finalize race guard)", async () => {
    const session = mintSession();
    await submitValid(session.id);
    await approve(session.id, { implement: true });
    const res = await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: validPlanFor(session.id),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "E_ALREADY_IMPLEMENTING",
    );
  });
});

describe("DELETE /api/sessions/:id (otacon clean, M5)", () => {
  test("404 on an unknown session", async () => {
    const res = await app.request("/api/sessions/otc_nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("deregisters an approved session, removes its home dir, and reports pending events", async () => {
    const session = mintSession();
    await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: validPlanFor(session.id),
    });
    const approved = await postJson(`/api/sessions/${session.id}/approve`, { force: true });
    expect(approved.status).toBe(200);

    const res = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.repo).toBe(repo);
    expect(body.pendingEvents).toBe(1); // the undrained `approved` event
    // No archive in the response; the home folder is removed outright.
    expect(body).not.toHaveProperty("archivedTo");

    expect(store.getSession(session.id)).toBeUndefined();
    const detail = await app.request(`/api/sessions/${session.id}`);
    expect(detail.status).toBe(404);
    // The home dir is gone for good; nothing is moved into .otacon/archive/.
    expect(existsSync(sessionDir(session.id))).toBe(false);
    expect(existsSync(revisionPath(session.id, 1))).toBe(false);
    expect(existsSync(join(repo, ".otacon", "archive"))).toBe(false);
  });

  test("removes an implemented session's home dir too (no archive)", async () => {
    // A finished build (implemented/implement_failed) is terminal, but delete is
    // now uniform: its home folder is removed outright. The durable copy survives
    // elsewhere (the saved plan / PR), not under .otacon/archive/.
    const session = mintSession();
    await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: validPlanFor(session.id),
    });
    await postJson(`/api/sessions/${session.id}/approve`, { force: true, implement: true });
    await postJson(`/api/sessions/${session.id}/implement-done`, {});
    expect(store.getSession(session.id)?.status).toBe("implemented");

    const res = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("archivedTo");
    expect(existsSync(sessionDir(session.id))).toBe(false);
    expect(existsSync(join(repo, ".otacon", "archive"))).toBe(false);
  });

  test("deletion publishes a `removed` frame on the index and per-session streams", async () => {
    const session = mintSession();
    await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: validPlanFor(session.id),
    });
    await postJson(`/api/sessions/${session.id}/approve`, { force: true });

    // Subscribe both streams before the delete; drain their snapshots.
    const index = sseReader(await app.request("/api/stream"));
    expect((await index.next()).event).toBe("snapshot");
    const own = sseReader(await app.request(`/api/sessions/${session.id}/stream`));
    expect((await own.next()).event).toBe("snapshot");

    const res = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(await index.next()).toEqual({
      event: "removed",
      data: { session: session.id },
    });
    expect(await own.next()).toEqual({
      event: "removed",
      data: { session: session.id },
    });
    // `removed` is terminal for the per-session stream: the daemon ends it,
    // so a client that ignores the frame can't pin the connection forever.
    await expect(own.next()).rejects.toThrow("SSE stream ended unexpectedly");
    // The index stream stays open: other sessions keep flowing over it.
    const survivor = (await (await postJson("/api/sessions", { title: "live", repo })).json()) as {
      id: string;
    };
    const frame = await index.next();
    expect(frame.event).toBe("session");
    expect((frame.data as { session: { id: string } }).session.id).toBe(survivor.id);
    await index.cancel();
  });
});

describe("DELETE a pending session (delete-pending-session)", () => {
  test("deregisters a pending session and permanently removes its home dir (no archive)", async () => {
    const session = mintSession();
    await app.request(`/api/sessions/${session.id}/submit`, {
      method: "POST",
      body: validPlanFor(session.id),
    });
    expect(existsSync(sessionDir(session.id))).toBe(true);

    const res = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.repo).toBe(repo);
    expect(body).not.toHaveProperty("archivedTo");

    expect(store.getSession(session.id)).toBeUndefined();
    const detail = await app.request(`/api/sessions/${session.id}`);
    expect(detail.status).toBe(404);
    // Permanent delete: the home dir is gone and nothing was moved into
    // .otacon/archive/.
    expect(existsSync(sessionDir(session.id))).toBe(false);
    expect(existsSync(join(repo, ".otacon", "archive"))).toBe(false);
  });

  test("wakes a parked agent with a terminal {event:\"deleted\"} the moment it is deleted", async () => {
    const session = mintSession();
    const parked = app.request(`/api/sessions/${session.id}/events?wait=5`);
    await sleep(20); // let the handler reach park()

    const res = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const payload = (await (await parked).json()) as { event: string; session: string };
    expect(payload.event).toBe("deleted");
    expect(payload.session).toBe(session.id);
    expect(store.getSession(session.id)).toBeUndefined();
    expect(existsSync(sessionDir(session.id))).toBe(false);
  });

  test("publishes a terminal `removed` frame on the index stream", async () => {
    const session = mintSession();
    const index = sseReader(await app.request("/api/stream"));
    expect((await index.next()).event).toBe("snapshot");

    const res = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await index.next()).toEqual({ event: "removed", data: { session: session.id } });
    await index.cancel();
  });
});

describe("desktop attention notifications (M6)", () => {
  const submit = (id: string) =>
    app.request(`/api/sessions/${id}/submit`, { method: "POST", body: validPlanFor(id) });
  const ask = (id: string, body: unknown) => postJson(`/api/sessions/${id}/ask`, body);
  const presencePost = (id: string, visible: unknown) =>
    postJson(`/api/sessions/${id}/presence`, { visible });
  const reviewUrl = (id: string) => `http://127.0.0.1:${otaconPort()}/s/${id}`;

  test("a submitted revision fires a 'ready for review' banner", async () => {
    const session = mintSession();
    expect((await submit(session.id)).status).toBe(200);
    expect(notifyCalls).toEqual([
      { title: session.title, message: "Revision r1 ready for review", url: reviewUrl(session.id) },
    ]);
  });

  test("a grill question fires a banner carrying the question text", async () => {
    const session = mintSession();
    await ask(session.id, { question: "RS256 or HS256?", options: ["RS256", "HS256"] });
    expect(notifyCalls).toEqual([
      { title: session.title, message: "RS256 or HS256?", url: reviewUrl(session.id) },
    ]);
  });

  test("a batch of questions coalesces to one 'N questions' banner", async () => {
    const session = mintSession();
    await ask(session.id, {
      questions: [{ question: "a?" }, { question: "b?" }, { question: "c?" }],
    });
    expect(notifyCalls).toEqual([
      { title: session.title, message: "3 questions need your answer", url: reviewUrl(session.id) },
    ]);
  });

  test("a single-member batch reads as one question, not '1 questions'", async () => {
    const session = mintSession();
    await ask(session.id, { questions: [{ question: "lone?" }] });
    expect(notifyCalls[0]?.message).toBe("lone?");
  });

  test("a long question snippet is truncated to 80 chars with an ellipsis", async () => {
    const session = mintSession();
    await ask(session.id, { question: "x".repeat(200) });
    expect(notifyCalls[0]?.message).toBe(`${"x".repeat(79)}…`);
    expect(notifyCalls[0]?.message.length).toBe(80);
  });

  test("suppressed while the review is visible (ask and submit alike)", async () => {
    const session = mintSession();
    expect((await presencePost(session.id, true)).status).toBe(200);
    await ask(session.id, { question: "anybody home?" });
    await submit(session.id);
    expect(notifyCalls).toEqual([]);
  });

  test("an explicit hidden ping un-suppresses immediately", async () => {
    const session = mintSession();
    await presencePost(session.id, true);
    await presencePost(session.id, false);
    await ask(session.id, { question: "back now?" });
    expect(notifyCalls).toHaveLength(1);
  });

  test("a crashed visible tab self-expires after the TTL; banners fire again", async () => {
    // A hand-cranked clock makes expiry deterministic, never wall-time-bound.
    let t = 1000;
    const calls: DesktopNotification[] = [];
    const ownApp = createApp({
      store,
      uiDir,
      notify: (n) => calls.push(n),
      presence: new Presence(() => t, 45_000),
    });
    const session = mintSession();
    const post = (path: string, body: unknown) =>
      ownApp.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post(`/api/sessions/${session.id}/presence`, { visible: true });
    await post(`/api/sessions/${session.id}/ask`, { question: "still watching?" });
    expect(calls).toEqual([]); // visible → suppressed
    t += 45_001; // the tab crashed; its last heartbeat went stale
    await post(`/api/sessions/${session.id}/ask`, { question: "now?" });
    expect(calls).toHaveLength(1);
  });

  test("silent when notifications.desktop is configured off in the repo", async () => {
    mkdirSync(join(repo, ".otacon"), { recursive: true });
    writeFileSync(
      repoLocalConfigPath(repo),
      JSON.stringify({ notifications: { desktop: false } }),
    );
    const session = mintSession();
    await ask(session.id, { question: "anything?" });
    await submit(session.id);
    expect(notifyCalls).toEqual([]);
  });

  test("presence validation: visible must be a boolean; unknown session 404s", async () => {
    const session = mintSession();
    expect((await presencePost(session.id, "yes")).status).toBe(400);
    expect((await presencePost(session.id, undefined)).status).toBe(400);
    expect((await presencePost("otc_zzzzzz", true)).status).toBe(404);
  });

  test("audit: an attention moment writes a notify dispatch line", async () => {
    const session = mintSession();
    const log = await captureStderr(async () => {
      await ask(session.id, { question: "RS256 or HS256?", options: ["RS256", "HS256"] });
    });
    expect(log).toContain(
      `otacond: notify dispatch session=${session.id} kind=question title=${JSON.stringify(session.title)} message=${JSON.stringify("RS256 or HS256?")}\n`,
    );
  });

  test("audit: a config-disabled repo writes reason=config-disabled and fires no notify", async () => {
    mkdirSync(join(repo, ".otacon"), { recursive: true });
    writeFileSync(
      repoLocalConfigPath(repo),
      JSON.stringify({ notifications: { desktop: false } }),
    );
    const session = mintSession();
    const log = await captureStderr(async () => {
      await ask(session.id, { question: "anything?" });
    });
    expect(log).toContain(
      `otacond: notify skip session=${session.id} reason=config-disabled\n`,
    );
    expect(notifyCalls).toEqual([]);
  });

  test("audit: a watched session writes reason=watched", async () => {
    const session = mintSession();
    expect((await presencePost(session.id, true)).status).toBe(200);
    const log = await captureStderr(async () => {
      await ask(session.id, { question: "anybody home?" });
    });
    expect(log).toContain(`otacond: notify skip session=${session.id} reason=watched\n`);
  });
});

describe("config API", () => {
  type ScopeView = { path: string; values: Record<string, Record<string, unknown>>; repo?: string };
  type ConfigGet = {
    schema: unknown[];
    scopes: { user?: ScopeView; project?: ScopeView; "project.local"?: ScopeView };
  };

  test("GET with no repo returns only the user scope plus the schema", async () => {
    const res = await app.request("/api/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigGet;
    expect(Array.isArray(body.schema)).toBe(true);
    expect(body.schema.length).toBeGreaterThan(0);
    expect(body.scopes.user).toBeDefined();
    expect(body.scopes.user?.path).toBe(globalConfigPath());
    expect(body.scopes.project).toBeUndefined();
    expect(body.scopes["project.local"]).toBeUndefined();
  });

  test("GET with a repo returns user + project + project.local scopes with their paths and values", async () => {
    mkdirSync(join(repo, ".otacon"), { recursive: true });
    writeFileSync(repoConfigPath(repo), JSON.stringify({ budgets: { summaryLines: 9 } }));
    writeFileSync(
      repoLocalConfigPath(repo),
      JSON.stringify({ budgets: { summaryLines: 11 } }),
    );
    const res = await app.request(`/api/config?repo=${encodeURIComponent(repo)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigGet;
    expect(body.scopes.user?.path).toBe(globalConfigPath());
    // Committed project config → config.json.
    expect(body.scopes.project?.path).toBe(repoConfigPath(repo));
    expect(body.scopes.project?.repo).toBe(repo);
    expect(body.scopes.project?.values).toEqual({ budgets: { summaryLines: 9 } });
    // Personal override → config.local.json.
    expect(body.scopes["project.local"]?.path).toBe(repoLocalConfigPath(repo));
    expect(body.scopes["project.local"]?.repo).toBe(repo);
    expect(body.scopes["project.local"]?.values).toEqual({ budgets: { summaryLines: 11 } });
  });

  test("POST scope=user writes ONLY the provided field; a follow-up GET echoes it", async () => {
    const res = await postJson("/api/config", { scope: "user", values: { budgets: { summaryLines: 8 } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ values: { budgets: { summaryLines: 8 } } });
    // The file holds only summaryLines — nothing else leaked in.
    const onDisk = JSON.parse(readFileSync(globalConfigPath(), "utf8")) as unknown;
    expect(onDisk).toEqual({ budgets: { summaryLines: 8 } });
    const get = (await (await app.request("/api/config")).json()) as ConfigGet;
    expect(get.scopes.user?.values).toEqual({ budgets: { summaryLines: 8 } });
  });

  test("POST with an out-of-range int → 422 field error, file not written", async () => {
    const res = await postJson("/api/config", { scope: "user", values: { budgets: { summaryLines: 0 } } });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      fieldErrors: Array<{ section: string; key: string; message: string }>;
    };
    expect(body.fieldErrors).toEqual([
      { section: "budgets", key: "summaryLines", message: expect.any(String) },
    ]);
    expect(existsSync(globalConfigPath())).toBe(false);
  });

  test("POST scope=project with no repo → 400, nothing written", async () => {
    const res = await postJson("/api/config", { scope: "project", values: { budgets: { summaryLines: 8 } } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("E_BAD_REQUEST");
    expect(existsSync(repoConfigPath(repo))).toBe(false);
  });

  test("POST scope=project with a relative repo → 400, nothing written", async () => {
    const res = await postJson("/api/config", {
      scope: "project",
      repo: "not/absolute",
      values: { budgets: { summaryLines: 8 } },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("E_BAD_REQUEST");
  });

  test("POST with a missing/invalid scope → 400", async () => {
    expect((await postJson("/api/config", { values: {} })).status).toBe(400);
    expect((await postJson("/api/config", { scope: "global", values: {} })).status).toBe(400);
  });

  test("clearing a previously-set field (omitting it) removes it from the file", async () => {
    await postJson("/api/config", {
      scope: "user",
      values: { budgets: { summaryLines: 8, contractLines: 20 } },
    });
    // Re-submit without contractLines: replace, not merge → it reverts to inherited.
    const res = await postJson("/api/config", { scope: "user", values: { budgets: { summaryLines: 8 } } });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(globalConfigPath(), "utf8")) as {
      budgets: Record<string, unknown>;
    };
    expect(onDisk).toEqual({ budgets: { summaryLines: 8 } });
    expect("contractLines" in onDisk.budgets).toBe(false);
  });

  test("POST scope=project with a repo writes the committed <repo>/.otacon/config.json", async () => {
    const res = await postJson("/api/config", {
      scope: "project",
      repo,
      values: { notifications: { desktop: false } },
    });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(repoConfigPath(repo), "utf8")) as unknown;
    expect(onDisk).toEqual({ notifications: { desktop: false } });
  });

  test("POST scope=project.local writes the personal <repo>/.otacon/config.local.json", async () => {
    const res = await postJson("/api/config", {
      scope: "project.local",
      repo,
      values: { worktree: { dir: "local/wt" } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ values: { worktree: { dir: "local/wt" } } });
    const onDisk = JSON.parse(readFileSync(repoLocalConfigPath(repo), "utf8")) as unknown;
    expect(onDisk).toEqual({ worktree: { dir: "local/wt" } });
    // The committed project config is untouched by a project.local write.
    expect(existsSync(repoConfigPath(repo))).toBe(false);
  });

  test("POST scope=project.local with no repo → 400, nothing written", async () => {
    const res = await postJson("/api/config", {
      scope: "project.local",
      values: { worktree: { dir: "local/wt" } },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("E_BAD_REQUEST");
    expect(existsSync(repoLocalConfigPath(repo))).toBe(false);
  });

  test("a foreign-Origin POST /api/config is refused 403, file untouched", async () => {
    const res = await app.request("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ scope: "user", values: { budgets: { summaryLines: 8 } } }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("E_FORBIDDEN");
    expect(existsSync(globalConfigPath())).toBe(false);
  });
});
