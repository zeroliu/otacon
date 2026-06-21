// The threads rail (review UI): every comment and question thread, newest
// first — anchored ones jump-and-flash their quoted text in the plan; a
// question with no answer yet blinks the codec cursor until `otacon answer`
// lands over SSE. A question and its follow-ups (threaded review and revision) render as one
// conversation card — each turn with its answer — with a collapsed "Follow up"
// reply box for the next question. M3 states: a resolved comment collapses to
// its ✓ line (the review UI) and expands to the agent's reply + the revision
// it landed in; a detached thread — whose quoted text no longer exists in the
// current revision (plan structure, lint, and anchoring) — stays inline in the
// same list as everything else. Its quote renders muted (no live text to flash,
// so it is not clickable or jumpable) beside a subtle ⌀ icon whose hover tooltip
// explains the quote changed in a later revision; a conversation keys on its
// root, so a detached root keeps its whole chain inline too. Internally the
// anchor still carries `anchorState:"orphaned"`; the UI just renders it inline.

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Anchor, Thread } from "../api";
import { anchorLabel, motionSafeScroll } from "./anchor";
import type { ThreadGroup } from "./group";
import { groupThreads } from "./group";

type CommentThread = Extract<Thread, { kind: "comment" }>;
type QuestionThread = Extract<Thread, { kind: "question" }>;
type Jump = (anchor: Anchor) => void;
/** Post a follow-up on conversation `rootId`; resolves false on failure (stay open). */
type Followup = (rootId: string, body: string) => Promise<boolean>;
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
  focus,
}: {
  threads: Thread[];
  onJump: Jump;
  /** Absent when the session is over: the reply box hides, the rest stays read-only. */
  onFollowup?: Followup;
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
          const root = group.root;
          if (root.kind === "comment") {
            return root.resolution ? (
              <ResolvedCard key={root.id} thread={root} onJump={onJump} />
            ) : (
              <ThreadCard key={root.id} thread={root} onJump={onJump} />
            );
          }
          return (
            <ConversationCard
              key={root.id}
              root={root}
              followups={group.followups}
              onJump={onJump}
              onFollowup={onFollowup}
            />
          );
        })
      )}
    </aside>
  );
});

/** An unresolved comment thread (review UI). */
function ThreadCard({ thread, onJump }: { thread: CommentThread; onJump: Jump }) {
  const { anchor } = thread;
  const detached = isDetached(thread);
  // A detached thread's quote can't be located, so it never jumps or flashes.
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
    <article
      data-thread={thread.id}
      className={`thread thread-comment${jump ? " thread-anchored" : ""}`}
      onClick={jump}
      onKeyDown={onKeyDown}
      role={jump ? "button" : undefined}
      tabIndex={jump ? 0 : undefined}
    >
      <div className="thread-meta">
        <span className="thread-glyph" aria-hidden="true">
          ◆
        </span>
        <span className="thread-id">{thread.id}</span>
        <span className="thread-where">{anchorLabel(anchor)}</span>
      </div>
      {anchor?.exact !== undefined &&
        (detached ? (
          <DetachedQuote exact={anchor.exact} />
        ) : (
          <blockquote className="thread-quote">{anchor.exact}</blockquote>
        ))}
      <p className="thread-body">{thread.body}</p>
    </article>
  );
}

/** The agent's reply to a question turn, or the blinking "answering…" cursor. */
function QuestionAnswer({ thread }: { thread: QuestionThread }) {
  return thread.answer ? (
    <div className="thread-answer">
      <span className="thread-answer-label">↳ agent</span>
      <p className="thread-answer-body">{thread.answer.body}</p>
    </div>
  ) : (
    <p className="thread-answering">answering</p>
  );
}

/**
 * A question and its follow-ups as one conversation (threaded review and revision): the root
 * question + each follow-up turn, each with its answer, then a collapsed
 * "Follow up" reply box. The card itself isn't a jump button (it holds the
 * interactive reply box) — the meta row and the quote carry the jump instead.
 */
function ConversationCard({
  root,
  followups,
  onJump,
  onFollowup,
}: {
  root: QuestionThread;
  followups: QuestionThread[];
  onJump: Jump;
  onFollowup?: Followup;
}) {
  const { anchor } = root;
  const detached = isDetached(root);
  // A detached conversation's quote can't be located, so it never jumps/flashes.
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
    <article data-thread={root.id} className="thread thread-question thread-conversation">
      <div
        className={jump ? "thread-meta thread-meta-jump" : "thread-meta"}
        onClick={jump}
        onKeyDown={onKeyDown}
        role={jump ? "button" : undefined}
        tabIndex={jump ? 0 : undefined}
      >
        <span className="thread-glyph" aria-hidden="true">
          ?
        </span>
        <span className="thread-id">{root.id}</span>
        <span className="thread-where">{anchorLabel(anchor)}</span>
      </div>
      {anchor?.exact !== undefined &&
        (detached ? (
          <DetachedQuote exact={anchor.exact} />
        ) : (
          <blockquote
            className={jump ? "thread-quote thread-quote-jump" : "thread-quote"}
            title={jump ? "jump to the quoted text" : undefined}
            onClick={jump}
          >
            {anchor.exact}
          </blockquote>
        ))}
      <p className="thread-body">{root.body}</p>
      <QuestionAnswer thread={root} />
      {followups.map((followup) => (
        <div className="thread-followup-turn" key={followup.id}>
          <p className="thread-followup-q">
            <span className="thread-followup-label" aria-hidden="true">
              ↳ you
            </span>
            {followup.body}
          </p>
          <QuestionAnswer thread={followup} />
        </div>
      ))}
      {/* root.replyTo is set only on a degraded "root gone" card (groupThreads);
          don't offer a reply box there — it would link to a missing root. */}
      {onFollowup && root.replyTo === undefined && (
        <FollowupBox rootId={root.id} onFollowup={onFollowup} />
      )}
    </article>
  );
}

/**
 * The collapsed "Follow up" button → a reply box posting the next follow-up
 * (threaded review and revision). On success the new turn arrives over the `thread` SSE frame
 * and folds into the card, and the box collapses again.
 */
function FollowupBox({ rootId, onFollowup }: { rootId: string; onFollowup: Followup }) {
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
        placeholder="ask a follow-up…"
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
            {busy ? "asking…" : "ask"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A resolved comment: collapsed to its ✓ line, per the review UI. */
function ResolvedCard({ thread, onJump }: { thread: CommentThread; onJump: Jump }) {
  const { anchor, resolution } = thread;
  if (!resolution) return null; // callers only route resolved comments here
  const detached = isDetached(thread);
  return (
    <details className="thread thread-comment thread-resolved">
      <summary className="resolved-summary">
        <span className="resolved-check" aria-hidden="true">
          ✓
        </span>
        <span className="thread-id">{thread.id}</span>
        <span className="resolved-word">resolved</span>
        <span className="resolved-rev">r{resolution.revision}</span>
        <span className="thread-where">{anchorLabel(anchor)}</span>
      </summary>
      <div className="resolved-detail">
        {anchor?.exact !== undefined &&
          (detached ? (
            <DetachedQuote exact={anchor.exact} />
          ) : (
            <blockquote
              className="thread-quote thread-quote-jump"
              title="jump to the quoted text"
              onClick={() => onJump(anchor)}
            >
              {anchor.exact}
            </blockquote>
          ))}
        <p className="thread-body">{thread.body}</p>
        <div className="thread-answer">
          <span className="thread-answer-label">↳ agent · r{resolution.revision}</span>
          <p className="thread-answer-body">{resolution.body}</p>
        </div>
      </div>
    </details>
  );
}
