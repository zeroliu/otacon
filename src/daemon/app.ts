// otacond's HTTP surface (review loop and daemon API), as a Hono app
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
import { canonicalizeGitHubRepo, parseKnowledgeHash } from "../shared/knowledge.js";
import type { KnowledgeTarget } from "../shared/knowledge.js";
import { parsePullRequestMetadata } from "../shared/review.js";
import { parseReviewQuizGrade } from "../shared/review-quiz.js";
import type { ReviewQuizAnswerEvent, ReviewQuizPublicState } from "../shared/review-quiz.js";
import type { ReviewReportRevisionPayload } from "../shared/review-report.js";
import {
  expandTilde,
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
  StreamEvent,
  Thread,
  TranscriptEntry,
  PublicReviewThread,
  ReviewThread,
  ReviewThreadEvent,
} from "../shared/types.js";
import { VERSION } from "../shared/version.js";
import { appendActivity, latestNote, readActivity } from "./activity.js";
import type { ReviewNote } from "./approve.js";
import { normalize } from "./capture/normalize.js";
import { appendStreamEvents, readStream, StreamSeq } from "./capture/stream-store.js";
import type { TailerDeps } from "./capture/tailer.js";
import { Tailer } from "./capture/tailer.js";
import { composeArtifact, localDate, pickHomePath, pickProjectRelPath } from "./approve.js";
import type { DesktopNotifier } from "./desktop-notify.js";
import { createDesktopNotifier } from "./desktop-notify.js";
import { validateDiagrams } from "./diagrams.js";
import { diffPlans } from "./diff.js";
import { lint } from "./linter/index.js";
import { slugify } from "./linter/parse.js";
import { InvalidKnowledgeMarkdownError, KnowledgeStore } from "./knowledge-store.js";
import { Notifier } from "./notify.js";
import { startPrPolling } from "./pr-status.js";
import { Presence } from "./presence.js";
import type { ParkHandle } from "./queue.js";
import { SessionQueue } from "./queue.js";
import {
  ReviewReportInvalidError,
  ReviewRevisionCorruptError,
  ReviewRevisionExistsError,
  ReviewStore,
} from "./review-store.js";
import {
  ReviewQuizConflictError,
  ReviewQuizCorruptError,
  ReviewQuizStore,
} from "./review-quiz-store.js";
import {
  createReviewThread,
  publicReviewThread,
  publicReviewThreads,
  readReviewThreads,
  requestReviewCodeAction,
  respondToReviewThread,
  ReviewThreadConflictError,
  updateReviewCodeAction,
} from "./review-threads.js";
import type { Store } from "./store.js";
import { writeFileAtomic } from "./store.js";
import {
  answerQuestion,
  appendThreads,
  applyRevisionToThreads,
  commentThreadStates,
  openCommentThreads,
  readThreads,
  resolveThread,
} from "./threads.js";
import { answerEntry, appendEntries, appendEntry, readTranscript } from "./transcript.js";
import { registerUiRoutes } from "./ui.js";
import { Viewers } from "./viewers.js";

/** Provided by @hono/node-server; absent under app.request() in tests. */
export interface NodeBindings {
  outgoing?: ServerResponse;
}

export interface AppOptions {
  store: Store;
  /** Test seam for the local user/project knowledge store. */
  knowledge?: KnowledgeStore;
  /** Test seam for immutable review reports and their frozen knowledge snapshots. */
  reviews?: ReviewStore;
  /** Test seam for durable quiz attempts and cognition updates. */
  quizzes?: ReviewQuizStore;
  /** Invoked once POST /api/shutdown's response is out; main.ts exits in it. */
  onShutdown?: () => void;
  /** Test override: where the built SPA lives (null = no UI). Default: resolved next to the module. */
  uiDir?: string | null;
  /** Test override for the SSE heartbeat interval. */
  sseHeartbeatMs?: number;
  /** Test override: visibility tracker (default: a fresh Presence with the 45s TTL). */
  presence?: Presence;
  /** Test override: the live-tab tracker (default: a fresh Viewers with the 90s TTL). */
  viewers?: Viewers;
  /** Test override: the desktop notify sink (default: the real macOS notifier, a no-op off darwin). */
  notify?: DesktopNotifier;
  /**
   * Test override: the per-session transcript tailer factory (default: the real
   * `Tailer`, polling the agent's transcript). A test can return a stub so the
   * suite never depends on real `~/.claude` contents or a live fs poll.
   */
  makeTailer?: (deps: TailerDeps) => { start(): void; stop(): void };
}

type AppContext = Context<{ Bindings: NodeBindings }>;

/** Hard ceiling on ?wait= (seconds); agents ask for 540 under their 600s Bash cap. */
const MAX_WAIT_SECONDS = 600;

const badRequest = (c: AppContext, message: string) =>
  c.json({ error: { code: "E_BAD_REQUEST", message } }, 400);
// A 400 that carries a specific machine code rather than the generic
// E_BAD_REQUEST — mirrors the coded 409s (E_NO_REVISION, E_UNRESOLVED_THREADS)
// so a caller can branch on the code, not parse the message.
const codedBadRequest = (c: AppContext, code: string, message: string) =>
  c.json({ error: { code, message } }, 400);
const notFound = (c: AppContext, message: string) =>
  c.json({ error: { code: "E_NOT_FOUND", message } }, 404);
const reviewRevisionUnavailable = (c: AppContext, message: string) =>
  c.json({ error: { code: "E_REVIEW_REVISION_UNAVAILABLE", message } }, 409);
const timeoutEvent = (c: AppContext) => c.json({ event: "timeout" });
// A session in a terminal state is over according to the status machine:
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

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

/** Review report selections always carry an exact quote and reject unknown wire keys. */
function parseReviewAnchor(raw: unknown): Anchor | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const keys = ["section", "exact", ...(value.prefix === undefined ? [] : ["prefix"]), ...(value.suffix === undefined ? [] : ["suffix"])];
  if (!hasExactKeys(value, keys)) return undefined;
  if (typeof value.section !== "string" || value.section.trim() === "" || value.section.length > 200 ||
    typeof value.exact !== "string" || value.exact.trim() === "" || value.exact.length > 10_000 ||
    (value.prefix !== undefined && (typeof value.prefix !== "string" || value.prefix.length > 1_000)) ||
    (value.suffix !== undefined && (typeof value.suffix !== "string" || value.suffix.length > 1_000))) return undefined;
  return {
    section: value.section,
    exact: value.exact,
    ...(value.prefix === undefined ? {} : { prefix: value.prefix as string }),
    ...(value.suffix === undefined ? {} : { suffix: value.suffix as string }),
  };
}

function parseReviewSource(raw: unknown): { reportRevision: number; headRevision: number; headSha: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!hasExactKeys(value, ["reportRevision", "headRevision", "headSha"]) ||
    !Number.isSafeInteger(value.reportRevision) || (value.reportRevision as number) < 1 ||
    !Number.isSafeInteger(value.headRevision) || (value.headRevision as number) < 1 ||
    typeof value.headSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.headSha)) return undefined;
  return value as unknown as { reportRevision: number; headRevision: number; headSha: string };
}

