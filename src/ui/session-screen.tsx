// The /s/:id review screen: session header in the session's accent color,
// live over its SSE stream, rendering the latest stored revision as the plan
// dossier (DESIGN.md §10) — with the review loop's desktop verbs (select text
// → toolbar, comments batch in the drawer, questions fire instantly, threads
// in the rail), M3's re-review layer (banner, [clean|diff] + baseline picker,
// gutter markers, j/k), and M4's grill + approve surfaces: agent-question
// cards pinned above the plan (useful pre-plan — the grill happens before
// drafting), the collapsible Interview panel that decision citations
// deep-link into, and the warn-then-force Approve control. Keyboard:
// c = comment, q = ask, j/k = changed sections; no Approve shortcut exists,
// deliberately (§10). Approved sessions render read-only behind the quiet
// approved notice. The renderer stays a lazy chunk.

import type { MouseEvent, ReactNode, RefObject } from "react";
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accentStyle } from "./accent";
import type { ActivityNote, Anchor, CommentDraft, LiveSession, Thread, TranscriptEntry } from "./api";
import {
  postComments,
  postQuestion,
  postReviewed,
  useDiff,
  usePresence,
  useRevision,
  useSession,
} from "./api";
import { AgentDot, LinkState, StatusChip } from "./chip";
import { relativeTime, repoName } from "./format";
import { ActivityLog } from "./review/activity";
import { captureSelection, flashAnchor, motionSafeScroll } from "./review/anchor";
import type { CapturedSelection } from "./review/anchor";
import { ApproveDialog, ApprovedNote } from "./review/approve";
import { DeleteDialog } from "./review/delete";
import type { ReviewView } from "./review/banner";
import { ReviewControls, RevisionBanner } from "./review/banner";
import { DiffView } from "./review/diff";
import type { PendingComment } from "./review/drawer";
import { CommentDrawer } from "./review/drawer";
import type { ComposerState } from "./review/feedback";
import { Composer, SelectionToolbar, useSelection } from "./review/feedback";
import { GrillQueue } from "./review/grill";
import type { InterviewTarget } from "./review/interview";
import { InterviewPanel } from "./review/interview";
import { ThreadsRail } from "./review/rail";
import type { SectionMenuState } from "./review/section-menu";
import { SectionMenu } from "./review/section-menu";
import { navigate } from "./router";
import { markSeen } from "./seen";
import { SessionSwitcher } from "./switcher";
import { useNow } from "./tick";

const PlanView = lazy(() => import("./plan/plan-view"));

function BackLink() {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    navigate("/");
  };
  return (
    <a className="backlink" href="/" onClick={onClick}>
      ← sessions
    </a>
  );
}

/**
 * Catches a failed plan-view chunk load (offline, or a stale tab whose chunk
 * URLs vanished when the daemon was rebuilt) — and any renderer crash —
 * instead of letting React unmount the whole tree to a blank page. React
 * caches a lazy() rejection, so recovery is a real reload, not a re-render.
 */
class RendererBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="review-wait">
        <p className="wait-line">// renderer unavailable</p>
        <p>
          The plan renderer failed to load — the daemon may have restarted with a new build, or
          the network dropped. <a href="">Reload</a> to fetch the current one.
        </p>
      </main>
    );
  }
}

function SessionHead({
  session,
  connected,
  now,
  onDelete,
}: {
  session: LiveSession;
  connected: boolean;
  now: number;
  /** Opens the delete confirm sheet; every session is deletable (DESIGN.md §10). */
  onDelete?: () => void;
}) {
  return (
    <header className="session-head">
      <div className="session-head-top">
        <h1 className="session-title">{session.title}</h1>
        <span className="session-rev">r{session.revision}</span>
      </div>
      <p className="session-where" title={session.repo}>
        {repoName(session.repo)}
        {session.branch !== "" && <span> · {session.branch}</span>}
      </p>
      <div className="session-meta">
        <StatusChip
          status={session.status}
          openQuestions={session.openQuestions}
          latestActivity={session.latestActivity}
        />
        <AgentDot
          status={session.status}
          parked={session.parked}
          lastContactAt={session.lastContactAt}
          now={now}
        />
        <span className="card-time">{relativeTime(session.updatedAt, now)}</span>
        <LinkState connected={connected} />
        {onDelete && (
          <button
            type="button"
            className="session-delete"
            title="delete session"
            onClick={onDelete}
          >
            ✕ delete
          </button>
        )}
      </div>
    </header>
  );
}

