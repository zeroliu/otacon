// The threads rail (review UI): every comment and question conversation, newest
// first — anchored ones jump-and-flash their quoted text in the plan. Both kinds
// render through ONE shared conversation card: a root plus its follow-up turns
// (threaded review and revision), each turn paired with the agent's response.
// For a question the agent text is `answer.body` (the codec cursor blinks
// "answering…" until `otacon answer` lands over SSE) and a follow-up posts to the
// questions route; for a comment the agent text is `reply.body` (landed on the
// agent's resubmit, lint L5 — "responding…" until then) and a follow-up posts to
// the comments route. Each open conversation carries a collapsed "Follow up"
// reply box and a **Resolve** button (the reviewer closes the whole conversation;
// an un-replied comment's Resolve doubles as withdraw). Once the reviewer
// resolves: a question conversation shows its inline ✓ mark with the resolved
// revision; a comment conversation collapses to a ✓ summary (keyed on the close)
// that expands to its turns + replies. Either kind then offers a **Reopen** (the
// same Resolve seam in reverse) to re-open the conversation, hidden read-only.
// A detached conversation — whose quoted
// text no longer exists in the current revision (plan structure, lint, and
// anchoring) — stays inline in the same list as everything else. Its quote
// renders muted (no live text to flash, so it is not clickable or jumpable)
// beside a subtle ⌀ icon whose hover tooltip explains the quote changed in a
// later revision; a conversation keys on its root, so a detached root keeps its
// whole chain inline too. Internally the anchor still carries
// `anchorState:"orphaned"`; the UI just renders it inline. Resolve buttons + the
// follow-up box hide when the session is over (read-only).

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Anchor, Thread } from "../api";
import { anchorLabel, motionSafeScroll } from "./anchor";
import type { ThreadGroup } from "./group";
import { groupThreads } from "./group";

type Jump = (anchor: Anchor) => void;
/**
 * Post a follow-up on conversation `rootId`; resolves false on failure (stay
 * open). The rail doesn't know the route — session-screen looks up the root's
 * kind and dispatches to the questions or comments endpoint (DECISIONS.md).
 */
type Followup = (rootId: string, body: string) => Promise<boolean>;
/** Close/reopen conversation `threadId`; resolves false on failure (stay as-is). */
type Resolve = (threadId: string, resolved: boolean) => Promise<boolean>;
/** A tap on a lit plan span targets its rail thread; the nonce re-fires taps. */
type FocusTarget = { id: string; nonce: number };
const FOCUS_MS = 1600;

/** A thread whose quote can no longer be located in the current revision. Its
 *  quote stays inline but muted — there is no live text to jump to or flash. */
function isDetached(thread: Thread): boolean {
  return thread.anchorState === "orphaned";
}

const DETACHED_TITLE = "this quoted text changed in a later revision and can no longer be located in the plan";

/** The muted quote a detached thread shows in place of a jumpable one: no jump,
 *  no flash, just the original text with a subtle icon explaining why (hover).
 *  The title sits on the blockquote (not the decorative glyph) so the hover
 *  tooltip covers the whole quote and stays in the accessibility tree. */
function DetachedQuote({ exact }: { exact: string }) {
  return (
    <blockquote className="thread-quote thread-quote-muted" title={DETACHED_TITLE}>
      <span className="thread-quote-detached" aria-hidden="true">
        ⌀
      </span>
      {exact}
    </blockquote>
  );
}

