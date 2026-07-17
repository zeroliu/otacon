// The /s/:id review screen: session header in the session's accent color,
// live over its SSE stream, rendering the latest stored revision as the plan
// dossier (review UI) — with the review loop's desktop verbs (select text
// → toolbar, comments batch in the drawer, questions fire instantly, threads
// in the rail), M3's re-review layer (banner, [clean|diff] + baseline picker,
// gutter markers, j/k), and M4's grill + approve surfaces: the collapsible
// Interview panel as the single grill surface (open questions answered inline,
// answered ones shown with undo; default-expanded during the draft grill phase)
// that decision citations deep-link into, and the warn-then-force Approve
// control. Keyboard:
// c = comment, q = ask, j/k = changed sections; no Approve shortcut exists,
// deliberately (review UI). Approved sessions render read-only behind the quiet
// approved notice. The renderer stays a lazy chunk.

import type { MouseEvent, ReactNode, RefObject } from "react";
import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { accentStyle } from "./accent";
import type { Anchor, CommentDraft, PlanLiveSession, ReviewLiveSession, StreamEvent, Thread, TranscriptEntry } from "./api";
import type { PublicReviewThread } from "../shared/types";
import {
  postCommentFollowup,
  postComments,
  postFollowup,
  postQuestion,
  postResolve,
  postReviewed,
  useDiff,
  usePresence,
  useReviewDetail,
  useRevision,
  useSession,
} from "./api";
import { ProductionPrReviewScreen } from "./pr-review/pr-review-screen";
import type { ReviewQuizPublicState } from "../shared/review-quiz";
import {
  captureSelection,
  clearThreadHighlights,
  flashAnchor,
  paintThreads,
  threadAtPoint,
} from "./review/anchor";
import type { CapturedSelection, LitThread } from "./review/anchor";
import { ApproveDialog, ApprovedNote, ApprovingNote } from "./review/approve";
import { DeleteDialog } from "./review/delete";
import type { ReviewView } from "./review/banner";
import { ReviewControls, RevisionBanner } from "./review/banner";
import { DiffView } from "./review/diff";
import type { PendingComment } from "./review/drawer";
import { CommentDrawer } from "./review/drawer";
import type { ComposerState } from "./review/feedback";
import {
  Composer,
  composerPlacement,
  SelectionBar,
  SHEET_VIEWPORT,
  useSelection,
} from "./review/feedback";
import { ReviewHeader } from "./review/header";
import type { InterviewTarget } from "./review/interview";
import { InterviewPanel } from "./review/interview";
import { useInterviewOpen } from "./review/interview-open";
import { PromptCard } from "./review/prompt-card";
import { useKeyboardInsetVar, useScrollLock, useSheetViewport } from "./review/keyboard";
import { ActivityDock } from "./review/activity-dock";
import { ThreadsRail } from "./review/rail";
import type { SectionMenuState } from "./review/section-menu";
import { SectionMenu } from "./review/section-menu";
import { isTypingTarget } from "./review/session-nav";
import { navigate } from "./router";
import { markSeen } from "./seen";
import { isOver, shouldRedirectAfterTerminalTransition } from "./session-filter";
import { useNow } from "./tick";

const PlanView = lazy(() => import("./plan/plan-view"));

// One reload per tab for a failed renderer chunk: the version-based self-heal
// (self-heal.ts) is the proactive path, but a chunk can still vanish without a
// version frame to trigger it (the snapshot version matched, or the stream
// dropped before re-delivering one). This is the reactive backstop — reload
// once to fetch the current build, then, if the chunk is *genuinely* broken
// (the reload didn't fix it), fall back to the manual link so a real failure
// never infinite-reloads. sessionStorage scopes the guard to this tab.
const BOUNDARY_GUARD_KEY = "otacon-renderer-reloaded";

function rendererReloadAttempted(): boolean {
  // No usable guard store (absent, or a throwing sessionStorage like Safari
  // private mode historically): don't auto-reload — we can't promise "once".
  if (typeof sessionStorage === "undefined") return true;
  try {
    return sessionStorage.getItem(BOUNDARY_GUARD_KEY) !== null;
  } catch {
    return true;
  }
}

/**
 * Catches a failed plan-view chunk load (offline, or a stale tab whose chunk
 * URLs vanished when the daemon was rebuilt) — and any renderer crash —
 * instead of letting React unmount the whole tree to a blank page. React
 * caches a lazy() rejection, so recovery is a real reload, not a re-render. On
 * the first failure this tab has seen we auto-reload once (a vanished chunk is
 * almost always a stale build); a second failure shows the manual link.
 */
class RendererBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch() {
    // Auto-reload only on the first failure this tab has hit. Set the guard
    // before reloading so a genuinely broken renderer reloads at most once.
    if (typeof window === "undefined" || rendererReloadAttempted()) return;
    try {
      sessionStorage.setItem(BOUNDARY_GUARD_KEY, "1");
    } catch {
      return; // can't record the guard → don't risk a reload loop
    }
    location.reload();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="review-wait">
        <p className="wait-line">// renderer unavailable</p>
        <p>
          The plan renderer failed to load — the daemon may have restarted with a new build, or
          the network dropped. <a href="">Reload</a> to fetch the current one.
        </p>
      </div>
    );
  }
}

