// The threads rail (review UI): every comment and question thread, newest
// first — anchored ones jump-and-flash their quoted text in the plan; a
// question with no answer yet blinks the codec cursor until `otacon answer`
// lands over SSE. A question and its follow-ups (threaded review and revision) render as one
// conversation card — each turn with its answer — with a collapsed "Follow up"
// reply box for the next question. M3 states: a resolved comment collapses to
// its ✓ line (the review UI) and expands to the agent's reply + the revision
// it landed in; orphaned threads — anchors whose quoted text no longer exists in
// the current revision (plan structure, lint, and anchoring) — leave the list for the orphan tray at
// the top of the rail, badge-counted, never silently dropped. A conversation
// keys on its root, so an orphaned root takes its whole chain to the tray.

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
  const [trayOpen, setTrayOpen] = useState(false);
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
  const { live, orphaned } = useMemo(() => {
    const live: ThreadGroup[] = [];
    const orphaned: ThreadGroup[] = [];
    // Group first (fold follow-ups under their root), then split by the ROOT's
    // anchor state so a whole conversation travels as a unit.
    for (const group of groupThreads(threads)) {
      (group.root.anchorState === "orphaned" ? orphaned : live).push(group);
    }
    return { live: live.reverse(), orphaned: orphaned.reverse() };
  }, [threads]);

  return (
    <aside ref={railRef} className="rail" aria-label="threads">
      <div className="rail-top">
        <span>⊙ threads</span>
        {/* Count conversations (cards), matching the orphan badge's unit — a
            chain of turns is one card, not one tally each. */}
        <span className="rail-count">{live.length + orphaned.length}</span>
      </div>
      {orphaned.length > 0 && (
        <button
          type="button"
          className="orphan-toggle"
          aria-expanded={trayOpen}
          onClick={() => setTrayOpen((value) => !value)}
        >
          <span className="orphan-glyph" aria-hidden="true">
            ⚠
          </span>
          orphaned
          <span className="orphan-count">{orphaned.length}</span>
          <span className="orphan-caret" aria-hidden="true">
            {trayOpen ? "▾" : "▸"}
          </span>
        </button>
      )}
      {trayOpen && orphaned.length > 0 && (
        <div className="orphan-tray" aria-label="orphaned threads">
          <p className="orphan-note">
            their quoted text is gone from the current revision — kept here, never dropped;
            restored text re-anchors them automatically
          </p>
          {orphaned.map((group) => (
            <OrphanCard key={group.root.id} group={group} />
          ))}
        </div>
      )}
      {threads.length === 0 ? (
        <p className="rail-empty">no threads yet — select plan text to comment or ask</p>
      ) : (
        live.map((group) => {
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
  const jump = anchor === null ? undefined : () => onJump(anchor);
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
      {anchor?.exact !== undefined && <blockquote className="thread-quote">{anchor.exact}</blockquote>}
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
  const jump = anchor === null ? undefined : () => onJump(anchor);
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
      {anchor?.exact !== undefined && (
        <blockquote
          className={jump ? "thread-quote thread-quote-jump" : "thread-quote"}
          title={jump ? "jump to the quoted text" : undefined}
          onClick={jump}
        >
          {anchor.exact}
        </blockquote>
      )}
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
        {anchor?.exact !== undefined && (
          <blockquote
            className="thread-quote thread-quote-jump"
            title="jump to the quoted text"
            onClick={() => onJump(anchor)}
          >
            {anchor.exact}
          </blockquote>
        )}
        <p className="thread-body">{thread.body}</p>
        <div className="thread-answer">
          <span className="thread-answer-label">↳ agent · r{resolution.revision}</span>
          <p className="thread-answer-body">{resolution.body}</p>
        </div>
      </div>
    </details>
  );
}

/**
 * A tray entry: the dead quote is the headline (clamped); clicking the card
 * unclamps it to the full original anchor text and reveals the agent's reply
 * (a comment's resolution, or a question's answer) plus any follow-up turns —
 * an orphaned conversation travels whole, never silently dropped (plan structure, lint, and anchoring).
 */
function OrphanCard({ group }: { group: ThreadGroup }) {
  const [open, setOpen] = useState(false);
  const { root, followups } = group;
  const reply =
    root.kind === "comment"
      ? root.resolution && { label: `↳ agent · r${root.resolution.revision}`, body: root.resolution.body }
      : root.answer && { label: "↳ agent", body: root.answer.body };
  const toggle = () => setOpen((value) => !value);
  return (
    <article
      className={open ? "orphan orphan-open" : "orphan"}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={toggle}
      onKeyDown={(event: ReactKeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      }}
    >
      <div className="thread-meta">
        <span className="orphan-glyph" aria-hidden="true">
          ⚠
        </span>
        <span className="thread-id">{root.id}</span>
        <span className="thread-where orphan-where">{anchorLabel(root.anchor)}</span>
      </div>
      {root.anchor?.exact !== undefined && (
        <blockquote className="thread-quote orphan-quote">{root.anchor.exact}</blockquote>
      )}
      <p className="thread-body">{root.body}</p>
      {open && reply && (
        <div className="thread-answer">
          <span className="thread-answer-label">{reply.label}</span>
          <p className="thread-answer-body">{reply.body}</p>
        </div>
      )}
      {open &&
        followups.map((followup) => (
          <div className="thread-followup-turn" key={followup.id}>
            <p className="thread-followup-q">
              <span className="thread-followup-label" aria-hidden="true">
                ↳ you
              </span>
              {followup.body}
            </p>
            {followup.answer && (
              <div className="thread-answer">
                <span className="thread-answer-label">↳ agent</span>
                <p className="thread-answer-body">{followup.answer.body}</p>
              </div>
            )}
          </div>
        ))}
    </article>
  );
}