// memo'd: the parent review loop re-renders per selection tick and drawer
// keystroke, while `threads` only gets a new identity on an SSE frame.
export const ThreadsRail = memo(function ThreadsRail({
  threads,
  onJump,
  onFollowup,
  onResolve,
  focus,
}: {
  threads: Thread[];
  onJump: Jump;
  /** Absent when the session is over: the reply box hides, the rest stays read-only. */
  onFollowup?: Followup;
  /** Absent when the session is over: the Resolve buttons hide, cards stay read-only. */
  onResolve?: Resolve;
  /** Tap-a-lit-span → focus its rail thread (review UI); null = no target. */
  focus?: FocusTarget | null;
}) {
  const railRef = useRef<HTMLElement>(null);
  // Scroll the tapped thread's card into view and pulse it. Re-fires on every
  // tap (focus is a fresh object per nonce), even repeats on the same thread.
  useEffect(() => {
    const rail = railRef.current;
    if (!focus || !rail) return;
    const card = rail.querySelector<HTMLElement>(`[data-thread="${CSS.escape(focus.id)}"]`);
    if (!card) return;
    motionSafeScroll(card, "center");
    card.classList.remove("thread-focus");
    void card.offsetWidth; // restart the emphasis animation on a repeat tap
    card.classList.add("thread-focus");
    const timer = setTimeout(() => card.classList.remove("thread-focus"), FOCUS_MS);
    return () => clearTimeout(timer);
  }, [focus]);
  // Group (fold follow-ups under their root), then render newest-first as one
  // inline list — detached and anchored threads share the list; the card itself
  // decides whether its quote is jumpable or muted.
  const groups = useMemo<ThreadGroup[]>(() => groupThreads(threads).reverse(), [threads]);

  return (
    <aside ref={railRef} className="rail" aria-label="threads">
      <div className="rail-top">
        <span>⊙ threads</span>
        {/* Count conversations (cards): a chain of turns is one card, not one
            tally each. */}
        <span className="rail-count">{groups.length}</span>
      </div>
      {threads.length === 0 ? (
        <p className="rail-empty">no threads yet — select plan text to comment or ask</p>
      ) : (
        groups.map((group) => {
          // A reviewer-resolved COMMENT conversation collapses to its ✓ summary
          // card (keyed on the close), expanding to its turns + replies. Every
          // other conversation — open comments, all questions — renders through
          // the shared open conversation card.
          const root = group.root;
          if (root.kind === "comment" && root.resolved) {
            return (
              <ResolvedCard
                key={root.id}
                root={root}
                followups={group.followups}
                onJump={onJump}
                onResolve={onResolve}
              />
            );
          }
          return (
            <ConversationCard
              key={root.id}
              root={root}
              followups={group.followups}
              onJump={onJump}
              onFollowup={onFollowup}
              onResolve={onResolve}
            />
          );
        })
      )}
    </aside>
  );
});

/**
 * The reviewer's Resolve/Reopen action — the same seam in both directions. With
 * `target` true (default) it closes the thread (and, on a comment with no reply,
 * doubles as the withdraw); with `target` false it re-opens a resolved
 * conversation. Posts {resolved:target} and relies on the `thread` SSE frame to
 * fold the change back in; on failure it surfaces a retry hint inline. Absent
 * `onResolve` (session over) renders nothing.
 */
function ResolveButton({
  threadId,
  onResolve,
  target = true,
}: {
  threadId: string;
  onResolve?: Resolve;
  /** The `resolved` state to set: true = resolve/close, false = reopen. */
  target?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!onResolve) return null;
  const label = target ? "resolve" : "reopen";
  const act = () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    void onResolve(threadId, target).then((ok) => {
      setBusy(false);
      if (!ok) setFailed(true);
    });
  };
  return (
    <div className="thread-resolve">
      {failed && (
        <span className="composer-hint composer-failed">{label} failed — is otacond up?</span>
      )}
      <button type="button" className="btn btn-ghost thread-resolve-btn" disabled={busy} onClick={act}>
        {busy ? (target ? "resolving…" : "reopening…") : label}
      </button>
    </div>
  );
}

/**
 * The agent's response to one conversation turn, or the blinking pending cursor.
 * A question turn's agent text is `answer.body` ("answering…" until it lands); a
 * comment turn's is `reply.body` ("responding…" until the agent's resubmit lands
 * it, lint L5), with the reply carrying the revision it landed on.
 */
function TurnResponse({ thread }: { thread: Thread }) {
  if (thread.kind === "question") {
    return thread.answer ? (
      <div className="thread-answer">
        <span className="thread-answer-label">↳ agent</span>
        <p className="thread-answer-body">{thread.answer.body}</p>
      </div>
    ) : (
      <p className="thread-answering">answering</p>
    );
  }
  return thread.reply ? (
    <div className="thread-answer">
      <span className="thread-answer-label">↳ agent · r{thread.reply.revision}</span>
      <p className="thread-answer-body">{thread.reply.body}</p>
    </div>
  ) : (
    <p className="thread-answering">responding</p>
  );
}