/**
 * Validate the submit body's `resolutions` (review loop and daemon API): an object with
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
  const knowledge = options.knowledge ?? new KnowledgeStore();
  const reviews = options.reviews ?? new ReviewStore(knowledge);
  const quizzes = options.quizzes ?? new ReviewQuizStore(reviews, knowledge);

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

  const sameQuizWork = (payload: EventPayload, event: ReviewQuizAnswerEvent): boolean => {
    if (typeof payload !== "object" || payload === null) return false;
    const candidate = payload as Partial<ReviewQuizAnswerEvent>;
    return candidate.event === "quiz-answer" &&
      candidate.session === event.session && candidate.revision === event.revision &&
      candidate.headRevision === event.headRevision && candidate.headSha === event.headSha &&
      candidate.question === event.question && candidate.attempt === event.attempt;
  };

  const reviewThreadEvent = (
    thread: ReviewThread,
    work: ReviewThreadEvent["work"],
  ): ReviewThreadEvent => ({
    event: "review-thread",
    work,
    session: thread.identity.session,
    thread: thread.id,
    reportRevision: thread.identity.reportRevision,
    headRevision: thread.identity.headRevision,
    headSha: thread.identity.headSha,
    anchor: thread.anchor,
    body: thread.body,
    ...(thread.remember === undefined ? {} : { remember: thread.remember }),
  });

  const sameReviewThreadWork = (payload: EventPayload, event: ReviewThreadEvent): boolean => {
    if (typeof payload !== "object" || payload === null) return false;
    const candidate = payload as Partial<ReviewThreadEvent>;
    return candidate.event === "review-thread" && candidate.work === event.work &&
      candidate.session === event.session && candidate.thread === event.thread &&
      candidate.reportRevision === event.reportRevision && candidate.headRevision === event.headRevision &&
      candidate.headSha === event.headSha;
  };

  const enqueueReviewThreadWork = (event: ReviewThreadEvent): number | undefined => {
    const queue = queueFor(event.session);
    if (queue.hasPayload((payload) => sameReviewThreadWork(payload, event))) return undefined;
    const seq = store.bumpCounter(event.session, "eventSeq");
    queue.enqueue(event, seq);
    return seq;
  };

  // A crash may land after the attempt's atomic state write but before queue
  // enqueue. Reconstruct from durable quiz state before any request/SSE can
  // observe this daemon: deterministic choices finish locally, while missing
  // open-answer work is appended once using its full immutable identity.
  for (const session of store.listSessions()) {
    if (session.kind !== "review" || TERMINAL_STATUSES.includes(session.status)) continue;
    try {
      const recovered = quizzes.recoverPending(session);
      const queue = queueFor(session.id);
      for (const event of recovered.events) {
        if (queue.hasPayload((payload) => sameQuizWork(payload, event))) continue;
        queue.enqueue(event, store.bumpCounter(session.id, "eventSeq"));
      }
    } catch {
      // Detail routes surface corrupt/stale quiz state with typed errors. One
      // damaged review must not prevent the daemon or other sessions starting.
    }
    try {
      for (const thread of readReviewThreads(store.threadsPath(session.id), session.id)) {
        // Once code work is explicitly requested it owns the eventual report
        // refresh/response. Do not resurrect an already-acked older
        // report-feedback wake after a restart and let it race the code result.
        if (thread.response === undefined && thread.codeAction === undefined) {
          enqueueReviewThreadWork(reviewThreadEvent(
            thread,
            thread.intent === "question" ? "question" : "report-feedback",
          ));
        }
        if (thread.codeAction?.status === "requested") {
          enqueueReviewThreadWork(reviewThreadEvent(thread, "code-change"));
        }
      }
    } catch {
      // A corrupt review thread file is quarantined by its reader. Other
      // sessions, quiz repair, and browser startup remain available.
    }
  }

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

  // Agent presence (review loop and daemon API): ephemeral, in-memory liveness only — the
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
  const safePendingQuizCount = (session: Extract<RegistrySession, { kind: "review" }>): number => {
    try {
      return quizzes.pendingCount(session);
    } catch {
      // Corruption is surfaced by the typed review/detail routes. One bad
      // local revision must not take down the daemon-wide session index.
      return 0;
    }
  };
  const safePublicQuiz = (session: Extract<RegistrySession, { kind: "review" }>): ReviewQuizPublicState | undefined => {
    const revision = reviews.latestSubmittedRevision(session.id);
    if (revision < 1) return undefined;
    try {
      return quizzes.publicState(session, revision);
    } catch {
      return undefined;
    }
  };
  const safePendingReviewWork = (session: Extract<RegistrySession, { kind: "review" }>): number => {
    try {
      return readReviewThreads(store.threadsPath(session.id), session.id).reduce((count, thread) => {
        const activeCodeAction = thread.codeAction?.status === "requested" || thread.codeAction?.status === "working";
        return count + (activeCodeAction ? 1 : thread.response === undefined ? 1 : 0);
      }, 0);
    } catch {
      return 0;
    }
  };
  const summarize = (session: RegistrySession): SessionSummary => {
    if (session.kind === "review") {
      return {
        ...session,
        // Report history owns its own revision axis. `session.review.revision`
        // remains the PR-head generation and may advance before a report lands.
        revision: reviews.latestSubmittedRevision(session.id),
        lastReviewedRevision: 0,
        pendingEvents: safePendingQuizCount(session) + safePendingReviewWork(session),
        openQuestions: 0,
        lastContactAt: lastContact.get(session.id),
        parked: queueFor(session.id).waiterCount > 0,
      };
    }
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
  const publishQueue = (id: string, pending: number): void => {
    const session = store.getSession(id);
    const effective = session?.kind === "review"
      ? safePendingQuizCount(session) + safePendingReviewWork(session)
      : pending;
    notifier.publish({ type: "queue", session: id, data: { session: id, pending: effective } });
  };
  const publishQuiz = (id: string, quiz: ReviewQuizPublicState): void =>
    notifier.publish({ type: "quiz", session: id, data: { session: id, quiz } });
  const publishThread = (id: string, thread: Thread | PublicReviewThread): void =>
    notifier.publish({ type: "thread", session: id, data: { session: id, thread } });
  const publishGrill = (id: string, entry: TranscriptEntry): void =>
    notifier.publish({ type: "grill", session: id, data: { session: id, entry } });
  const publishStream = (id: string, events: StreamEvent[]): void =>
    notifier.publish({ type: "stream", session: id, data: { session: id, events } });

  /** Replace the private immutable companion with its browser-safe live projection. */
  const publicReviewRevision = (
    session: Extract<RegistrySession, { kind: "review" }>,
    payload: ReviewReportRevisionPayload,
  ): ReviewReportRevisionPayload => payload.revision.status === "submitted"
    ? { ...payload, quiz: quizzes.publicState(session, payload.revision.revision) }
    : payload;

  // The PR poller refreshes un-settled PRs (timer + on-demand) and publishes any
  // state change so the home UI re-sections an implemented plan when its PR
  // merges or closes (see pr-status.ts). `pollNow` is kicked once at startup and
  // again whenever the index stream connects (the onConnect hook below).
  const prPoller = startPrPolling({
    listSessions: () => store.listSessions().filter((session) => session.kind === "plan"),
    updateSession: (id, patch) => store.updateSession(id, patch),
    publish: (id) => {
      const session = store.getSession(id);
      if (session) publishSession(session);
    },
  });
  void prPoller.pollNow(); // fire-and-forget: never blocks server creation

  // Monotonic per-session seq source for the live-activity stream (the
  // automatic, cross-agent activity stream): one StreamSeq per session id,
  // seeded lazily from stream.jsonl's max seq so a daemon restart never re-mints
  // a live seq, then incremented in memory. The daemon owns the single writer.
  const streamSeqs = new Map<string, StreamSeq>();
  const nextStreamSeq = (id: string): number => {
    let seq = streamSeqs.get(id);
    if (seq === undefined) {
      seq = new StreamSeq();
      streamSeqs.set(id, seq);
    }
    return seq.next(store.streamPath(id));
  };
  // How many newest stream events the per-session SSE snapshot serves: the
  // session's configured cap (so a repo override applies). The store already
  // bounds the file at the cap on append, so this is belt-and-suspenders — but
  // it keeps the snapshot honest if the cap was lowered since the last trim.
  const loadStreamCap = (id: string): number => {
    const repo = store.getSession(id)?.repo;
    return (repo ? loadConfig(repo) : loadConfig()).stream.cap;
  };

  // Per-session transcript tailers (the automatic, cross-agent activity stream):
  // while a session is active, its tailer watches the coding agent's own
  // transcript and feeds new tool/text/thinking activity through the SAME Phase
  // 1 pipeline the progress route uses — `nextStreamSeq` for the seq,
  // `appendStreamEvents` (capped), and `publishStream` for the SSE frame — so a
  // captured event and a manual `otacon progress` highlight are indistinguishable
  // downstream. A repo whose agent has no adapter attaches no tailer and runs on
  // the progress floor (the registry returns null). Tailers are injectable via
  // options.makeTailer so a test can drive `tick()` without a real fs poll.
  const tailers = new Map<string, { start(): void; stop(): void }>();
  const makeTailer = options.makeTailer ?? ((deps: TailerDeps) => new Tailer(deps));
  const startTailer = (session: RegistrySession): void => {
    if (tailers.has(session.id)) return; // idempotent — already watching
    if (TERMINAL_STATUSES.includes(session.status)) return; // over: nothing to tail
    const tailer = makeTailer({
      repoRoot: session.repo,
      nextSeq: () => nextStreamSeq(session.id),
      append: (events) => appendStreamEvents(store.streamPath(session.id), events, loadStreamCap(session.id)),
      publish: (events) => publishStream(session.id, events),
      config: () => loadConfig(session.repo).stream,
    });
    tailers.set(session.id, tailer);
    tailer.start();
  };
  const stopTailer = (id: string): void => {
    const tailer = tailers.get(id);
    if (tailer === undefined) return;
    tailer.stop();
    tailers.delete(id);
  };
  // Re-attach tailers to sessions that were already active when the daemon
  // started (a restart mid-build): the registry survives the restart, so the
  // live transcript is still being written. New sessions wire their tailer at
  // creation; terminal ones are skipped by startTailer's guard.
  for (const session of store.listSessions()) {
    if (session.kind === "plan") startTailer(session);
  }

  // Desktop attention banners (review loop and daemon API). Presence tracks which sessions
  // have a *visible* review open; the notify sink fires the native macOS banner
  // (a no-op off darwin). Both are injectable for tests.
  const presence = options.presence ?? new Presence();
  const notify = options.notify ?? createDesktopNotifier();

  // Live browser tabs watching this daemon (any session or the index), tracked
  // by an explicit SPA heartbeat with a TTL so `otacon open` can skip launching a
  // duplicate tab (DECISIONS.md "reuse an existing open tab"). A heartbeat rather
  // than an SSE-connection count because the dogfood daemon runs under Bun, whose
  // node:http does not detect a client disconnect, so a connection count leaks;
  // the TTL self-heals a closed/crashed tab under both Node and Bun. Ephemeral,
  // in-memory: a restart starts at 0, and live tabs re-beat on their next ping.
  const viewers = options.viewers ?? new Viewers();

  /**
   * Fire a desktop banner for an attention moment unless the user is already
   * watching this session's review (presence) or has disabled them (config,
   * loaded fresh per session.repo so a repo override applies). The whole thing
   * is wrapped: a spawn or config error must never break the submit/ask response
   * — it is swallowed to stderr (this is a local OS call, so the zero model-network-call
   * invariant is untouched).
   */
  const maybeNotify = (
    session: RegistrySession,
    moment:
      | { kind: "question"; text: string }
      | { kind: "questions"; count: number }
      | { kind: "revision"; revision: number },
  ): void => {
    try {
      if (!loadConfig(session.repo).notifications.desktop) {
        process.stderr.write(`otacond: notify skip session=${session.id} reason=config-disabled\n`);
        return;
      }
      if (presence.isWatched(session.id)) {
        process.stderr.write(`otacond: notify skip session=${session.id} reason=watched\n`);
        return;
      }
      const message =
        moment.kind === "revision"
          ? `Revision r${moment.revision} ready for review`
          : moment.kind === "questions"
            ? `${moment.count} questions need your answer`
            : moment.text.length > 80
              ? `${moment.text.slice(0, 79)}…`
              : moment.text;
      process.stderr.write(
        `otacond: notify dispatch session=${session.id} kind=${moment.kind} title=${JSON.stringify(session.title)} message=${JSON.stringify(message)}\n`,
      );
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
   * Finalize an approval. Writes the composed
   * artifact (with the comment-&-approve `## Review notes` when `reviewNotes` are
   * present). It ALWAYS writes the canonical home copy
   * (`~/.otacon/sessions/<id>/`, the session's home dir: removed when the
   * session is deleted, so not a durable archive).
   * On **Save** (implement=false) it ALSO writes a project copy under the repo's
   * configured `plans.dir` (the durable copy), and the event `path` points
   * there. On **Implement** (implement=true) it writes home only, and `path`
   * equals `home` (the durable copy then rides in the PR). The home write is the
   * crash-safe finalize point: file(s) before the status flip.
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
    // On Implement, record the build's worktree + branch in the same write that
    // flips to `implementing` (one registry write). Deterministic from the
    // title slug + the configured worktree.dir, so a later `/otacon` run from
    // inside that worktree can match it back to this session and reopen it.
    let implPatch: { impl: { worktree: string; branch: string } } | Record<string, never> = {};
    if (opts.implement) {
      const slug = slugify(session.title) || "plan";
      const wtDir = expandTilde(loadConfig(session.repo).worktree.dir);
      const worktree = join(wtDir, slug);
      const branch = `otacon/impl-${slug}`;
      implPatch = { impl: { worktree, branch } };
    }
    const updated = store.updateSession(session.id, {
      status: opts.implement ? "implementing" : "approved",
      ...implPatch,
    });
    // Save (approved) is terminal — the agent stops, so tear the tailer down.
    // Implement keeps the session live (`implementing`), so the tailer keeps
    // streaming the build's activity until implement-done flips it terminal.
    if (!opts.implement) stopTailer(session.id);
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

  // Review sessions deliberately share only the generic session envelope and
  // event/presence plumbing in Phase 3. Keep every plan-state endpoint behind
  // the discriminant before it can parse a body or create plan files such as
  // session.json, threads.json, or transcript counters for a review id.
  app.use("/api/sessions/:id/*", async (c, next) => {
    const session = sessionFor(c);
    if (session?.kind === "review") {
      const base = `/api/sessions/${session.id}`;
      const suffix = c.req.path.slice(base.length);
      const reviewThreadRead = suffix === "/threads" && c.req.method === "GET";
      if (suffix !== "" && suffix !== "/events" && suffix !== "/presence" && suffix !== "/stream" && !reviewThreadRead) {
        return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a plan`);
      }
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
    c.json({ app: "otacond", version: VERSION, pid: process.pid, viewers: viewers.count() }),
  );

  const knowledgeTarget = (scope: unknown, repo: unknown): KnowledgeTarget | undefined => {
    if (scope === "user") return { scope: "user" };
    if (scope !== "project" || typeof repo !== "string") return undefined;
    const canonical = canonicalizeGitHubRepo(repo);
    return canonical === undefined ? undefined : { scope: "project", repo: canonical };
  };

  // Local profile documents. GET never creates a file: a no-history reader
  // receives the neutral baseline and its CAS hash. Project identity is a
  // canonical GitHub owner/repo rather than a clone path, so clones converge.
  app.get("/api/knowledge", (c) => {
    const scope = c.req.query("scope");
    const repo = c.req.query("repo");
    const target = knowledgeTarget(scope, repo);
    if (target === undefined) {
      return badRequest(
        c,
        scope === "project"
          ? "project knowledge requires a valid GitHub owner/repo"
          : 'scope must be "user" or "project"',
      );
    }
    return c.json({ document: knowledge.read(target) });
  });

  // CAS summary replacement. A stale editor receives the current document in
  // the 409 response, allowing it to preserve its draft and show the newer
  // disk value. Validate everything before replace so a bad request writes no
  // file. Evidence appends are intentionally separate store operations.
  app.put("/api/knowledge", async (c) => {
    const body = (await readJsonBody(c)) ?? {};
    const target = knowledgeTarget(body.scope, body.repo);
    if (target === undefined) {
      return badRequest(
        c,
        body.scope === "project"
          ? "project knowledge requires a valid GitHub owner/repo"
          : 'scope must be "user" or "project"',
      );
    }
    if (typeof body.markdown !== "string") return badRequest(c, "markdown must be a string");
    if (typeof body.baseHash !== "string") return badRequest(c, "baseHash must be a SHA-256 string");
    const baseHash = parseKnowledgeHash(body.baseHash);
    if (baseHash === undefined) return badRequest(c, "baseHash must be a lowercase SHA-256 string");
    try {
      const result = knowledge.replace(target, body.markdown, baseHash);
      if (!result.ok) {
        return c.json(
          {
            error: {
              code: "E_KNOWLEDGE_CONFLICT",
              message: "knowledge changed after this editor loaded it",
            },
            document: result.current,
          },
          409,
        );
      }
      return c.json({ document: result.document });
    } catch (error) {
      if (error instanceof InvalidKnowledgeMarkdownError) {
        return c.json(
          { error: { code: "E_INVALID_KNOWLEDGE", message: error.message } },
          422,
        );
      }
      throw error;
    }
  });

  // The Settings UI's config surface (review loop and daemon API). GET returns the full
  // schema plus each scope's current sparse, coerced values. The `user` scope
  // (~/.otacon/config.json) is always present; the project scopes only when an
  // absolute `repo` is named — User config needs no repo, so an absent/empty/
  // non-absolute `repo` omits them (matching the isAbsolute guard POST applies
  // to the write). `project` is the team-shared <repo>/.otacon/config.json;
  // `project.local` is the personal <repo>/.otacon/config.local.json override.
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
    const { title, prompt, repo, branch, quick, socratic } = body;
    if (typeof title !== "string" || title.trim() === "") {
      return badRequest(c, "title must be a non-empty string");
    }
    if (prompt !== undefined && typeof prompt !== "string") {
      return badRequest(c, "prompt must be a string");
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
    if (socratic !== undefined && typeof socratic !== "boolean") {
      return badRequest(c, "socratic must be a boolean");
    }
    // An omitted `socratic` falls back to the repo's merged `socratic.default`
    // config (otacon start omits the flag precisely so this default applies);
    // an explicit boolean always wins.
    const socraticEffective =
      typeof socratic === "boolean" ? socratic : loadConfig(repo).socratic.default;
    // --quick skips the grill; socratic mode requires it. The two are
    // contradictory, so refuse rather than silently picking a winner.
    if (quick === true && socraticEffective) {
      return badRequest(c, "socratic and quick are mutually exclusive");
    }
    // Trim once here and only forward a non-empty prompt, so a whitespace-only
    // request stores no field (the store mirrors this defensively).
    const trimmedPrompt = typeof prompt === "string" ? prompt.trim() : "";
    const session = store.createSession({
      title,
      repo,
      branch,
      quick,
      socratic: socraticEffective,
      ...(trimmedPrompt !== "" ? { prompt: trimmedPrompt } : {}),
    });
    // Attach the transcript tailer now: the agent is already working in `repo`,
    // so its live transcript may already exist (and if not, the tailer re-locates
    // until it appears). A repo whose agent has no adapter attaches nothing.
    startTailer(session);
    publishSession(session);
    return c.json(session, 201);
  });

  /** Canonical review lookup, independent of local clone paths. */
  app.get("/api/reviews", (c) => {
    const repository = canonicalizeGitHubRepo(`https://github.com/${c.req.query("repo") ?? ""}`);
    const number = Number(c.req.query("number"));
    if (repository === undefined || !Number.isInteger(number) || number < 1) {
      return badRequest(c, "repo must be owner/repo and number must be a positive integer");
    }
    const session = store.findReviewSession(repository, number);
    if (session === undefined) return notFound(c, `unknown review: ${repository}#${number}`);
    return c.json({ session: summarize(session) });
  });

  /** Atomic create/reuse/revise path used by `otacon review start`. */
  app.post("/api/reviews", async (c) => {
    const body = (await readJsonBody(c)) ?? {};
    const { repo, repository: rawRepository, branch, force } = body;
    const repository = typeof rawRepository === "string"
      ? canonicalizeGitHubRepo(`https://github.com/${rawRepository}`)
      : undefined;
    const pullRequest = parsePullRequestMetadata(body.pullRequest);
    if (typeof repo !== "string" || !isAbsolute(repo)) {
      return badRequest(c, "repo must be an absolute path");
    }
    if (repository === undefined) return badRequest(c, "repository must be owner/repo");
    if (branch !== undefined && typeof branch !== "string") {
      return badRequest(c, "branch must be a string");
    }
    if (force !== undefined && typeof force !== "boolean") {
      return badRequest(c, "force must be a boolean");
    }
    if (pullRequest === undefined) return badRequest(c, "pullRequest metadata is invalid");
    if (pullRequest.identity.repository !== repository) {
      return c.json({
        error: {
          code: "E_REPO_MISMATCH",
          message: `PR belongs to ${pullRequest.identity.repository}, not ${repository}`,
        },
      }, 409);
    }
    const result = store.startReviewSession({
      repo,
      branch,
      pullRequest,
      force: force === true,
    });
    const preparation = reviews.prepareForSession(result.session);
    publishSession(result.session);
    return c.json({ ...result, preparation }, result.action === "created" ? 201 : 200);
  });

  /** Refresh one known review from freshly-resolved metadata. */
  app.post("/api/reviews/:id/head", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (session.kind !== "review") {
      return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a review`);
    }
    const body = (await readJsonBody(c)) ?? {};
    const pullRequest = parsePullRequestMetadata(body.pullRequest);
    if (pullRequest === undefined) return badRequest(c, "pullRequest metadata is invalid");
    if (pullRequest.identity.key !== session.review.pullRequest.identity.key) {
      return c.json({
        error: { code: "E_REVIEW_IDENTITY", message: "head refresh cannot change PR identity" },
      }, 409);
    }
    const unchanged = pullRequest.headSha === session.review.head.sha;
    const updated = store.refreshReviewHead(session.id, pullRequest);
    const preparation = reviews.prepareForSession(updated);
    // Same-SHA refreshes still carry mutable title/state/ref/permissions and
    // must reach the registry/UI; only the head generation stays unchanged.
    publishSession(updated);
    return c.json({ action: unchanged ? "reused" : "revised", session: summarize(updated), preparation });
  });

  /** Explicit same-head report revision, used by later report-feedback refreshes. */
  app.post("/api/reviews/:id/revisions", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (session.kind !== "review") {
      return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a review`);
    }
    if (session.status === "done") return sessionOver(c, session.id);
    const preparation = reviews.beginRevision(session);
    const updated = store.updateSession(session.id, { status: "working" });
    publishSession(updated);
    return c.json({ preparation }, 201);
  });

  /** Agent submission: strict lint + ownership checks precede an immutable commit. */
  app.post("/api/reviews/:id/submit", async (c) => {
    const sessionBefore = store.getSession(c.req.param("id"));
    if (sessionBefore === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (sessionBefore.kind !== "review") {
      return codedBadRequest(c, "E_SESSION_KIND", `session ${sessionBefore.id} is not a review`);
    }
    const body = (await readJsonBody(c)) ?? {};
    if (typeof body.report !== "string" || typeof body.quiz !== "string") {
      return badRequest(c, "report and quiz must be strings");
    }
    const current = store.getSession(sessionBefore.id);
    if (current?.kind !== "review") return notFound(c, `unknown review: ${sessionBefore.id}`);
    if (current.status === "done") return sessionOver(c, current.id);
    try {
      const revision = reviews.submit(current, { report: body.report, quiz: body.quiz });
      const updated = store.updateSession(current.id, { status: "reviewing" });
      publishSession(updated);
      notifier.publish({
        type: "revision",
        session: current.id,
        data: { session: current.id, revision: revision.revision.revision, changelog: null },
      });
      maybeNotify(updated, { kind: "revision", revision: revision.revision.revision });
      return c.json({ revision: publicReviewRevision(current, revision) }, 201);
    } catch (error) {
      if (error instanceof ReviewReportInvalidError) {
        return c.json({
          error: { code: "E_REVIEW_REPORT_INVALID", message: error.message },
          issues: error.issues,
        }, 422);
      }
      if (error instanceof ReviewRevisionExistsError) {
        return c.json({ error: { code: "E_REVIEW_REVISION_EXISTS", message: error.message } }, 409);
      }
      if (error instanceof ReviewRevisionCorruptError || error instanceof ReviewQuizCorruptError) {
        return c.json({
          error: {
            code: "E_REVIEW_REVISION_UNAVAILABLE",
            message: "the report names a revision that is missing or unreadable; prepare a new report revision",
          },
        }, 409);
      }
      throw error;
    }
  });

  /** Latest submitted report plus revision-scoped PR metadata and snapshot. */
  app.get("/api/reviews/:id", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (session.kind !== "review") {
      return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a review`);
    }
    const latest = reviews.latestSubmittedRevision(session.id);
    const requested = c.req.query("revision");
    const revision = requested === undefined ? latest : Number(requested);
    if (!Number.isInteger(revision) || revision < 1 || revision > latest) {
      if (requested !== undefined || latest > 0) {
        return badRequest(c, `revision must name a submitted report between 1 and ${latest}`);
      }
    }
    try {
      const report = revision === 0 ? null : reviews.readRevision(session.id, revision);
      if (report !== null && report.revision.status !== "submitted") {
        return notFound(c, `session ${session.id} has no submitted review revision ${revision}`);
      }
      return c.json({
        session: summarize(session),
        report: report === null ? null : publicReviewRevision(session, report),
        preparation: (() => {
          const preparation = reviews.latestForHead(session);
          return preparation === undefined ? null : publicReviewRevision(session, preparation);
        })(),
      });
    } catch (error) {
      if (error instanceof ReviewRevisionCorruptError || error instanceof ReviewQuizCorruptError) {
        return reviewRevisionUnavailable(c, `review revision ${revision} is missing or corrupt`);
      }
      throw error;
    }
  });

  app.get("/api/reviews/:id/revisions/:n", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (session.kind !== "review") {
      return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a review`);
    }
    const revision = Number(c.req.param("n"));
    if (!Number.isInteger(revision) || revision < 1) return badRequest(c, "revision must be a positive integer");
    try {
      return c.json({ revision: publicReviewRevision(session, reviews.readRevision(session.id, revision)) });
    } catch (error) {
      if (error instanceof ReviewRevisionCorruptError || error instanceof ReviewQuizCorruptError) {
        return reviewRevisionUnavailable(c, `review revision ${revision} is missing or corrupt`);
      }
      throw error;
    }
  });

  app.get("/api/reviews/:id/diff", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (session.kind !== "review") {
      return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a review`);
    }
    const latest = reviews.latestSubmittedRevision(session.id);
    const from = Number(c.req.query("from") ?? Math.max(0, latest - 1));
    const to = Number(c.req.query("to") ?? latest);
    if (!Number.isInteger(to) || to < 1 || to > latest || !Number.isInteger(from) || from < 0 || from >= to) {
      return badRequest(c, `diff requires 0 <= from < to <= ${latest}`);
    }
    try {
      const before = from === 0 ? "" : reviews.readRevision(session.id, from).report;
      const after = reviews.readRevision(session.id, to).report;
      if (before === undefined || after === undefined) return notFound(c, "diff requires submitted report revisions");
      const payload: DiffPayload = { session: session.id, from, to, sections: diffPlans(before, after) };
      return c.json(payload);
    } catch (error) {
      if (error instanceof ReviewRevisionCorruptError) {
        return reviewRevisionUnavailable(c, "one of the requested review revisions is missing or corrupt");
      }
      throw error;
    }
  });

  /** Browser creation of an anchored Ask or Comment on the exact current report. */
  app.post("/api/reviews/:id/threads", async (c) => {
    const before = store.getSession(c.req.param("id"));
    if (before === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (before.kind !== "review") return codedBadRequest(c, "E_SESSION_KIND", `session ${before.id} is not a review`);
    const body = (await readJsonBody(c)) ?? {};
    const optional = body.rememberScope === undefined ? [] : ["rememberScope"];
    if (!hasExactKeys(body, ["intent", "anchor", "body", "reportRevision", "headRevision", "headSha", "idempotencyKey", ...optional])) {
      return codedBadRequest(c, "E_REVIEW_THREAD_INPUT", "review thread request has unknown or missing fields");
    }
    const current = store.getSession(before.id);
    if (current?.kind !== "review") return notFound(c, `unknown review: ${before.id}`);
    if (current.status === "done") return sessionOver(c, current.id);
    const intent = body.intent;
    const anchor = parseReviewAnchor(body.anchor);
    const rememberScope = body.rememberScope;
    if ((intent !== "question" && intent !== "comment") || anchor === undefined ||
      typeof body.body !== "string" || body.body.trim() === "" || body.body.length > 20_000 ||
      typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "" || body.idempotencyKey.length > 200 ||
      !Number.isInteger(body.reportRevision) || !Number.isInteger(body.headRevision) ||
      typeof body.headSha !== "string" || (rememberScope !== undefined && rememberScope !== "user" && rememberScope !== "project")) {
      return codedBadRequest(c, "E_REVIEW_THREAD_INPUT", "review thread request is invalid");
    }
    const latest = reviews.latestSubmittedRevision(current.id);
    if (body.reportRevision !== latest || body.headRevision !== current.review.revision || body.headSha !== current.review.head.sha) {
      return c.json({ error: { code: "E_REVIEW_THREAD_STALE", message: "selection does not belong to the current report and PR head" } }, 409);
    }
    let report: ReviewReportRevisionPayload;
    try {
      report = reviews.readRevision(current.id, latest);
    } catch {
      return reviewRevisionUnavailable(c, `review revision ${latest} is missing or corrupt`);
    }
    if (report.revision.status !== "submitted" || report.revision.headRevision !== current.review.revision || report.revision.headSha !== current.review.head.sha) {
      return c.json({ error: { code: "E_REVIEW_THREAD_STALE", message: "current report has not been submitted for the current PR head" } }, 409);
    }
    if (report.report === undefined || !report.report.includes(anchor.exact!)) {
      return c.json({ error: { code: "E_REVIEW_ANCHOR", message: "selected quote is not present in the named report revision" } }, 409);
    }
    const path = store.threadsPath(current.id);
    const existingThreads = readReviewThreads(path, current.id);
    const existing = existingThreads.find((thread) => thread.idempotencyKey === body.idempotencyKey);
    // Construct the durable queue before the first thread/counter write. A bad
    // queue is quarantined now rather than after the browser believes the
    // create succeeded; a crash after persistence is repaired at startup.
    queueFor(current.id);
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const prefix = intent === "question" ? "q" : "t";
    const nextOrdinal = existingThreads.reduce((max, thread) => {
      if (!thread.id.startsWith(prefix)) return max;
      return Math.max(max, Number(thread.id.slice(1)) || 0);
    }, 0) + 1;
    const id = existing?.id ?? `${prefix}${nextOrdinal}`;
    try {
      const result = createReviewThread(path, {
        id,
        surface: "review",
        intent,
        anchor,
        body: body.body,
        createdAt,
        identity: {
          session: current.id,
          reportRevision: body.reportRevision as number,
          headRevision: body.headRevision as number,
          headSha: body.headSha,
        },
        idempotencyKey: body.idempotencyKey,
        ...(rememberScope === undefined ? {} : { remember: { scope: rememberScope } }),
      });
      const event = reviewThreadEvent(result.thread, intent === "question" ? "question" : "report-feedback");
      // A request-loss retry may arrive after the agent already responded (or
      // after a Comment advanced to code work). The persisted thread is the
      // authority: only reconstruct work that startup recovery would also own.
      const seq = result.thread.response === undefined && result.thread.codeAction === undefined
        ? enqueueReviewThreadWork(event)
        : undefined;
      const publicThread = publicReviewThread(result.thread);
      publishThread(current.id, publicThread);
      publishQueue(current.id, queueFor(current.id).size);
      publishSession(current);
      return c.json({ thread: publicThread, repeated: result.repeated, ...(seq === undefined ? {} : { seq }) }, result.repeated ? 200 : 201);
    } catch (error) {
      if (error instanceof ReviewThreadConflictError) {
        return c.json({ error: { code: error.code, message: error.message } }, 409);
      }
      throw error;
    }
  });

  /** Agent answer/report-feedback response, optionally acknowledging requested memory. */
  app.post("/api/reviews/:id/threads/:tid/respond", async (c) => {
    const before = store.getSession(c.req.param("id"));
    if (before === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (before.kind !== "review") return codedBadRequest(c, "E_SESSION_KIND", `session ${before.id} is not a review`);
    const body = (await readJsonBody(c)) ?? {};
    const optional = ["responseReportRevision", "saved"].filter((key) => body[key] !== undefined);
    if (!hasExactKeys(body, ["source", "body", ...optional])) {
      return codedBadRequest(c, "E_REVIEW_THREAD_RESPONSE", "thread response has unknown or missing fields");
    }
    const source = parseReviewSource(body.source);
    if (source === undefined) {
      return codedBadRequest(c, "E_REVIEW_THREAD_RESPONSE", "thread source identity is invalid");
    }
    const current = store.getSession(before.id);
    if (current?.kind !== "review") return notFound(c, `unknown review: ${before.id}`);
    if (current.status === "done") return sessionOver(c, current.id);
    const thread = readReviewThreads(store.threadsPath(current.id), current.id).find((candidate) => candidate.id === c.req.param("tid"));
    if (thread === undefined) return notFound(c, `unknown review thread: ${c.req.param("tid")}`);
    if (source.reportRevision !== thread.identity.reportRevision || source.headRevision !== thread.identity.headRevision || source.headSha !== thread.identity.headSha) {
      return c.json({ error: { code: "E_REVIEW_THREAD_IDENTITY", message: "response source does not match the persisted thread" } }, 409);
    }
    if (typeof body.body !== "string" || body.body.trim() === "" || body.body.length > 20_000) {
      return codedBadRequest(c, "E_REVIEW_THREAD_RESPONSE", "response body must be non-empty and bounded");
    }
    let saved: { scope: "user" | "project"; updated: true } | undefined;
    if (body.saved !== undefined) {
      if (typeof body.saved !== "object" || body.saved === null || Array.isArray(body.saved)) {
        return codedBadRequest(c, "E_REVIEW_MEMORY_ACK", "saved acknowledgement is invalid");
      }
      const raw = body.saved as Record<string, unknown>;
      if (!hasExactKeys(raw, ["scope", "updated"]) || (raw.scope !== "user" && raw.scope !== "project") || raw.updated !== true) {
        return codedBadRequest(c, "E_REVIEW_MEMORY_ACK", "saved acknowledgement must name one requested scope and updated:true");
      }
      saved = { scope: raw.scope, updated: true };
    }
    const responseReportRevision = body.responseReportRevision;
    if (thread.intent === "comment") {
      const latest = reviews.latestSubmittedRevision(current.id);
      if (!Number.isInteger(responseReportRevision) || (responseReportRevision as number) <= thread.identity.reportRevision || responseReportRevision !== latest) {
        return c.json({ error: { code: "E_REVIEW_THREAD_RESPONSE_REVISION", message: "Comment response must name the latest submitted report revision newer than its source" } }, 409);
      }
      try {
        const replacement = reviews.readRevision(current.id, responseReportRevision as number);
        if (replacement.revision.status !== "submitted" || replacement.revision.headRevision !== current.review.revision || replacement.revision.headSha !== current.review.head.sha) {
          return c.json({ error: { code: "E_REVIEW_THREAD_RESPONSE_REVISION", message: "replacement report is not current for this PR head" } }, 409);
        }
      } catch {
        return reviewRevisionUnavailable(c, `review revision ${responseReportRevision as number} is missing or corrupt`);
      }
    } else if (responseReportRevision !== undefined) {
      return codedBadRequest(c, "E_REVIEW_THREAD_RESPONSE", "Question answers do not create report revisions");
    }
    try {
      const result = respondToReviewThread(store.threadsPath(current.id), thread.id, {
        body: body.body,
        ...(responseReportRevision === undefined ? {} : { reportRevision: responseReportRevision as number }),
        ...(saved === undefined ? {} : { saved }),
      }, new Date().toISOString(), current.id);
      const publicThread = publicReviewThread(result.thread);
      publishThread(current.id, publicThread);
      publishQueue(current.id, queueFor(current.id).size);
      publishSession(current);
      return c.json({ thread: publicThread, repeated: result.repeated });
    } catch (error) {
      if (error instanceof ReviewThreadConflictError) return c.json({ error: { code: error.code, message: error.message } }, 409);
      throw error;
    }
  });

  /** Reviewer-only second step: explicitly authorize code work for one Comment. */
  app.post("/api/reviews/:id/threads/:tid/code-action", async (c) => {
    const before = store.getSession(c.req.param("id"));
    if (before === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (before.kind !== "review") return codedBadRequest(c, "E_SESSION_KIND", `session ${before.id} is not a review`);
    const body = (await readJsonBody(c)) ?? {};
    if (!hasExactKeys(body, ["source"])) {
      return codedBadRequest(c, "E_REVIEW_CODE_ACTION", "code-action source identity is required");
    }
    const source = parseReviewSource(body.source);
    if (source === undefined) return codedBadRequest(c, "E_REVIEW_CODE_ACTION", "code-action source identity is invalid");
    const current = store.getSession(before.id);
    if (current?.kind !== "review") return notFound(c, `unknown review: ${before.id}`);
    if (current.status === "done") return sessionOver(c, current.id);
    if (current.review.pullRequest.state !== "open" || current.review.pullRequest.permissions.readOnly ||
      !["write", "maintain", "admin"].includes(current.review.pullRequest.permissions.viewerPermission) ||
      current.review.pullRequest.isCrossRepository ||
      current.review.pullRequest.headRepository !== current.review.pullRequest.identity.repository) {
      return c.json({ error: { code: "E_REVIEW_READ_ONLY", message: "this PR has no safe same-repository write path; discuss the Comment without conducting a code change" } }, 409);
    }
    const thread = readReviewThreads(store.threadsPath(current.id), current.id).find((candidate) => candidate.id === c.req.param("tid"));
    if (thread === undefined) return notFound(c, `unknown review thread: ${c.req.param("tid")}`);
    if (source.reportRevision !== thread.identity.reportRevision || source.headRevision !== thread.identity.headRevision || source.headSha !== thread.identity.headSha) {
      return c.json({ error: { code: "E_REVIEW_THREAD_IDENTITY", message: "code action does not match the persisted Comment" } }, 409);
    }
    if (thread.identity.headRevision !== current.review.revision || thread.identity.headSha !== current.review.head.sha) {
      return c.json({ error: { code: "E_REVIEW_THREAD_STALE", message: "Comment belongs to an older PR head; comment on the current report instead" } }, 409);
    }
    try {
      const sourceReport = reviews.readRevision(current.id, thread.identity.reportRevision);
      if (sourceReport.revision.status !== "submitted") throw new Error("not submitted");
    } catch {
      return reviewRevisionUnavailable(c, "the Comment source report is missing or corrupt");
    }
    try {
      const result = requestReviewCodeAction(store.threadsPath(current.id), thread.id, new Date().toISOString(), current.id);
      const event = reviewThreadEvent(result.thread, "code-change");
      // Retry can repair a missing enqueue while requested, but must never
      // resurrect work the agent already moved to working/terminal.
      const seq = result.thread.codeAction?.status === "requested"
        ? enqueueReviewThreadWork(event)
        : undefined;
      const publicThread = publicReviewThread(result.thread);
      publishThread(current.id, publicThread);
      publishQueue(current.id, queueFor(current.id).size);
      publishSession(current);
      return c.json({ thread: publicThread, repeated: result.repeated, ...(seq === undefined ? {} : { seq }) }, result.repeated ? 200 : 202);
    } catch (error) {
      if (error instanceof ReviewThreadConflictError) return c.json({ error: { code: error.code, message: error.message } }, 409);
      throw error;
    }
  });

  /** Agent lifecycle acknowledgement for already-authorized code work. */
  app.post("/api/reviews/:id/threads/:tid/code-action/status", async (c) => {
    const before = store.getSession(c.req.param("id"));
    if (before === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (before.kind !== "review") return codedBadRequest(c, "E_SESSION_KIND", `session ${before.id} is not a review`);
    const body = (await readJsonBody(c)) ?? {};
    const optional = body.message === undefined ? [] : ["message"];
    if (!hasExactKeys(body, ["source", "status", ...optional])) {
      return codedBadRequest(c, "E_REVIEW_CODE_ACTION", "code-action status is invalid");
    }
    const source = parseReviewSource(body.source);
    if (source === undefined ||
      (body.status !== "working" && body.status !== "completed" && body.status !== "failed") ||
      (body.message !== undefined && (typeof body.message !== "string" || body.message.trim() === "" || body.message.length > 20_000))) {
      return codedBadRequest(c, "E_REVIEW_CODE_ACTION", "code-action status fields are invalid");
    }
    const current = store.getSession(before.id);
    if (current?.kind !== "review") return notFound(c, `unknown review: ${before.id}`);
    if (current.status === "done") return sessionOver(c, current.id);
    const thread = readReviewThreads(store.threadsPath(current.id), current.id).find((candidate) => candidate.id === c.req.param("tid"));
    if (thread === undefined) return notFound(c, `unknown review thread: ${c.req.param("tid")}`);
    if (source.reportRevision !== thread.identity.reportRevision || source.headRevision !== thread.identity.headRevision || source.headSha !== thread.identity.headSha) {
      return c.json({ error: { code: "E_REVIEW_THREAD_IDENTITY", message: "code-action status does not match the persisted Comment" } }, 409);
    }
    try {
      const result = updateReviewCodeAction(store.threadsPath(current.id), thread.id, {
        status: body.status,
        ...(body.message === undefined ? {} : { message: body.message }),
      }, new Date().toISOString(), current.id);
      const publicThread = publicReviewThread(result.thread);
      publishThread(current.id, publicThread);
      publishQueue(current.id, queueFor(current.id).size);
      publishSession(current);
      return c.json({ thread: publicThread, repeated: result.repeated });
    } catch (error) {
      if (error instanceof ReviewThreadConflictError) return c.json({ error: { code: error.code, message: error.message } }, 409);
      throw error;
    }
  });

  /** User answer: choices grade inline; open answers durably wake the review agent. */
  app.post("/api/reviews/:id/quiz/:question/answer", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (session.kind !== "review") return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a review`);
    if (session.status === "done") return sessionOver(c, session.id);
    const body = (await readJsonBody(c)) ?? {};
    if (!Number.isInteger(body.revision) || typeof body.answer !== "string" || typeof body.idempotencyKey !== "string") {
      return badRequest(c, "revision, answer, and idempotencyKey are required");
    }
    try {
      const result = quizzes.answer(session, {
        revision: body.revision as number,
        question: c.req.param("question"),
        answer: body.answer,
        idempotencyKey: body.idempotencyKey,
      });
      // Re-emit a repeated still-pending open answer: this closes the crash
      // window between durable attempt state and durable queue enqueue.
      if (result.event !== undefined) {
        const queue = queueFor(session.id);
        if (!queue.hasPayload((payload) => sameQuizWork(payload, result.event!))) {
          queue.enqueue(result.event, store.bumpCounter(session.id, "eventSeq"));
        }
      }
      publishQuiz(session.id, result.quiz);
      publishQueue(session.id, queueFor(session.id).size);
      publishSession(session);
      return c.json({ quiz: result.quiz, attempt: result.quiz.questions.find((item) => item.id === c.req.param("question"))?.latest, repeated: result.repeated }, result.repeated ? 200 : 201);
    } catch (error) {
      if (error instanceof ReviewQuizConflictError) {
        // This route is browser-facing. A deterministic choice can be retried
        // without revealing the private profile CAS hash; only the agent-only
        // grade route below receives currentHash for an explicit re-grade.
        return c.json({ error: { code: error.code, message: error.message } }, 409);
      }
      if (error instanceof ReviewQuizCorruptError || error instanceof ReviewRevisionCorruptError) {
        return reviewRevisionUnavailable(c, error.message);
      }
      throw error;
    }
  });

  /** Agent-private grade endpoint. The browser never receives its input schema. */
  app.post("/api/reviews/:id/quiz/:question/grade", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (session === undefined) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (session.kind !== "review") return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a review`);
    if (session.status === "done") return sessionOver(c, session.id);
    const parsed = parseReviewQuizGrade((await readJsonBody(c)) ?? {});
    if (parsed.value === undefined) return c.json({ error: { code: "E_QUIZ_GRADE", message: parsed.errors.join("; ") } }, 422);
    if (parsed.value.question !== c.req.param("question") || parsed.value.session !== session.id) {
      return c.json({ error: { code: "E_QUIZ_STALE_GRADE", message: "grade route and file identity do not match" } }, 409);
    }
    try {
      const result = quizzes.grade(session, parsed.value);
      publishQuiz(session.id, result.quiz);
      publishQueue(session.id, queueFor(session.id).size);
      publishSession(session);
      return c.json({ quiz: result.quiz, attempt: result.quiz.questions.find((item) => item.id === parsed.value!.question)?.latest, repeated: result.repeated });
    } catch (error) {
      if (error instanceof ReviewQuizConflictError) {
        return c.json({ error: { code: error.code, message: error.message }, ...(error.currentHash ? { currentHash: error.currentHash } : {}) }, 409);
      }
      if (error instanceof ReviewQuizCorruptError || error instanceof ReviewRevisionCorruptError) {
        return reviewRevisionUnavailable(c, error.message);
      }
      throw error;
    }
  });

  app.get("/api/sessions/:id", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    return c.json(summarize(session));
  });

  // DELETE permanently removes a session: it deregisters from the registry and
  // `rmSync`s its home dir `~/.otacon/sessions/<id>/` outright, for ALL statuses
  // (UI delete and `otacon clean` both drive this route). No archive: nothing
  // is recoverable from otacon itself; the durable copies are the Save copy
  // under the project's `plans.dir` and (for Implement plans) the PR. The only
  // status branch left is waking a parked agent: a live (non-terminal) session
  // may have an agent parked on `wait`, so it is woken with a terminal `deleted`
  // event before deregistering, so its loop stops cleanly. Both branches publish
  // the same terminal `removed` frame.
  app.delete("/api/sessions/:id", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const queue = queueFor(session.id);
    const pendingEvents = queue.size;
    stopTailer(session.id); // the session is going away — stop watching its transcript
    if (TERMINAL_STATUSES.includes(session.status)) {
      // Deregister first — it can throw (registry flush), and an early queue
      // eviction would orphan in-flight ack tracking for a session that is in
      // fact still registered. Close the evicted instance before the removal so
      // a late in-flight ack cannot recreate ~/.otacon/sessions/<id>/.
      store.deleteSession(session.id);
      queue.close();
      queues.delete(session.id);
      store.removeSessionDir(session.id);
    } else {
      // Wake any parked agent BEFORE deregistering so its respondEvent still
      // resolves against a registered session; closeWith sets the queue closed
      // first, so the removal below can't be recreated by a late ack. Then
      // deregister and permanently drop the home dir.
      queue.closeWith({ event: "deleted", session: session.id });
      queues.delete(session.id);
      store.deleteSession(session.id);
      store.removeSessionDir(session.id);
    }
    // Terminal frame: the index and switcher drop the session live, and an
    // open review tab flips to its closed state instead of error-limbo.
    notifier.publish({ type: "removed", session: session.id, data: { session: session.id } });
    return c.json({ ok: true, session: session.id, repo: session.repo, pendingEvents });
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
        // UI within one park slice (review loop and daemon API).
        publishSession(session);
        timer = setTimeout(() => settle(timeoutEvent(c)), waitSeconds * 1000);
        signal.addEventListener("abort", onAbort);
      }
    });
  });

  app.post("/api/sessions/:id/submit", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (session.kind !== "plan") return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a plan`);
    // Raw markdown body, or {"plan": "...", "resolutions": {...}} JSON — the
    // CLI sends resolutions.json's content along (review loop and daemon API). The raw path
    // carries no resolutions, so L5 still rejects it when threads are open.
    let content = await c.req.text();
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    // A submit cannot land mid-build. `implementing` is non-terminal (it re-opens
    // progress/ask/wait/answer, review loop and daemon API) so it slips past sessionEnded — but
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
    // Read the transcript once and derive both sets L3 needs: the known q ids and
    // the "reasoned" subset — q ids whose answer carries non-empty free text (the
    // user reasoned it in their own words, not just picked a chip).
    const transcript = readTranscript(store.transcriptPath(session.id));
    const result = lint(content, loadConfig(session.repo), {
      session: session.id,
      expectedRevision: state.revision + 1,
      expectedStatus: "in_review",
      // L3/L5 context is composed here: rules stay pure, the daemon does the I/O.
      grill: {
        quick: session.quick,
        socratic: session.socratic,
        knownQuestions: transcript.map((e) => e.id),
        reasonedQuestions: transcript
          .filter((e) => typeof e.answer?.text === "string" && e.answer.text.trim().length > 0)
          .map((e) => e.id),
      },
      resolutions: {
        revision: state.revision + 1,
        commentThreads: commentThreadStates(store.threadsPath(session.id)),
        replies,
        changelog: resolutions.changelog,
      },
    });
    // L8 diagram render gate runs alongside the structural linter so the agent
    // gets diagram + structural failures in one pass (fewer round-trips). It
    // fails open, so it only ever adds errors — never blocks on its own infra.
    const diagramErrors = await validateDiagrams(content);
    const errors = [...result.errors, ...diagramErrors];
    if (errors.length > 0) {
      return c.json({ ok: false, errors, warnings: result.warnings }, 422);
    }
    const changelog = (resolutions.changelog ?? "").trim() === "" ? null : (resolutions.changelog as string);
    const revision = store.saveRevision(session.id, content, result.warnings, changelog ?? undefined);
    // The accepted revision settles its threads: resolutions land on their
    // threads, every anchor is re-located in the new text, lost ones orphan
    // (plan structure, lint, and anchoring, threaded review and revision). SSE upserts keep the rail live.
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

    // Deferred approval (comment & approve): a send-to-agent
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
          reply: t.reply?.body ?? "",
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

  // The user's side of re-review bookkeeping (threaded review and revision layer 3): the UI's
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

  // Reopen a finished (terminal) session for another review round
  // (resurrect-plan-amend): a `/otacon` run from inside the build worktree flips
  // the session back to `revising` so the agent amends the approved plan in
  // place instead of spawning a second worktree. The baseline is pinned at the
  // approved revision (markReviewed → lastReviewedRevision = revision), so the
  // next submit diffs against what was approved. `prUrl` and `impl` are kept
  // intact: the amendment still belongs to the same build. A non-terminal
  // session is refused E_NOT_REOPENABLE (there is nothing finished to reopen).
  app.post("/api/sessions/:id/reopen", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    // Agent-driven verb (a `/otacon` run): bump liveness like its siblings so the
    // reopened session reads live, not offline-until-next-call.
    bumpContact(session.id);
    if (!TERMINAL_STATUSES.includes(session.status)) {
      return c.json(
        {
          error: {
            code: "E_NOT_REOPENABLE",
            message: `session ${session.id} is ${session.status}, not reopenable (must be a finished session)`,
          },
        },
        409,
      );
    }
    const state = store.readState(session.id);
    const revision = state.revision;
    if (revision === 0) {
      // A terminal session always has an approved revision; guard anyway.
      return c.json(
        {
          error: {
            code: "E_NOT_REOPENABLE",
            message: `session ${session.id} has no revisions to reopen`,
          },
        },
        409,
      );
    }
    // Pin the diff baseline at the approved revision (monotonic), so the next
    // submit shows just the amendment.
    store.markReviewed(session.id, revision);
    const updated = store.updateSession(session.id, { status: "revising" });
    publishSession(updated); // the index + an open tab move it back to active
    return c.json({
      ok: true,
      session: session.id,
      status: "revising",
      revision,
      lastReviewedRevision: revision,
      impl: updated.impl ?? null,
      prUrl: updated.prUrl ?? null,
    });
  });

  // The review screen reports its visibility here (review loop and daemon API): {visible:true}
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

  // A browser tab reports its liveness here (open-tab reuse, DECISIONS.md "reuse
  // an existing open tab"): one beat per tab on mount and a ~30s heartbeat, plus
  // a `gone:true` beacon on tab close. Daemon-wide (NOT session-scoped): one tab,
  // via the app-shell sidebar, reaches every session, so `otacon open` only needs
  // to know whether ANY tab from this daemon is live. The 90s TTL self-expires a
  // crashed/closed tab whose `gone` beacon never arrived.
  app.post("/api/viewers/heartbeat", async (c) => {
    const body = (await readJsonBody(c)) ?? {};
    if (typeof body.clientId !== "string" || body.clientId.length === 0) {
      return badRequest(c, "clientId must be a non-empty string");
    }
    if (body.gone) viewers.drop(body.clientId);
    else viewers.beat(body.clientId);
    return c.json({ ok: true });
  });

  // Structural diff between two stored revisions, defaulting to the last-reviewed baseline.
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
    if (session.kind !== "plan") return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a plan`);
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
    // A batch may mix new comments and follow-ups: an item with `replyTo` (a
    // comment thread id) continues that conversation INSTEAD of carrying its own
    // anchor — it inherits the root's anchor and orphan state, and a client
    // anchor on it is ignored; an item without `replyTo` parses its own anchor.
    const existing = readThreads(store.threadsPath(session.id));
    const drafts: {
      anchor: Anchor | null;
      anchorState?: "orphaned";
      replyTo?: string;
      body: string;
    }[] = [];
    for (const raw of rawItems as Record<string, unknown>[]) {
      if (typeof raw?.body !== "string" || raw.body.trim() === "") {
        return badRequest(c, "each item needs a non-empty body and a valid anchor (or null)");
      }
      const replyToRaw = raw.replyTo;
      if (replyToRaw === undefined) {
        const anchor = parseAnchor(raw.anchor);
        if (anchor === undefined) {
          return badRequest(c, "each item needs a non-empty body and a valid anchor (or null)");
        }
        drafts.push({ anchor, body: raw.body });
        continue;
      }
      if (typeof replyToRaw !== "string" || replyToRaw === "") {
        return badRequest(c, "replyTo must name a comment thread id (t<n>)");
      }
      const parent = existing.find(
        (t): t is Extract<Thread, { kind: "comment" }> =>
          t.id === replyToRaw && t.kind === "comment",
      );
      if (!parent) {
        return c.json(
          {
            error: {
              code: "E_UNKNOWN_COMMENT",
              message: `session ${session.id} has no comment ${replyToRaw}`,
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
        (t): t is Extract<Thread, { kind: "comment" }> =>
          t.id === rootId && t.kind === "comment",
      );
      const source = root ?? parent;
      drafts.push({
        anchor: source.anchor,
        ...(source.anchorState === "orphaned" ? { anchorState: "orphaned" as const } : {}),
        replyTo: rootId,
        body: raw.body,
      });
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
      anchor: draft.anchor,
      body: draft.body,
      ...(draft.replyTo !== undefined ? { replyTo: draft.replyTo } : {}),
    }));
    const batch = `b${counters.batch}`;
    // Each item becomes a persistent thread (threaded review and revision) — the rail's
    // source of truth; the queued event is only the agent's wake-up copy.
    const createdAt = new Date().toISOString();
    const threads: Thread[] = drafts.map((draft, i) => ({
      id: `t${firstThread + i + 1}`,
      kind: "comment",
      batch,
      anchor: draft.anchor,
      ...(draft.anchorState === "orphaned" ? { anchorState: "orphaned" as const } : {}),
      body: draft.body,
      createdAt,
      ...(draft.replyTo !== undefined ? { replyTo: draft.replyTo } : {}),
    }));
    appendThreads(store.threadsPath(session.id), threads);
    // Flushing a batch is the implicit "I reviewed this revision" signal
    // (threaded review and revision layer 3) — the diff baseline moves with it.
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
    if (session.kind !== "plan") return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a plan`);
    const queue = queueFor(session.id); // before any state write: can throw on a corrupt file
    const body = (await readJsonBody(c)) ?? {};
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    bumpContact(session.id);
    if (typeof body.body !== "string" || body.body.trim() === "") {
      return badRequest(c, "question needs a non-empty body");
    }
    // A follow-up (threaded review and revision) names the question it continues with `replyTo`
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
    // Questions leave the plan — and the status — untouched (threaded review and revision).
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

  // The agent's side of a user question (`otacon answer`):
  // the answer lands on the thread — the plan and the status stay untouched —
  // and the UI's "answering…" placeholder resolves over SSE.
  app.post("/api/sessions/:id/questions/:qid/answer", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (session.kind !== "plan") return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a plan`);
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

  // The reviewer's side of closing a thread (the Resolve verb): {resolved:true}
  // stamps the close (carrying the session's current revision) on the conversation
  // root, {resolved:false} reopens it. Resolve doubles as the comment-withdraw
  // path — a resolved comment no longer owes a reply (L5 skips it) and no longer
  // counts unresolved at approve. Refused on a terminal session (like the
  // questions route); 404 on an unknown thread id.
  app.post("/api/sessions/:id/threads/:tid/resolve", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    if (session.kind !== "plan") return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a plan`);
    const body = (await readJsonBody(c)) ?? {};
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    if (typeof body.resolved !== "boolean") {
      return badRequest(c, "resolved must be a boolean");
    }
    const tid = c.req.param("tid") ?? "";
    const thread = resolveThread(
      store.threadsPath(session.id),
      tid,
      body.resolved,
      store.readState(session.id).revision,
    );
    if (!thread) {
      return c.json(
        {
          error: {
            code: "E_UNKNOWN_THREAD",
            message: `session ${session.id} has no thread ${tid}`,
          },
        },
        404,
      );
    }
    publishThread(session.id, thread);
    return c.json({ ok: true }, 202);
  });

  app.get("/api/sessions/:id/threads", (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    return c.json({
      session: session.id,
      threads: session.kind === "review"
        ? publicReviewThreads(store.threadsPath(session.id), session.id)
        : readThreads(store.threadsPath(session.id)),
    });
  });

  // The agent's grill question (`otacon ask`): persisted in
  // the transcript and pushed to the UI as a card; no agent event is queued —
  // the asker goes straight back to `otacon wait` for the answer. Accepts a
  // single question body or a batch (`{questions:[…]}`) of independent
  // questions — independent siblings the agent posts in one call (interview questions); they
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
        // Socratic mode bans answer-revealing chips: a bad member fails the whole
        // batch (mirrors the malformed-member rule above), so the queue never
        // holds a partial set.
        if (session.socratic && (spec.options !== undefined || spec.recommend !== undefined)) {
          return codedBadRequest(
            c,
            "E_SOCRATIC_FREE_TEXT_ONLY",
            `questions[${i}] socratic mode requires free-text questions only (no options/recommend)`,
          );
        }
        specs.push(spec);
      }
      const counters = store.bumpCounters(session.id, { question: specs.length });
      const first = counters.question - specs.length;
      const askedAt = new Date().toISOString();
      const entries = specs.map((spec, i) => entryFromSpec(`q${first + i + 1}`, spec, askedAt));
      appendEntries(store.transcriptPath(session.id), entries);
      for (const entry of entries) publishGrill(session.id, entry);
      publishSession(store.getSession(session.id) ?? session);
      // A batch coalesces to one banner — N questions need answering (review loop and daemon API).
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
    // Socratic mode forbids answer-revealing chips so the agent can't hand the
    // user the answer — free-text questions only.
    if (session.socratic && (spec.options !== undefined || spec.recommend !== undefined)) {
      return codedBadRequest(
        c,
        "E_SOCRATIC_FREE_TEXT_ONLY",
        "socratic mode requires free-text questions only (no options/recommend)",
      );
    }
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

  // The user's side of a grill question: the answer lands
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
    // (native-AskUserQuestion "Other" parity, interview questions) — and text may
    // still ride a chosen chip as a note.
    const customText = typeof text === "string" && text.trim() !== "";
    const noChips = choice === undefined && choices === undefined;
    if (noChips) {
      // "Other" parity (interview questions): a non-empty custom answer with no chip
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
    // Snapshot the pre-overwrite answer BEFORE answerEntry mutates the entry: a
    // re-answer carries `revised` + `prior` so the agent reconciles supersession.
    const prior = asked.answer;
    const wasAnswered = prior !== undefined;
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
      ...(wasAnswered
        ? {
            revised: true,
            prior: {
              ...(prior.choice !== undefined ? { choice: prior.choice } : {}),
              ...(prior.choices !== undefined ? { choices: prior.choices } : {}),
              ...(prior.text !== undefined ? { text: prior.text } : {}),
            },
          }
        : {}),
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

  // The agent's narration (`otacon progress`): a non-blocking
  // progress note appended to the capped activity feed and pushed to the UI as
  // an `activity` frame (the per-session log) plus a `session` frame (the
  // chip's latestActivity). The same note is ALSO normalized into a `highlight`
  // StreamEvent and appended to the live-activity stream (the automatic,
  // cross-agent activity stream) so a manual narration sits inline with the
  // captured activity; a `stream` frame pushes it to the UI. No agent event is
  // queued — like `ask`, this is UI-only telemetry, never a wake-up. The note
  // is trimmed to the configured max so long narration never fails or bloats
  // payloads.
  app.post("/api/sessions/:id/progress", async (c) => {
    const session = sessionFor(c);
    if (!session) return notFound(c, `unknown session: ${c.req.param("id")}`);
    const body = (await readJsonBody(c)) ?? {};
    if (sessionEnded(session.id)) return sessionOver(c, session.id);
    const raw = body.note;
    if (typeof raw !== "string" || raw.trim() === "") {
      return badRequest(c, "note must be a non-empty string");
    }
    const { activity, stream } = loadConfig(session.repo);
    const trimmed = raw.trim();
    const at = new Date().toISOString();
    const text =
      trimmed.length > activity.noteMaxChars
        ? `${trimmed.slice(0, Math.max(1, activity.noteMaxChars - 1)).trimEnd()}…`
        : trimmed;
    const note = appendActivity(store.activityPath(session.id), text, activity.cap, at);
    // The same note flows into the new stream as a `highlight` event: the
    // normalizer redacts + truncates the body (its own caps), the daemon stamps
    // seq and `at`. The activity-feed text above keeps its own (shorter) cap —
    // the index draft chip still reads `latestActivity`.
    const event = normalize(
      { kind: "highlight", label: trimmed, detail: trimmed },
      stream,
      nextStreamSeq(session.id),
      at,
    );
    appendStreamEvents(store.streamPath(session.id), [event], stream.cap);
    bumpContact(session.id);
    notifier.publish({ type: "activity", session: session.id, data: { session: session.id, note } });
    publishStream(session.id, [event]);
    publishSession(session); // latestActivity for the chip; fresh contact for the dot
    return c.json({ ok: true, session: session.id, note: text });
  });

  // Approve ends the planning session. Writes the
  // composed artifact (final revision, status: approved, grill transcript
  // appended). The canonical copy ALWAYS lands in the home store
  // (~/.otacon/sessions/<id>/). **Save** (plain Approve, implement=false) ALSO
  // writes a project copy under the repo's `plans.dir` and sets the event `path`
  // there; the session flips to `approved` (terminal) and the agent reports where
  // the plan landed before it stops.
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
    if (session.kind !== "plan") return codedBadRequest(c, "E_SESSION_KIND", `session ${session.id} is not a plan`);
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
    // Unresolved is counted **per conversation**, not per turn: a multi-turn
    // comment or question conversation contributes at most 1. Both kinds carry
    // `replyTo` (a follow-up keys on its root). A conversation is unresolved when
    // its root is not reviewer-`resolved` AND it still owes attention — a
    // **comment** conversation always owes it (you must Resolve it; a landed
    // reply is a response, not a close), a **question** conversation owes it only
    // while some turn is unanswered. So: a responded-but-unresolved comment
    // conversation counts (once); a reviewer-resolved one does not; an unanswered
    // ask counts; an unanswered-but-resolved ask does not.
    const resolvedRoots = new Set(threads.filter((t) => t.resolved).map((t) => t.id));
    const rootOf = (t: Thread): string => t.replyTo ?? t.id;
    const roots = new Set(threads.map(rootOf));
    let unresolved = 0;
    for (const root of roots) {
      if (resolvedRoots.has(root)) continue;
      const turns = threads.filter((t) => rootOf(t) === root);
      const isComment = turns.some((t) => t.kind === "comment");
      const owesAttention = isComment
        ? true
        : turns.some((t) => t.kind === "question" && t.answer === undefined);
      if (owesAttention) unresolved += 1;
    }

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

  // Approve & Implement's outcome report: once the agent has
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
      // Stamp the fresh PR `open` so the home UI sections it immediately, without
      // waiting for the poller. Overwrites both fields atomically: a re-opened
      // session that cut a new PR after a merge resets to the new open one.
      ...(typeof pr === "string" ? { prUrl: pr, prState: "open" as const } : {}),
    });
    stopTailer(session.id); // build is over (both outcomes terminal): stop tailing
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
    // was accepted with alongside it (review loop and daemon API).
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
    getThreads: (id) => {
      const session = store.getSession(id);
      return session?.kind === "review"
        ? publicReviewThreads(store.threadsPath(id), id)
        : readThreads(store.threadsPath(id));
    },
    getTranscript: (id) => readTranscript(store.transcriptPath(id)),
    getActivity: (id) => readActivity(store.activityPath(id)),
    getStream: (id) => readStream(store.streamPath(id), loadStreamCap(id)),
    getQuiz: (id) => {
      const session = store.getSession(id);
      return session?.kind === "review" ? safePublicQuiz(session) : undefined;
    },
    // The index stream (onlySession === undefined) connecting means the home UI
    // is showing the section list: refresh un-settled PRs so a merge/close that
    // landed while no tab was open re-sections within a frame, not a poll cycle.
    onConnect: (onlySession) => {
      if (onlySession === undefined) void prPoller.pollNow();
    },
    uiDir: options.uiDir,
    heartbeatMs: options.sseHeartbeatMs,
  });

  return app;
}
