// The threads rail (DESIGN.md §10): every comment and question thread, newest
// first — anchored ones jump-and-flash their quoted text in the plan; a
// question with no answer yet blinks the codec cursor until `otacon answer`
// lands over SSE. M3 states: a resolved comment collapses to its ✓ line
// (the §10 sketch) and expands to the agent's reply + the revision it landed
// in; orphaned threads — anchors whose quoted text no longer exists in the
// current revision (DESIGN.md §4) — leave the list for the orphan tray at the
// top of the rail, badge-counted, never silently dropped.

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { memo, useMemo, useState } from "react";
import type { Anchor, Thread } from "../api";
import { anchorLabel } from "./anchor";

type CommentThread = Extract<Thread, { kind: "comment" }>;
type Jump = (anchor: Anchor) => void;

// memo'd: the parent review loop re-renders per selection tick and drawer
// keystroke, while `threads` only gets a new identity on an SSE frame.
export const ThreadsRail = memo(function ThreadsRail({
  threads,
  onJump,
}: {
  threads: Thread[];
  onJump: Jump;
}) {
  const [trayOpen, setTrayOpen] = useState(false);
  const { live, orphaned } = useMemo(() => {
    const live: Thread[] = [];
    const orphaned: Thread[] = [];
    for (const thread of threads) {
      (thread.anchorState === "orphaned" ? orphaned : live).push(thread);
    }
    return { live: live.reverse(), orphaned: orphaned.reverse() };
  }, [threads]);

  return (
    <aside className="rail" aria-label="threads">
      <div className="rail-top">
        <span>⊙ threads</span>
        <span className="rail-count">{threads.length}</span>
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
          {orphaned.map((thread) => (
            <OrphanCard key={thread.id} thread={thread} />
          ))}
        </div>
      )}
      {threads.length === 0 ? (
        <p className="rail-empty">no threads yet — select plan text to comment or ask</p>
      ) : (
        live.map((thread) =>
          thread.kind === "comment" && thread.resolution ? (
            <ResolvedCard key={thread.id} thread={thread} onJump={onJump} />
          ) : (
            <ThreadCard key={thread.id} thread={thread} onJump={onJump} />
          ),
        )
      )}
    </aside>
  );
});

function ThreadCard({ thread, onJump }: { thread: Thread; onJump: Jump }) {
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
      className={`thread thread-${thread.kind}${jump ? " thread-anchored" : ""}`}
      onClick={jump}
      onKeyDown={onKeyDown}
      role={jump ? "button" : undefined}
      tabIndex={jump ? 0 : undefined}
    >
      <div className="thread-meta">
        <span className="thread-glyph" aria-hidden="true">
          {thread.kind === "question" ? "?" : "◆"}
        </span>
        <span className="thread-id">{thread.id}</span>
        <span className="thread-where">{anchorLabel(anchor)}</span>
      </div>
      {anchor?.exact !== undefined && <blockquote className="thread-quote">{anchor.exact}</blockquote>}
      <p className="thread-body">{thread.body}</p>
      {thread.kind === "question" &&
        (thread.answer ? (
          <div className="thread-answer">
            <span className="thread-answer-label">↳ agent</span>
            <p className="thread-answer-body">{thread.answer.body}</p>
          </div>
        ) : (
          <p className="thread-answering">answering</p>
        ))}
    </article>
  );
}

/** A resolved comment: collapsed to its ✓ line, per the §10 sketch. */
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
 * (a comment's resolution, or a question's answer — orphaning must never
 * hide either, DESIGN.md §4: kept, never silently dropped).
 */
function OrphanCard({ thread }: { thread: Thread }) {
  const [open, setOpen] = useState(false);
  const reply =
    thread.kind === "comment"
      ? thread.resolution && { label: `↳ agent · r${thread.resolution.revision}`, body: thread.resolution.body }
      : thread.answer && { label: "↳ agent", body: thread.answer.body };
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
        <span className="thread-id">{thread.id}</span>
        <span className="thread-where orphan-where">{anchorLabel(thread.anchor)}</span>
      </div>
      {thread.anchor?.exact !== undefined && (
        <blockquote className="thread-quote orphan-quote">{thread.anchor.exact}</blockquote>
      )}
      <p className="thread-body">{thread.body}</p>
      {open && reply && (
        <div className="thread-answer">
          <span className="thread-answer-label">{reply.label}</span>
          <p className="thread-answer-body">{reply.body}</p>
        </div>
      )}
    </article>
  );
}