function PrReviewLoop({
  session,
  quiz,
  threads,
  stream,
  now,
}: {
  session: ReviewLiveSession;
  quiz?: ReviewQuizPublicState;
  threads: PublicReviewThread[];
  stream: StreamEvent[];
  now: number;
}) {
  const detail = useReviewDetail(session.id, session.revision);
  const activityDock = (
    <ActivityDock
      stream={stream}
      status={session.status}
      now={now}
      className="pr-activity-dock"
      alwaysVisible
    />
  );
  if (session.revision < 1) {
    return (
      <div className="pr-authoring-shell">
        {activityDock}
        <main className="review-wait">
          <p className="wait-line">// report authoring in progress</p>
          <p>
            The frozen knowledge snapshot for PR head generation {session.review.revision} is ready.
            This screen will replace itself when the first report revision passes validation.
          </p>
        </main>
      </div>
    );
  }
  if (detail?.report === undefined || detail.report === null) {
    return (
      <div className="pr-authoring-shell">
        {activityDock}
        <p className="loading">loading review r{session.revision}…</p>
      </div>
    );
  }
  return <ProductionPrReviewScreen
    session={session}
    payload={detail.report}
    liveQuiz={quiz}
    liveThreads={threads}
    activityDock={activityDock}
  />;
}