/** The "↳ you" line preceding a follow-up turn's body (the reviewer's turn). */
function TurnPrompt({ body }: { body: string }) {
  return (
    <p className="thread-followup-q">
      <span className="thread-followup-label" aria-hidden="true">
        ↳ you
      </span>
      {body}
    </p>
  );
}

/**
 * A conversation's quote — the jump target. A detached conversation's quote can't
 * be located, so it renders muted and never jumps/flashes; an anchored one is the
 * jumpable variant. Nothing renders for a quote-less (section-only/whole-plan)
 * anchor. Shared by the open card's head and the resolved card's detail.
 */
function ConversationQuote({ root, onJump }: { root: Thread; onJump: Jump }) {
  const { anchor } = root;
  if (anchor?.exact === undefined) return null;
  if (isDetached(root)) return <DetachedQuote exact={anchor.exact} />;
  if (anchor === null) return null;
  return (
    <blockquote
      className="thread-quote thread-quote-jump"
      title="jump to the quoted text"
      onClick={() => onJump(anchor)}
    >
      {anchor.exact}
    </blockquote>
  );
}

/**
 * The conversation's meta row (glyph + id + location) and its quote — the jump
 * target on the open card. The card body holds the interactive reply box, so the
 * card itself isn't a jump button; the meta row and the quote carry the jump
 * instead. The glyph is `?` for a question, `◆` for a comment.
 */
function ConversationHead({ root, onJump }: { root: Thread; onJump: Jump }) {
  const { anchor } = root;
  const detached = isDetached(root);
  const jump = anchor === null || detached ? undefined : () => onJump(anchor);
  const onKeyDown =
    jump &&
    ((event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        jump();
      }
    });
  return (
    <>
      <div
        className={jump ? "thread-meta thread-meta-jump" : "thread-meta"}
        onClick={jump}
        onKeyDown={onKeyDown}
        role={jump ? "button" : undefined}
        tabIndex={jump ? 0 : undefined}
      >
        <span className="thread-glyph" aria-hidden="true">
          {root.kind === "question" ? "?" : "◆"}
        </span>
        <span className="thread-id">{root.id}</span>
        <span className="thread-where">{anchorLabel(anchor)}</span>
      </div>
      <ConversationQuote root={root} onJump={onJump} />
    </>
  );
}

/**
 * A conversation as one card (threaded review and revision): the root + each
 * follow-up turn, each turn paired with the agent's response, then a collapsed
 * "Follow up" reply box and a **Resolve** button. Shared by both kinds — a
 * question (agent text = `answer.body`, follow-ups post to the questions route)
 * and an open comment (agent text = `reply.body`, follow-ups post to the comments
 * route); the routing is decided in session-screen by the root's kind. A
 * reviewer-resolved QUESTION collapses to its inline ✓ mark here; a resolved
 * COMMENT is routed to ResolvedCard before reaching this card.
 */
function ConversationCard({
  root,
  followups,
  onJump,
  onFollowup,
  onResolve,
}: {
  root: Thread;
  followups: Thread[];
  onJump: Jump;
  onFollowup?: Followup;
  onResolve?: Resolve;
}) {
  const kindClass = root.kind === "question" ? "thread-question" : "thread-comment";
  return (
    <article data-thread={root.id} className={`thread ${kindClass} thread-conversation`}>
      <ConversationHead root={root} onJump={onJump} />
      <p className="thread-body">{root.body}</p>
      <TurnResponse thread={root} />
      {followups.map((followup) => (
        <div className="thread-followup-turn" key={followup.id}>
          <TurnPrompt body={followup.body} />
          <TurnResponse thread={followup} />
        </div>
      ))}
      {/* root.replyTo is set only on a degraded "root gone" card (groupThreads);
          don't offer a reply box / Resolve there — they'd link to a missing root. */}
      {root.replyTo === undefined &&
        (root.resolved ? (
          <>
            <p className="thread-resolved-mark">
              <span className="resolved-check" aria-hidden="true">
                ✓
              </span>
              resolved <span className="resolved-rev">r{root.resolved.revision}</span>
            </p>
            <ResolveButton threadId={root.id} onResolve={onResolve} target={false} />
          </>
        ) : (
          <>
            {onFollowup && <FollowupBox rootId={root.id} kind={root.kind} onFollowup={onFollowup} />}
            <ResolveButton threadId={root.id} onResolve={onResolve} />
          </>
        ))}
    </article>
  );
}

