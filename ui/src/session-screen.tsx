// The /s/:id review screen: session header in the session's accent color,
// live over its SSE stream, rendering the latest stored revision as the plan
// dossier (DESIGN.md §10) — now with the review loop's desktop verbs: select
// text → toolbar (Comment | Ask), comments batch in the drawer, questions
// fire instantly, and every thread lands in the rail beside the plan.
// Keyboard: c = comment on selection, q = ask; no Approve shortcut exists,
// deliberately (§10). The renderer stays a lazy chunk; diffs/approve are M3+.

import type { MouseEvent, ReactNode, RefObject } from "react";
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { accentStyle } from "./accent";
import type { Anchor, CommentDraft, LiveSession, Thread } from "./api";
import { postComments, postQuestion, useRevision, useSession } from "./api";
import { LinkState, StatusChip } from "./chip";
import { relativeTime, repoName } from "./format";
import { captureSelection, flashAnchor } from "./review/anchor";
import type { CapturedSelection } from "./review/anchor";
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

function PlanPane({
  session,
  planRef,
}: {
  session: LiveSession;
  planRef: RefObject<HTMLElement | null>;
}) {
  const payload = useRevision(session.id, session.revision);
  if (!payload) {
    return <p className="loading">loading r{session.revision}…</p>;
  }
  return (
    <main className="review" ref={planRef}>
      <RendererBoundary>
        <Suspense fallback={<p className="loading">loading renderer…</p>}>
          <PlanView markdown={payload.markdown} warnings={payload.warnings} />
        </Suspense>
      </RendererBoundary>
    </main>
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
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const selection = useSelection(planRef, composer === null);
  const hasPlan = session.revision > 0;

  const clearSelection = () => document.getSelection()?.removeAllRanges();

  const openComposer = useCallback((mode: "comment" | "ask", sel: CapturedSelection) => {
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

  // Keyboard: c = comment on selection, q = ask (DESIGN.md §10 — there is no
  // Approve shortcut, on purpose). Esc closes the composer from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (event.key === "Escape") {
        setComposer(null);
        return;
      }
      if (event.key !== "c" && event.key !== "q") return;
      const plan = planRef.current;
      const sel = plan ? captureSelection(plan) : null;
      if (!sel) return;
      event.preventDefault();
      openComposer(event.key === "c" ? "comment" : "ask", sel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openComposer]);

  const stack = (body: string) => {
    if (!composer) return;
    const key = (keyRef.current += 1);
    const anchor = composer.anchor;
    setPending((prev) => [...prev, { key, anchor, body }]);
    setComposer(null);
    clearSelection();
  };

  const sendItems = async (items: CommentDraft[]): Promise<boolean> => {
    setBusy(true);
    setFailed(false);
    const ok = await postComments(session.id, items);
    setBusy(false);
    setFailed(!ok);
    return ok;
  };

  const sendNow = async (body: string): Promise<boolean> => {
    if (!composer) return false;
    const ok = await sendItems([{ anchor: composer.anchor, body }]);
    if (ok) {
      setComposer(null);
      clearSelection();
    }
    return ok;
  };

  const ask = async (body: string): Promise<boolean> => {
    if (!composer) return false;
    const ok = await postQuestion(session.id, composer.anchor, body);
    if (ok) {
      setComposer(null);
      clearSelection();
    }
    return ok;
  };

  const sendAll = async () => {
    if (pending.length === 0) return;
    const ok = await sendItems(pending.map(({ anchor, body }) => ({ anchor, body })));
    if (ok) setPending([]);
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
          {hasPlan ? (
            <PlanPane session={session} planRef={planRef} />
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
            onWholePlan={() => setComposer({ mode: "comment", anchor: null, at: null })}
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