/** The review loop: plan + rail + grill + interview + now-playing/console + approve + composer + drawer. */
function ReviewLoop({
  session,
  threads,
  transcript,
  stream,
  now,
}: {
  session: PlanLiveSession;
  threads: Thread[];
  transcript: TranscriptEntry[];
  /** The normalized live-activity stream (§10a) powering the bar + console. */
  stream: StreamEvent[];
  /** A ticking clock for the presence dot + activity timestamps. */
  now: number;
}) {
  const planRef = useRef<HTMLElement | null>(null);
  const keyRef = useRef(0);
  // Bumped on every composer open so the <Composer> remounts with an empty
  // body: c/q and the whole-plan affordance can retarget an open composer,
  // and a half-typed draft must never silently follow the new anchor.
  const composerSeq = useRef(0);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  // The open section ⋯ menu (review UI): the coarse-anchor path. Phone
  // (at: null) docks it as a bottom sheet; desktop drops it under the button.
  const [menu, setMenu] = useState<SectionMenuState | null>(null);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<ReviewView>("clean");
  // null = follow the server's last-reviewed baseline (threaded review and revision layer 3);
  // a number = the user picked another baseline from the diff controls.
  const [baseline, setBaseline] = useState<number | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);
  // The Interview panel is the single grill surface. useInterviewOpen owns its
  // open state: default-expanded during the grill phase (draft), open on load if a
  // question is already pending, and force-opened the instant a new unanswered
  // question arrives in any phase past grill (e.g. an agent question during
  // implementation), even over a manual collapse, so it is never missed. A manual
  // toggle otherwise sticks within a phase; a decision citation (ivTarget) opens it
  // regardless via the returned setter.
  const [interviewOpen, setInterviewOpen, toggleInterview] = useInterviewOpen(
    session.status === "draft",
    transcript,
  );
  // A decision citation sets `ivTarget` (nonce re-fires repeat clicks) and opens
  // the panel in the same commit, so the entry exists when its deep-link effect
  // runs.
  const [ivTarget, setIvTarget] = useState<InterviewTarget | null>(null);
  const ivNonce = useRef(0);
  const [approveOpen, setApproveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The artifact path from this tab's approve response; after a reload the
  // notice falls back to the destination folder (the path is not persisted
  // on the session summary — DECISIONS.md).
  const [approvedPath, setApprovedPath] = useState<string | null>(null);
  // The absolute home-archive path heard from the approve response, so the
  // read-only notice can name the home copy alongside the project path.
  const [approvedHome, setApprovedHome] = useState<string | null>(null);
  // Persistent thread marks (review UI): open threads + unsent drafts keep
  // their anchored plan text lit. `renderTick` re-fires the paint once the
  // lazy/memo'd PlanView commits (mount + every revision swap); `focusThread`
  // drives the reverse gesture — a tap on a lit span targets its rail thread.
  const [renderTick, setRenderTick] = useState(0);
  const onRendered = useCallback(() => setRenderTick((tick) => tick + 1), []);
  const [focusThread, setFocusThread] = useState<{ id: string; nonce: number } | null>(null);
  const focusNonce = useRef(0);
  // The painted lit set, mirrored for the click hit-test so onPlanClick stays
  // off the per-keystroke `litEntries` identity (updated in the paint effect).
  const litRef = useRef<LitThread[]>([]);
  const hasPlan = session.revision > 0;
  // Over = the session reached a terminal state (approval and archive lifecycle: approved /
  // implemented / implement_failed): the whole screen goes read-only — no
  // selection anchoring, no composer, no drawer, no cards. `implementing` is NOT
  // over — the agent is building the approved plan, so the screen stays
  // interactive (the SSE frame drives the status; an Approve & Implement leaves
  // this view live as `implementing` rather than ending it).
  const over = isOver(session.status);
  // `finalizing` (comment & approve, approval and archive lifecycle) is not over — the agent is folding the
  // open comments in and will commit — but the plan is locked while it does, so
  // the whole editing surface goes read-only just like `over`. The redirect-home
  // and approved-notice logic stays keyed on `over` (finalizing has no committed
  // artifact yet and is still an active session), so `readOnly` is the editing
  // gate while `over` stays the terminal gate.
  const finalizing = session.status === "finalizing";
  const readOnly = over || finalizing;
  // Approve is offered only while the plan still awaits a decision — not once
  // over, not while `finalizing` (a fold-in is in flight; the escape lives in the
  // ApprovingNote), and not while `implementing` (the daemon already rejects a
  // re-approve there; the agent is mid-build). The rest of the screen stays live
  // during `implementing` (comments, asks, the drawer) — only this terminal
  // control is withdrawn.
  const canApprove = !readOnly && session.status !== "implementing";
  // Selections only anchor in the clean view: diff lines are change telemetry,
  // not plan text the agent could re-locate (same honesty rule as the
  // chrome-selector guard in anchor.ts).
  const selection = useSelection(
    planRef,
    composer === null && menu === null && view === "clean" && !readOnly,
  );

  // Keyboard-aware bottom sheets (review UI): publish the keyboard inset the
  // sheets ride, and track the phone breakpoint that gates the scroll lock.
  useKeyboardInsetVar();
  const phone = useSheetViewport(SHEET_VIEWPORT);
  // One shared lock for every bottom sheet (composer, section ⋯ menu, approve),
  // not just the composer: any open sheet freezes the plan behind it so the
  // page stops drifting under the keyboard while typing. The gate mirrors the
  // sheets' own render guards exactly: the composer renders under
  // `composer !== null && !readOnly` (a whole-plan ask works pre-plan, no hasPlan
  // gate), the section ⋯ menu under `hasPlan && !readOnly`, and approve only under
  // `approveOpen && canApprove`. Tracking bare `approveOpen` would strand the lock
  // on with no sheet visible when an SSE status flip (Approve & Implement →
  // `implementing`, or a plain approve → `over`) clears `canApprove` while
  // `approveOpen` still lingers.
  const composerOrMenuOpen =
    !readOnly && (composer !== null || (hasPlan && menu !== null));
  const approveSheetOpen = approveOpen && canApprove;
  useScrollLock(phone && (composerOrMenuOpen || approveSheetOpen));

  const payload = useRevision(session.id, session.revision);
  const from = Math.min(baseline ?? session.lastReviewedRevision, session.revision);
  const diff = useDiff(session.id, from, session.revision);

  // Gutter markers (review UI): changed/added units vs the baseline, in clean view.
  // Joined to one string so PlanView's memo survives this loop's re-renders
  // (it ticks per selection change and drawer keystroke). A baseline of 0
  // means "never reviewed" — everything is new, so marking every section
  // would carry zero signal (DECISIONS.md). changedCount is the controls
  // strip's tally: all touched units, removals included.
  const { changedIds, changedCount } = useMemo(() => {
    if (!diff || diff.from === 0) return { changedIds: "", changedCount: 0 };
    const touched = diff.sections.filter((s) => s.status !== "unchanged");
    return {
      changedIds: touched
        .filter((s) => s.status !== "removed")
        .map((s) => s.id)
        .join(" "),
      changedCount: touched.length,
    };
  }, [diff]);

  // j/k targets, in plan order. Removed units only exist in the diff view;
  // the all-new r0 baseline only jumps there too (markers are off in clean).
  const jumpIds = useMemo(() => {
    if (!diff || (diff.from === 0 && view === "clean")) return [];
    return diff.sections
      .filter((s) => s.status !== "unchanged" && (view === "diff" || s.status !== "removed"))
      .map((s) => s.id);
  }, [diff, view]);
  const jumpAt = useRef(-1);
  const jumpKey = jumpIds.join(" ");
  useEffect(() => {
    jumpAt.current = -1; // a new target list restarts the walk from the top
  }, [jumpKey]);
  const jumpChanged = useCallback(
    (delta: 1 | -1) => {
      if (jumpIds.length === 0) return;
      const next = Math.min(Math.max(jumpAt.current + delta, 0), jumpIds.length - 1);
      jumpAt.current = next;
      const id = jumpIds[next];
      if (planRef.current && id !== undefined) flashAnchor(planRef.current, { section: id });
    },
    [jumpIds],
  );

  // The lit set: open questions (one ink) and open comments + unsent drawer
  // drafts (another), each with a re-locatable quote. Answered/resolved threads
  // drop out (so their mark clears on the next paint); orphaned and whole-plan
  // (null/quote-less) anchors are never lit — no text to paint (review UI).
  const litEntries = useMemo<LitThread[]>(() => {
    const lit: LitThread[] = [];
    // Conversation roots the reviewer closed (Resolve lives on the root). A
    // follow-up turn keys on its root, so a resolved root clears the whole chain.
    const resolvedRoots = new Set(threads.filter((t) => t.resolved).map((t) => t.id));
    // Mark is carried by the conversation ROOT, lit once per conversation (not
    // once per turn — every turn shares the root's anchor). A question root with
    // an unanswered follow-up still owes an answer, so owe-status spans all turns.
    const owesAnswer = new Set(
      threads
        .filter((t) => t.kind === "question" && t.answer === undefined)
        .map((t) => t.replyTo ?? t.id),
    );
    for (const thread of threads) {
      if (thread.anchorState === "orphaned" || !thread.anchor?.exact) continue;
      // Only roots carry the mark; a follow-up turn inherits the root's anchor and
      // would just re-light the same quote, so skip it (the root covers the chain).
      if (thread.replyTo !== undefined) continue;
      if (resolvedRoots.has(thread.id)) continue; // reviewer closed the whole conversation
      if (thread.kind === "question") {
        // A question conversation's mark clears once every turn is answered.
        if (owesAnswer.has(thread.id)) {
          lit.push({ id: thread.id, anchor: thread.anchor, kind: "question" });
        }
      } else {
        // A comment conversation's mark clears only when the REVIEWER resolves it
        // (a landed agent reply is a response, not a close — the mark stays lit).
        lit.push({ id: thread.id, anchor: thread.anchor, kind: "comment" });
      }
    }
    for (const item of pending) {
      if (item.anchor?.exact) {
        lit.push({ id: `draft:${item.key}`, anchor: item.anchor, kind: "comment" });
      }
    }
    return lit;
  }, [threads, pending]);
  // A stable signature over the painted set (ids + the fields that locate each
  // quote), so a drawer body keystroke — new `pending` identity, same anchors —
  // yields the same value and the paint effect below never re-fires for it.
  // Control-char delimiters (NUL within a row, newline between rows) so a
  // free-text quote/prefix can't collide into a false-equal signature and
  // drop a needed repaint — plan text carries neither.
  const litSig = litEntries
    .map((e) => [e.id, e.kind, e.anchor.section, e.anchor.exact, e.anchor.prefix].join("\u0000"))
    .join("\n");

  // Paint by registering Ranges, never by re-rendering PlanView (DECISIONS.md:
  // a re-render rewrites the DOM and kills selections). Gated on
  // litSig/view/renderTick — anchor-set changes, the diff toggle, and the
  // lazy/revision DOM swaps — so it skips per-keystroke churn. litEntries is
  // read fresh; litSig is the real trigger.
  useLayoutEffect(() => {
    litRef.current = litEntries;
    const plan = planRef.current;
    if (!plan) return;
    if (view === "clean") paintThreads(plan, litEntries);
    else clearThreadHighlights();
  }, [litSig, view, renderTick]);

  // On unmount (leaving the review, or switching sessions — this loop is keyed
  // by session id), clear the persistent marks: the CSS highlight registry is
  // global, so otherwise a session's ranges would linger on the next screen.
  // The arrow returns clearThreadHighlights *as the cleanup* — it runs on
  // teardown, not on mount.
  useEffect(() => clearThreadHighlights, []);

  // Reload / close-tab guard (review UI): drawer drafts live only in this
  // browser until Send, so a reload or tab-close would wipe them with no warning.
  // Register beforeunload only while drafts are actually staged and tear it down
  // the moment the drawer empties (sent or deleted), so a clean session never
  // prompts. Scope is reload/close-tab only (navigate-away and half-typed
  // composer text stay out of scope, plan q2); the daemon never sees them (D5).
  useEffect(() => {
    if (pending.length === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = ""; // some browsers gate the prompt on a set returnValue
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [pending.length]);

  // No re-review prompt while the editing surface is locked: not on an approved
  // session (the review is over), and not while `finalizing` (the agent's fold-in
  // bumps the revision, but the screen is read-only awaiting the commit).
  const fresh =
    !readOnly && hasPlan && session.revision >= 2 && session.lastReviewedRevision < session.revision;
  // The banner must quote the *landed* revision's changelog; while the
  // payload refetch is in flight the previous revision stays rendered, so
  // gate on the revision number instead of showing the stale changelog.
  const currentChangelog = payload?.revision === session.revision ? payload.changelog : undefined;

  const clearSelection = () => document.getSelection()?.removeAllRanges();

  const openComposer = useCallback((mode: "comment" | "ask", sel: CapturedSelection) => {
    composerSeq.current += 1;
    setComposer({
      mode,
      anchor: sel.anchor,
      at: composerPlacement(sel.rect, { width: window.innerWidth, height: window.innerHeight }),
    });
  }, []);

  // Keyboard: c = comment on selection, q = ask, j/k = jump changed sections
  // (review UI — there is no Approve shortcut, on purpose). Esc closes
  // the composer from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === "Escape") {
        setComposer(null);
        return;
      }
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        jumpChanged(event.key === "j" ? 1 : -1);
        return;
      }
      if (event.key !== "c" && event.key !== "q") return;
      if (view !== "clean" || readOnly) return; // diff lines / locked sessions are not anchorable
      const plan = planRef.current;
      const sel = plan ? captureSelection(plan) : null;
      if (!sel) return;
      event.preventDefault();
      openComposer(event.key === "c" ? "comment" : "ask", sel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openComposer, jumpChanged, view, readOnly]);

  const stack = (body: string) => {
    if (!composer) return;
    const key = (keyRef.current += 1);
    const anchor = composer.anchor;
    setPending((prev) => [...prev, { key, anchor, body }]);
    setComposer(null);
    clearSelection();
  };

  // Drawer sends only: busy/failed are the drawer bar's state. The composer's
  // own send paths (sendNow/ask below) render their own failure hint and must
  // never light the drawer's "send failed — retry" over a batch they didn't touch.
  const sendItems = async (items: CommentDraft[]): Promise<boolean> => {
    setBusy(true);
    setFailed(false);
    const ok = await postComments(session.id, items);
    setBusy(false);
    setFailed(!ok);
    return ok;
  };

  // Shared composer success protocol: close it and drop the selection.
  const submitComposer = async (post: () => Promise<boolean>): Promise<boolean> => {
    const ok = await post();
    if (ok) {
      setComposer(null);
      clearSelection();
    }
    return ok;
  };

  const sendNow = (body: string): Promise<boolean> =>
    composer
      ? submitComposer(() => postComments(session.id, [{ anchor: composer.anchor, body }]))
      : Promise.resolve(false);

  const ask = (body: string): Promise<boolean> =>
    composer
      ? submitComposer(() => postQuestion(session.id, composer.anchor, body))
      : Promise.resolve(false);

  // Drop exactly the sent drafts from pending: a draft stacked from the composer
  // while the POST was in flight stays pending instead of being silently wiped.
  const dropSent = (batch: PendingComment[]) =>
    setPending((prev) => {
      const sent = new Set(batch.map((item) => item.key));
      return prev.filter((entry) => !sent.has(entry.key));
    });

  const sendAll = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    if (await sendItems(batch.map(({ anchor, body }) => ({ anchor, body })))) dropSent(batch);
  };

  // The approve drafts gate's flush (review UI): POST the non-blank drafts and
  // drop exactly those, WITHOUT lighting the drawer's busy/failed. The dialog owns
  // its own busy/error, and the drawer dimmed behind the approve scrim must not
  // flash state for a batch its own Send never started. Blank drafts are skipped,
  // mirroring the drawer's send-all `blocked` guard: the daemon 400s a whole batch
  // that carries any empty body, which would otherwise strand every draft.
  const flushDrafts = async (): Promise<boolean> => {
    const batch = pending.filter((item) => item.body.trim() !== "");
    if (batch.length === 0) return true;
    const ok = await postComments(
      session.id,
      batch.map(({ anchor, body }) => ({ anchor, body })),
    );
    if (ok) dropSent(batch);
    return ok;
  };

  const sendOne = async (key: number) => {
    const item = pending.find((entry) => entry.key === key);
    if (!item) return;
    if (await sendItems([{ anchor: item.anchor, body: item.body }])) dropSent([item]);
  };

  const edit = (key: number, body: string) =>
    setPending((prev) => prev.map((entry) => (entry.key === key ? { ...entry, body } : entry)));
  const remove = (key: number) =>
    setPending((prev) => prev.filter((entry) => entry.key !== key));

  const jump = useCallback((anchor: Anchor) => {
    if (planRef.current) flashAnchor(planRef.current, anchor);
  }, []);

  // A follow-up on an existing conversation (threaded review and revision):
  // inherits the root's anchor server-side, so the rail only passes the root id +
  // body. The rail is kind-agnostic; route by the root thread's kind — a comment
  // root's follow-up rides the comments route (revision-tied, answered via the
  // agent's revise/submit loop), a question root's rides the questions route
  // (answered out-of-band via `otacon answer`). A missing root (a degraded card
  // never offers the box) falls back to the question route.
  const followup = useCallback(
    (rootId: string, body: string): Promise<boolean> => {
      const root = threads.find((t) => t.id === rootId);
      return root?.kind === "comment"
        ? postCommentFollowup(session.id, rootId, body)
        : postFollowup(session.id, rootId, body);
    },
    [session.id, threads],
  );

  // The reviewer's Resolve verb on a conversation root: close (`resolved:true`)
  // or reopen (`false`); the close lands back over the `thread` SSE frame.
  const resolve = useCallback(
    (threadId: string, resolved: boolean): Promise<boolean> => postResolve(session.id, threadId, resolved),
    [session.id],
  );

  // Decision deep-links (interview questions) and the section ⋯ menus (review UI) are both
  // delegated here, so PlanView takes no callback props and its memo survives.
  // `← q7` citations render as `a.q-cite[data-q]`; the menu buttons as
  // `button.sec-menu[data-menu]`.
  const onPlanClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const target = event.target as Element | null;
      const menuBtn = target?.closest?.("button.sec-menu");
      if (menuBtn) {
        if (readOnly) return; // read-only: the buttons are hidden, but belt and braces
        const id = (menuBtn as HTMLElement).dataset.menu;
        if (id === undefined) return;
        const rect = menuBtn.getBoundingClientRect();
        setMenu(
          window.innerWidth < SHEET_VIEWPORT
            ? { id, at: null } // a popover doesn't fit a phone: bottom sheet
            : { id, at: { x: rect.right, y: rect.bottom } },
        );
        return;
      }
      const cite = target?.closest?.("a.q-cite");
      if (cite) {
        event.preventDefault();
        const id = (cite as HTMLElement).dataset.q;
        if (id !== undefined && transcript.some((entry) => entry.id === id)) {
          setInterviewOpen(true);
          setIvTarget({ id, nonce: (ivNonce.current += 1) });
        }
        return;
      }
      // A tap (collapsed selection) inside a lit span focuses its rail thread; a
      // drag is select-to-comment, so a real selection is never hijacked. Clean
      // view only — diff lines aren't anchored, a locked session paints nothing.
      if (readOnly || view !== "clean") return;
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed) return;
      const plan = planRef.current;
      if (!plan) return;
      const hit = threadAtPoint(plan, litRef.current, event.clientX, event.clientY);
      if (hit !== null) setFocusThread({ id: hit, nonce: (focusNonce.current += 1) });
    },
    [transcript, readOnly, view],
  );

  // The ⋯ menu's verbs ride the existing composer with a section-only anchor
  // ({section}, no exact quote — plan structure, lint, and anchoring anchors don't require one). A
  // zero-width rect at the button's corner reuses openComposer's placement:
  // pinned under the ⋯ on desktop, the sheet on phones.
  const menuCompose = (mode: "comment" | "ask") => {
    if (!menu) return;
    const at = menu.at ?? { x: 0, y: 0 };
    openComposer(mode, {
      anchor: { section: menu.id },
      rect: { top: at.y, bottom: at.y, left: at.x, width: 0 },
    });
    setMenu(null);
  };

  // The sticky bar's ❓ (review UI): open the Interview panel and deep-link the
  // first open question, reusing the interview's scroll + flash machinery.
  const openQuestions = transcript.filter((entry) => entry.answer === undefined).length;
  const jumpQuestions = useCallback(() => {
    const firstOpen = transcript.find((entry) => entry.answer === undefined);
    setInterviewOpen(true);
    if (firstOpen) setIvTarget({ id: firstOpen.id, nonce: (ivNonce.current += 1) });
  }, [transcript]);

  // The rail's empty-state ask: open the ask composer on a null (whole-plan)
  // anchor, mirroring the drawer's `onWholePlan` but in ASK mode. `at:null`
  // docks it as a bottom sheet on phones, same as the whole-plan comment path.
  // This is the only ask surface before a plan exists (no plan text to select),
  // so the reviewer can put a whole-plan question to the agent during the grill.
  const askWholePlan = useCallback(() => {
    composerSeq.current += 1;
    setComposer({ mode: "ask", anchor: null, at: null });
  }, []);

  return (
    <>
      <ReviewHeader
        session={session}
        now={now}
        view={view}
        onView={setView}
        hasPlan={hasPlan}
        onApprove={canApprove ? () => setApproveOpen(true) : undefined}
        onDelete={() => setDeleteOpen(true)}
      />
      {/* The always-on now-playing bar + the console it expands (§10a), pinned
          directly under the header, shown during pre-plan research too (not
          gated on hasPlan), since that is exactly when the user is waiting. */}
      <ActivityDock stream={stream} status={session.status} now={now} />
      <div className="review-layout">
        <div className="review-main">
          {/* The reviewer's verbatim request, echoed at the top of the column:
              present from session start (not gated on a plan), collapsed by
              default, absent when no prompt was captured. */}
          <PromptCard prompt={session.prompt} />
          {over && <ApprovedNote path={approvedPath} home={approvedHome} />}
          {finalizing && <ApprovingNote sessionId={session.id} />}
          {hasPlan && (
            <ReviewControls
              view={view}
              revision={session.revision}
              lastReviewed={session.lastReviewedRevision}
              baseline={from}
              onBaseline={setBaseline}
              changedCount={changedCount}
              showChangelog={!fresh && currentChangelog != null}
              changelogOpen={changelogOpen}
              onToggleChangelog={() => setChangelogOpen((value) => !value)}
            />
          )}
          {fresh && (
            <RevisionBanner
              revision={session.revision}
              changelog={currentChangelog}
              fresh
              onViewDiff={() => setView("diff")}
              // Pin the revision the banner showed: if a newer one lands on
              // the daemon in the click-to-POST window, only what the user
              // actually read gets marked reviewed — the banner stays up for
              // the newcomer instead of silently swallowing it.
              onDismiss={() => postReviewed(session.id, session.revision)}
              onClose={() => undefined}
            />
          )}
          {!fresh && changelogOpen && currentChangelog != null && (
            <RevisionBanner
              revision={session.revision}
              changelog={currentChangelog}
              fresh={false}
              onViewDiff={() => setView("diff")}
              onDismiss={() => Promise.resolve(true)}
              onClose={() => setChangelogOpen(false)}
            />
          )}
          <InterviewPanel
            sessionId={session.id}
            transcript={transcript}
            open={interviewOpen}
            onToggle={toggleInterview}
            target={ivTarget}
            editable={!readOnly}
          />
          {hasPlan ? (
            <main
              className={readOnly ? "review review-over" : "review"}
              ref={planRef}
              onClick={onPlanClick}
            >
              {view === "clean" ? (
                payload ? (
                  <RendererBoundary>
                    <Suspense fallback={<p className="loading">loading renderer…</p>}>
                      <PlanView
                        markdown={payload.markdown}
                        warnings={payload.warnings}
                        changedIds={changedIds}
                        onRendered={onRendered}
                      />
                    </Suspense>
                  </RendererBoundary>
                ) : (
                  <p className="loading">loading r{session.revision}…</p>
                )
              ) : diff ? (
                <DiffView diff={diff} />
              ) : (
                <p className="loading">computing diff…</p>
              )}
            </main>
          ) : (
            <main className="review-wait">
              <p className="wait-line">// no revision yet</p>
              {/* During research + drafting the live console above is the main
                  thing to watch: the always-on now-playing bar surfaces the
                  work (one click expands the console), so the placeholder no
                  longer carries its own activity line. */}
              <p>
                The agent interviews before it drafts — questions land above as cards, one at a
                time. The plan renders here the moment revision 1 passes the linter; this screen
                updates live.
              </p>
            </main>
          )}
        </div>
        {/* Always mounted: the desktop right column is never blank. The rail
            renders its own empty-state placeholder when there are no threads,
            including during research/grill before a plan exists. */}
        <ThreadsRail
          threads={threads}
          onJump={jump}
          focus={focusThread}
          onFollowup={readOnly ? undefined : followup}
          onResolve={readOnly ? undefined : resolve}
          hasPlan={hasPlan}
          onAsk={readOnly ? undefined : askWholePlan}
        />
      </div>
      {approveOpen && canApprove && (
        <ApproveDialog
          sessionId={session.id}
          revision={session.revision}
          // The drawer holds browser-only drafts the daemon never saw; the gate
          // catches them before finalize (Send & approve flushes + folds in,
          // Discard & approve drops them) rather than letting Approve silently
          // skip them (review UI, approval and archive lifecycle). Count only sendable (non-blank)
          // drafts: a half-typed blank isn't a comment to protect, and flushing
          // it would 400 the whole batch.
          pendingCount={pending.filter((item) => item.body.trim() !== "").length}
          onFlushDrafts={flushDrafts}
          onDiscardDrafts={() => setPending([])}
          onClose={() => setApproveOpen(false)}
          onApproved={(path, home, implement) => {
            // Save: the session SSE frame flips the status (and this screen) to
            // approved; the saved path + home archive render in the read-only
            // notice. Implement: the frame arrives as `implementing` (not over),
            // so the screen stays interactive and the notice never shows — don't
            // pin it (it would mislead if the build later ends).
            if (!implement) {
              setApprovedPath(path);
              setApprovedHome(home);
            }
            setApproveOpen(false);
          }}
        />
      )}
      {deleteOpen && (
        <DeleteDialog
          sessionId={session.id}
          sessionKind="plan"
          approved={over}
          onClose={() => setDeleteOpen(false)}
          // The session is gone — leave for the index rather than waiting for
          // the `removed` frame to flip this screen to its closed state.
          onDeleted={() => navigate("/")}
        />
      )}
      {/* The composer is NOT gated on hasPlan: a whole-plan ask (from the rail's
          empty state) must work during the grill phase before a plan exists. Its
          submit paths key on `composer.anchor`, null for a whole-plan question,
          which `ask` posts via postQuestion(session.id, null, body). */}
      {composer !== null && !readOnly && (
        <Composer
          key={composerSeq.current}
          state={composer}
          onClose={() => setComposer(null)}
          onStack={stack}
          onSendNow={sendNow}
          onAsk={ask}
        />
      )}
      {/* The selection bar, the section ⋯ menu, and the drawer are comment-on-plan
          affordances: they need plan text / a rendered plan, so they stay gated
          on hasPlan (and not read-only). */}
      {hasPlan && !readOnly && (
        <>
          {selection !== null && composer === null && (
            <SelectionBar
              selection={selection}
              onComment={() => openComposer("comment", selection)}
              onAsk={() => openComposer("ask", selection)}
            />
          )}
          {menu !== null && composer === null && (
            <SectionMenu
              state={menu}
              onComment={() => menuCompose("comment")}
              onAsk={() => menuCompose("ask")}
              onClose={() => setMenu(null)}
            />
          )}
          <CommentDrawer
            pending={pending}
            busy={busy}
            failed={failed}
            questions={openQuestions}
            onQuestions={jumpQuestions}
            // Withdraw the drawer's approve control once the plan is past a
            // decision (implementing/over) — matches the header (canApprove).
            onApprove={canApprove ? () => setApproveOpen(true) : undefined}
            onEdit={edit}
            onDelete={remove}
            onSendOne={sendOne}
            onSendAll={sendAll}
            onWholePlan={() => {
              composerSeq.current += 1;
              setComposer({ mode: "comment", anchor: null, at: null });
            }}
          />
        </>
      )}
    </>
  );
}