const COMPOSER_WIDTH = 380;
const COMPOSER_GUESS_HEIGHT = 240;
// The phone face: below this width the composer and the section ⋯ menu dock as
// bottom sheets instead of floating popovers. Kept in lockstep with the CSS
// `max-width: 639px` breakpoint that swaps the bar/switcher faces (styles.css)
// — so the whole phone control surface (chips, sticky bar, sheets) flips
// together; a tablet-band gap where the visual face is the phone's but a tap
// opened a desktop popover anchored off-thumb would otherwise sit at 560–639px.
const SHEET_VIEWPORT = 640;

/** The review loop: plan + rail + grill + interview + activity + approve + composer + drawer. */
function ReviewLoop({
  session,
  threads,
  transcript,
  activity,
  connected,
  now,
}: {
  session: LiveSession;
  threads: Thread[];
  transcript: TranscriptEntry[];
  activity: ActivityNote[];
  connected: boolean;
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
  // The open section ⋯ menu (DESIGN.md §10): the coarse-anchor path. Phone
  // (at: null) docks it as a bottom sheet; desktop drops it under the button.
  const [menu, setMenu] = useState<SectionMenuState | null>(null);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<ReviewView>("clean");
  // null = follow the server's last-reviewed baseline (DESIGN.md §9 layer 3);
  // a number = the user picked another baseline from the diff controls.
  const [baseline, setBaseline] = useState<number | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);
  // The Interview panel (DESIGN.md §8): open state is screen-local; a
  // decision citation sets `ivTarget` (nonce re-fires repeat clicks) and
  // opens the panel in the same commit, so the entry exists when its
  // deep-link effect runs.
  const [interviewOpen, setInterviewOpen] = useState(false);
  const [ivTarget, setIvTarget] = useState<InterviewTarget | null>(null);
  const ivNonce = useRef(0);
  const [approveOpen, setApproveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The artifact path from this tab's approve response; after a reload the
  // notice falls back to the destination folder (the path is not persisted
  // on the session summary — DECISIONS.md).
  const [approvedPath, setApprovedPath] = useState<string | null>(null);
  const hasPlan = session.revision > 0;
  // Approved = the session is over (DESIGN.md §12): the whole screen goes
  // read-only — no selection anchoring, no composer, no drawer, no cards.
  const over = session.status === "approved";
  // Selections only anchor in the clean view: diff lines are change telemetry,
  // not plan text the agent could re-locate (same honesty rule as the
  // chrome-selector guard in anchor.ts).
  const selection = useSelection(
    planRef,
    composer === null && menu === null && view === "clean" && !over,
  );

  const payload = useRevision(session.id, session.revision);
  const from = Math.min(baseline ?? session.lastReviewedRevision, session.revision);
  const diff = useDiff(session.id, from, session.revision);

  // Gutter markers (§10): changed/added units vs the baseline, in clean view.
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

  // No re-review prompt on an approved session: the review is over.
  const fresh =
    !over && hasPlan && session.revision >= 2 && session.lastReviewedRevision < session.revision;
  // The banner must quote the *landed* revision's changelog; while the
  // payload refetch is in flight the previous revision stays rendered, so
  // gate on the revision number instead of showing the stale changelog.
  const currentChangelog = payload?.revision === session.revision ? payload.changelog : undefined;

  const clearSelection = () => document.getSelection()?.removeAllRanges();

  const openComposer = useCallback((mode: "comment" | "ask", sel: CapturedSelection) => {
    composerSeq.current += 1;
    if (window.innerWidth < SHEET_VIEWPORT) {
      // Selection popovers don't fit a phone; the composer becomes a sheet.
      setComposer({ mode, anchor: sel.anchor, at: null });
      return;
    }
    const width = Math.min(COMPOSER_WIDTH, window.innerWidth - 24);
    const x = Math.min(
      Math.max(sel.rect.left + sel.rect.width / 2, width / 2 + 12),
      window.innerWidth - width / 2 - 12,
    );
    const below = sel.rect.bottom + 12;
    const y =
      below + COMPOSER_GUESS_HEIGHT > window.innerHeight
        ? Math.max(12, sel.rect.top - COMPOSER_GUESS_HEIGHT - 12)
        : below;
    setComposer({ mode, anchor: sel.anchor, at: { x, y } });
  }, []);

  // Keyboard: c = comment on selection, q = ask, j/k = jump changed sections
  // (DESIGN.md §10 — there is no Approve shortcut, on purpose). Esc closes
  // the composer from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
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
      if (view !== "clean" || over) return; // diff lines / ended sessions are not anchorable
      const plan = planRef.current;
      const sel = plan ? captureSelection(plan) : null;
      if (!sel) return;
      event.preventDefault();
      openComposer(event.key === "c" ? "comment" : "ask", sel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openComposer, jumpChanged, view, over]);

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

  const sendAll = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    const ok = await sendItems(batch.map(({ anchor, body }) => ({ anchor, body })));
    // Remove exactly what was sent: a draft stacked from the composer while
    // the POST was in flight stays pending instead of being silently wiped.
    if (ok) {
      const sent = new Set(batch.map((item) => item.key));
      setPending((prev) => prev.filter((entry) => !sent.has(entry.key)));
    }
  };

  const sendOne = async (key: number) => {
    const item = pending.find((entry) => entry.key === key);
    if (!item) return;
    const ok = await sendItems([{ anchor: item.anchor, body: item.body }]);
    if (ok) setPending((prev) => prev.filter((entry) => entry.key !== key));
  };

  const edit = (key: number, body: string) =>
    setPending((prev) => prev.map((entry) => (entry.key === key ? { ...entry, body } : entry)));
  const remove = (key: number) =>
    setPending((prev) => prev.filter((entry) => entry.key !== key));

  const jump = useCallback((anchor: Anchor) => {
    if (planRef.current) flashAnchor(planRef.current, anchor);
  }, []);

  // Decision deep-links (DESIGN.md §8) and the section ⋯ menus (§10) are both
  // delegated here, so PlanView takes no callback props and its memo survives.
  // `← q7` citations render as `a.q-cite[data-q]`; the menu buttons as
  // `button.sec-menu[data-menu]`.
  const onPlanClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const target = event.target as Element | null;
      const menuBtn = target?.closest?.("button.sec-menu");
      if (menuBtn) {
        if (over) return; // read-only: the buttons are hidden, but belt and braces
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
      if (!cite) return;
      event.preventDefault();
      const id = (cite as HTMLElement).dataset.q;
      if (id === undefined || !transcript.some((entry) => entry.id === id)) return;
      setInterviewOpen(true);
      setIvTarget({ id, nonce: (ivNonce.current += 1) });
    },
    [transcript, over],
  );

  // The ⋯ menu's verbs ride the existing composer with a section-only anchor
  // ({section}, no exact quote — DESIGN.md §4 anchors don't require one). A
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

  // The sticky bar's ❓ (DESIGN.md §10): jump back up to the question queue.
  const openQuestions = transcript.filter((entry) => entry.answer === undefined).length;
  const jumpQuestions = useCallback(() => {
    const queue = document.querySelector(".grill-queue");
    if (queue) motionSafeScroll(queue, "start");
  }, []);

  const toggleInterview = useCallback(() => setInterviewOpen((value) => !value), []);

  return (
    <>
      <div className="review-layout">
        <div className="review-main">
          <SessionHead
            session={session}
            connected={connected}
            now={now}
            onDelete={() => setDeleteOpen(true)}
          />
          {over && <ApprovedNote path={approvedPath} />}
          {hasPlan && (
            <ReviewControls
              view={view}
              onView={setView}
              revision={session.revision}
              lastReviewed={session.lastReviewedRevision}
              baseline={from}
              onBaseline={setBaseline}
              changedCount={changedCount}
              showChangelog={!fresh && currentChangelog != null}
              changelogOpen={changelogOpen}
              onToggleChangelog={() => setChangelogOpen((value) => !value)}
              onApprove={over ? undefined : () => setApproveOpen(true)}
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
          {!over && <GrillQueue sessionId={session.id} transcript={transcript} />}
          <InterviewPanel
            transcript={transcript}
            open={interviewOpen}
            onToggle={toggleInterview}
            target={ivTarget}
          />
          {/* The review screen keeps the feed as a compact collapsible panel;
              the pre-plan placeholder leads with it open (below). */}
          {hasPlan && <ActivityLog activity={activity} now={now} />}
          {hasPlan ? (
            <main
              className={over ? "review review-over" : "review"}
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
              {/* During research + drafting the activity log is the main thing
                  to watch, so the placeholder leads with it open (DESIGN.md §10). */}
              <ActivityLog activity={activity} now={now} defaultOpen />
              <p>
                The agent interviews before it drafts — questions land above as cards, one at a
                time. The plan renders here the moment revision 1 passes the linter; this screen
                updates live.
              </p>
            </main>
          )}
        </div>
        {hasPlan && <ThreadsRail threads={threads} onJump={jump} />}
      </div>
      {approveOpen && !over && (
        <ApproveDialog
          sessionId={session.id}
          revision={session.revision}
          onClose={() => setApproveOpen(false)}
          onApproved={(path) => {
            // The session SSE frame flips the status (and this screen) to
            // approved; the path renders in the notice.
            setApprovedPath(path);
            setApproveOpen(false);
          }}
        />
      )}
      {deleteOpen && (
        <DeleteDialog
          sessionId={session.id}
          approved={over}
          onClose={() => setDeleteOpen(false)}
          // The session is gone — leave for the index rather than waiting for
          // the `removed` frame to flip this screen to its closed state.
          onDeleted={() => navigate("/")}
        />
      )}
      {hasPlan && !over && (
        <>
          {selection !== null && composer === null && (
            <SelectionToolbar
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
          {composer !== null && (
            <Composer
              key={composerSeq.current}
              state={composer}
              onClose={() => setComposer(null)}
              onStack={stack}
              onSendNow={sendNow}
              onAsk={ask}
            />
          )}
          <CommentDrawer
            pending={pending}
            busy={busy}
            failed={failed}
            questions={openQuestions}
            onQuestions={jumpQuestions}
            onApprove={() => setApproveOpen(true)}
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
  const { session, threads, transcript, activity, missing, cleaned, connected } = useSession(id);
  // One ticking clock for the presence dot + activity/relative timestamps, so
  // they stay honest while the screen idles between SSE frames.
  const now = useNow(30_000);
  // Report visibility so the daemon suppresses desktop banners only while this
  // review is actually on screen (DESIGN.md §6).
  usePresence(id);

  const revision = session?.revision;
  useEffect(() => {
    if (session && revision !== undefined) markSeen(session.id, revision);
  }, [session, revision]);

  // A `removed` frame landed while this screen was open (DESIGN.md §12): the
  // session left the registry — `otacon clean` archived an approved one, or it
  // was deleted from review while pending. The frame carries no reason, so the
  // copy covers both. A terminal state, not an error — the stream is closed and
  // the switcher still offers everything live.
  if (cleaned) {
    return (
      <div className="page">
        <div className="topbar">
          <BackLink />
          <SessionSwitcher current={id} />
        </div>
        <main className="empty">
          <p className="empty-title">session closed</p>
          <p className="empty-body">
            This session left the codec — approved and cleaned, or deleted from review. Any
            approved plan stays committed under <code>docs/plans/</code>.
          </p>
        </main>
      </div>
    );
  }
  if (missing) {
    return (
      <div className="page">
        <BackLink />
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
        <BackLink />
        <p className="loading">connecting…</p>
      </div>
    );
  }

  return (
    <div className="page page-review" style={accentStyle(session.id)}>
      <div className="topbar">
        <BackLink />
        <SessionSwitcher current={session.id} />
      </div>
      <ReviewLoop
        key={session.id}
        session={session}
        threads={threads}
        transcript={transcript}
        activity={activity}
        connected={connected}
        now={now}
      />
    </div>
  );
}
