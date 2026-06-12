// The /s/:id review screen: session header in the session's accent color,
// live over its SSE stream, rendering the latest stored revision as the plan
// dossier (DESIGN.md §10) — with the review loop's desktop verbs (select text
// → toolbar, comments batch in the drawer, questions fire instantly, threads
// in the rail) and M3's re-review layer: the new-revision banner, the
// [clean|diff] toggle with its baseline picker, gutter markers on sections
// changed since last-reviewed, and j/k jumping between them. Keyboard:
// c = comment, q = ask, j/k = changed sections; no Approve shortcut exists,
// deliberately (§10). The renderer stays a lazy chunk; approve is M4.

import type { MouseEvent, ReactNode, RefObject } from "react";
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accentStyle } from "./accent";
import type { Anchor, CommentDraft, LiveSession, Thread } from "./api";
import { postComments, postQuestion, postReviewed, useDiff, useRevision, useSession } from "./api";
import { LinkState, StatusChip } from "./chip";
import { relativeTime, repoName } from "./format";
import { captureSelection, flashAnchor } from "./review/anchor";
import type { CapturedSelection } from "./review/anchor";
import type { ReviewView } from "./review/banner";
import { ReviewControls, RevisionBanner } from "./review/banner";
import { DiffView } from "./review/diff";
import type { PendingComment } from "./review/drawer";
import { CommentDrawer } from "./review/drawer";
import type { ComposerState } from "./review/feedback";
import { Composer, SelectionToolbar, useSelection } from "./review/feedback";
import { ThreadsRail } from "./review/rail";
import { navigate } from "./router";
import { markSeen } from "./seen";

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

function SessionHead({ session, connected }: { session: LiveSession; connected: boolean }) {
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
        <StatusChip status={session.status} />
        <span className="card-time">{relativeTime(session.updatedAt)}</span>
        <LinkState connected={connected} />
      </div>
    </header>
  );
}

const COMPOSER_WIDTH = 380;
const COMPOSER_GUESS_HEIGHT = 240;

/** The review loop: plan + rail + selection toolbar + composer + drawer. */
function ReviewLoop({
  session,
  threads,
  connected,
}: {
  session: LiveSession;
  threads: Thread[];
  connected: boolean;
}) {
  const planRef = useRef<HTMLElement | null>(null);
  const keyRef = useRef(0);
  // Bumped on every composer open so the <Composer> remounts with an empty
  // body: c/q and the whole-plan affordance can retarget an open composer,
  // and a half-typed draft must never silently follow the new anchor.
  const composerSeq = useRef(0);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<ReviewView>("clean");
  // null = follow the server's last-reviewed baseline (DESIGN.md §9 layer 3);
  // a number = the user picked another baseline from the diff controls.
  const [baseline, setBaseline] = useState<number | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const hasPlan = session.revision > 0;
  // Selections only anchor in the clean view: diff lines are change telemetry,
  // not plan text the agent could re-locate (same honesty rule as the
  // chrome-selector guard in anchor.ts).
  const selection = useSelection(planRef, composer === null && view === "clean");

  const payload = useRevision(session.id, session.revision);
  const from = Math.min(baseline ?? session.lastReviewedRevision, session.revision);
  const diff = useDiff(session.id, from, session.revision);

  // Gutter markers (§10): changed/added units vs the baseline, in clean view.
  // Joined to one string so PlanView's memo survives this loop's re-renders.
  // A baseline of 0 means "never reviewed" — everything is new, so marking
  // every section would carry zero signal (DECISIONS.md).
  const changedIds = useMemo(() => {
    if (!diff || diff.from === 0) return "";
    return diff.sections
      .filter((s) => s.status === "changed" || s.status === "added")
      .map((s) => s.id)
      .join(" ");
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

  const fresh = hasPlan && session.revision >= 2 && session.lastReviewedRevision < session.revision;
  // The banner must quote the *landed* revision's changelog; while the
  // payload refetch is in flight the previous revision stays rendered, so
  // gate on the revision number instead of showing the stale changelog.
  const currentChangelog = payload?.revision === session.revision ? payload.changelog : undefined;

  const clearSelection = () => document.getSelection()?.removeAllRanges();

  const openComposer = useCallback((mode: "comment" | "ask", sel: CapturedSelection) => {
    composerSeq.current += 1;
    if (window.innerWidth < 560) {
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
      if (view !== "clean") return; // diff lines are not anchorable plan text
      const plan = planRef.current;
      const sel = plan ? captureSelection(plan) : null;
      if (!sel) return;
      event.preventDefault();
      openComposer(event.key === "c" ? "comment" : "ask", sel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openComposer, jumpChanged, view]);

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

  return (
    <>
      <div className="review-layout">
        <div className="review-main">
          <SessionHead session={session} connected={connected} />
          {hasPlan && (
            <ReviewControls
              view={view}
              onView={setView}
              revision={session.revision}
              lastReviewed={session.lastReviewedRevision}
              baseline={from}
              onBaseline={setBaseline}
              changedCount={diff && diff.from > 0 ? diff.sections.filter((s) => s.status !== "unchanged").length : 0}
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
              onDismiss={() => postReviewed(session.id)}
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
          {hasPlan ? (
            <main className="review" ref={planRef}>
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
              <p>
                The agent is still drafting. The plan renders here the moment revision 1 passes
                the linter — this screen updates live.
              </p>
            </main>
          )}
        </div>
        {hasPlan && <ThreadsRail threads={threads} onJump={jump} />}
      </div>
      {hasPlan && (
        <>
          {selection !== null && composer === null && (
            <SelectionToolbar
              selection={selection}
              onComment={() => openComposer("comment", selection)}
              onAsk={() => openComposer("ask", selection)}
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
  const { session, threads, missing, connected } = useSession(id);

  const revision = session?.revision;
  useEffect(() => {
    if (session && revision !== undefined) markSeen(session.id, revision);
  }, [session, revision]);

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
      <BackLink />
      <ReviewLoop key={session.id} session={session} threads={threads} connected={connected} />
    </div>
  );
}