export function SessionScreen({ id }: { id: string }) {
  const { session, quiz, threads, transcript, stream, missing, cleaned } = useSession(id);
  // One ticking clock for the presence dot + activity/relative timestamps, so
  // they stay honest while the screen idles between SSE frames.
  const now = useNow(30_000);
  // Report visibility so the daemon suppresses desktop banners only while this
  // review is actually on screen (review loop and daemon API).
  usePresence(id);

  const revision = session?.revision;
  useEffect(() => {
    if (session && revision !== undefined) markSeen(session.id, revision);
  }, [session, revision]);

  // When the session you're viewing crosses into an over (terminal) state, its
  // switcher chip is gone (session registry and switcher) so send yourself home, where the collapsed
  // section holds it (approval and archive lifecycle, D3). Fire only on the live active → over
  // crossing: opening a session that is ALREADY over (you tapped a card in the
  // collapsed section on home) must stay, or finished plans become unopenable.
  // `sawActive` records that we observed a non-terminal status first, so the
  // ref's initial false can't be mistaken for one. A `session` SSE frame
  // flipping it remotely still redirects (accepted, q5). `implementing` is NOT
  // over, so an Approve & Implement keeps you on the live build screen rather
  // than bouncing home.
  //
  // The crossing is per-session: this screen is NOT remounted when `id` changes
  // (app.tsx routes without a key), so reset the ref on every `id` switch —
  // otherwise the "saw active" set while reading one session would leak across a
  // navigation and bounce the next already-over session you open straight
  // back home (the very unopenable case the guard exists to prevent).
  const sawActive = useRef(false);
  useEffect(() => {
    sawActive.current = false;
  }, [id]);
  useEffect(() => {
    if (!session) return;
    // Review reports remain readable after Done. Their terminal lifecycle is
    // independent from the plan switcher's active -> archive redirect.
    if (shouldRedirectAfterTerminalTransition(session, sawActive.current)) {
      navigate("/");
    } else if (session.kind === "plan" && !isOver(session.status)) {
      sawActive.current = true;
    }
  }, [session]);

  // A `removed` frame landed while this screen was open (approval and archive lifecycle): the
  // session left the registry (`otacon clean` removed a finished one, or it
  // was deleted from review). The frame carries no reason, so the copy covers
  // both. A terminal state, not an error: the stream is closed, and
  // the app shell (sidebar ≥960px, the ☰ session sheet below it) still offers
  // every live session.
  // Because the shell provides session switching + the home link on every route,
  // these closed/unknown/loading shells carry no topbar of their own — just the
  // message body, centered in the content track.
  if (cleaned) {
    return (
      <div className="page">
        <main className="empty">
          <p className="empty-title">session closed</p>
          <p className="empty-body">
            This session left the codec: approved and cleaned, or deleted from review. Its home
            folder is gone for good. An approved plan survives as the saved copy in your project (or
            in the PR for Implement plans).
          </p>
        </main>
      </div>
    );
  }
  if (missing) {
    return (
      <div className="page">
        <main className="empty">
          <p className="empty-title">unknown session</p>
          <p className="empty-body">
            The daemon has no session <code>{id}</code>. It may have been cleaned, or the link is
            stale.
          </p>
        </main>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="page">
        <p className="loading">connecting…</p>
      </div>
    );
  }

  if (session.kind === "review") {
    return <PrReviewLoop
      session={session}
      quiz={quiz}
      threads={threads.filter((thread): thread is PublicReviewThread => "surface" in thread && thread.surface === "review")}
      stream={stream}
      now={now}
    />;
  }

  return (
    <div className="page page-review" style={accentStyle(session.id)}>
      {/* ReviewHeader (rendered inside ReviewLoop) is the sticky masthead —
          back + identity + controls + the ☰ session-list menu — so there is no separate
          topbar here. The cleaned/missing/loading shells above carry no topbar
          either: no plan exists there, and the app shell already provides
          switching + home on every route. */}
      <ReviewLoop
        key={session.id}
        session={session}
        threads={threads.filter((thread): thread is Thread => !("surface" in thread))}
        transcript={transcript}
        stream={stream}
        now={now}
      />
    </div>
  );
}
