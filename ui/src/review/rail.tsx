// The threads rail (DESIGN.md §10): every comment and question thread, newest
// first — anchored ones jump-and-flash their quoted text in the plan. A
// question with no answer yet shows the "answering" placeholder (a blinking
// codec cursor via CSS) until the agent's `otacon answer` lands as an SSE
// thread frame. Resolution states arrive with M3.

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Anchor, Thread } from "../api";

export function ThreadsRail({
  threads,
  onJump,
}: {
  threads: Thread[];
  onJump: (anchor: Anchor) => void;
}) {
  const newestFirst = [...threads].reverse();
  return (
    <aside className="rail" aria-label="threads">
      <div className="rail-top">
        <span>⊙ threads</span>
        <span className="rail-count">{threads.length}</span>
      </div>
      {threads.length === 0 ? (
        <p className="rail-empty">no threads yet — select plan text to comment or ask</p>
      ) : (
        newestFirst.map((thread) => <ThreadCard key={thread.id} thread={thread} onJump={onJump} />)
      )}
    </aside>
  );
}

function ThreadCard({ thread, onJump }: { thread: Thread; onJump: (anchor: Anchor) => void }) {
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
        <span className="thread-where">{anchor ? `#${anchor.section}` : "whole plan"}</span>
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