/**
 * The collapsed "Follow up" button → a reply box posting the next follow-up
 * (threaded review and revision). On success the new turn arrives over the `thread` SSE frame
 * and folds into the card, and the box collapses again. The placeholder is
 * kind-aware — a question conversation asks the next question; a comment
 * conversation adds the next note — but both ride the same send protocol.
 */
function FollowupBox({
  rootId,
  kind,
  onFollowup,
}: {
  rootId: string;
  kind: Thread["kind"];
  onFollowup: Followup;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Supersedes an in-flight send: a cancel/Escape (or a newer send) bumps this,
  // so a late resolve can't strand busy/failed on a closed box (a stale "send
  // failed" would then greet the next open).
  const sendSeq = useRef(0);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const ready = body.trim() !== "" && !busy;
  const close = () => {
    sendSeq.current += 1;
    setOpen(false);
    setBody("");
    setBusy(false);
    setFailed(false);
  };
  const send = () => {
    if (!ready) return;
    const seq = (sendSeq.current += 1);
    setBusy(true);
    setFailed(false);
    void onFollowup(rootId, body).then((ok) => {
      if (seq !== sendSeq.current) return; // superseded by a close or newer send
      setBusy(false);
      if (ok) close();
      else setFailed(true);
    });
  };

  if (!open) {
    return (
      <button type="button" className="thread-followup-open" onClick={() => setOpen(true)}>
        follow up
      </button>
    );
  }
  return (
    <div className="thread-followup">
      <textarea
        ref={inputRef}
        className="thread-followup-input"
        placeholder={kind === "question" ? "ask a follow-up…" : "add a follow-up…"}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
          if (event.key === "Escape") close();
        }}
      />
      <div className="thread-followup-foot">
        <span className={failed ? "composer-hint composer-failed" : "composer-hint"}>
          {failed ? "send failed — is otacond up?" : "⌘⏎ send"}
        </span>
        <div className="thread-followup-actions">
          <button type="button" className="btn btn-ghost" onClick={close}>
            cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready} onClick={send}>
            {kind === "question" ? (busy ? "asking…" : "ask") : busy ? "adding…" : "add"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A reviewer-resolved comment conversation: collapsed to its ✓ summary line
 * (keyed on the reviewer's close), expanding to the whole conversation — the
 * quote, the root note + the agent's reply, then each follow-up turn + its reply
 * (a withdrawn comment with no reply just shows the note). The summary carries
 * the resolved revision; an un-resolve offer (Reopen) rides the same Resolve
 * seam, hidden read-only. Resolving the root withdraws every turn at once, so the
 * whole chain lives under one ✓ card.
 */
function ResolvedCard({
  root,
  followups,
  onJump,
  onResolve,
}: {
  root: Thread;
  followups: Thread[];
  onJump: Jump;
  onResolve?: Resolve;
}) {
  const { anchor, resolved } = root;
  if (!resolved) return null; // callers only route reviewer-resolved conversations here
  return (
    <details className="thread thread-comment thread-resolved" data-thread={root.id}>
      <summary className="resolved-summary">
        <span className="resolved-check" aria-hidden="true">
          ✓
        </span>
        <span className="thread-id">{root.id}</span>
        <span className="resolved-word">resolved</span>
        <span className="resolved-rev">r{resolved.revision}</span>
        <span className="thread-where">{anchorLabel(anchor)}</span>
      </summary>
      <div className="resolved-detail">
        <ConversationQuote root={root} onJump={onJump} />
        <p className="thread-body">{root.body}</p>
        <TurnResponse thread={root} />
        {followups.map((followup) => (
          <div className="thread-followup-turn" key={followup.id}>
            <TurnPrompt body={followup.body} />
            <TurnResponse thread={followup} />
          </div>
        ))}
        <ResolveButton threadId={root.id} onResolve={onResolve} target={false} />
      </div>
    </details>
  );
}
