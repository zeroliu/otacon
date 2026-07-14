import type { ReviewThread } from "./model";

const LABEL = {
  question: "Question",
  comment: "Comment",
} as const;

function ThreadCard({
  thread,
  disabled,
  onConductCodeChange,
}: {
  thread: ReviewThread;
  disabled: boolean;
  onConductCodeChange: (threadId: string) => Promise<void>;
}) {
  return (
    <article className={`pr-thread is-${thread.status}`} data-thread-id={thread.id}>
      <header>
        <span>{LABEL[thread.intent]}</span>
        <span>{thread.id}</span>
        <span className="pr-thread-status">
          {thread.status === "open"
            ? "open"
            : thread.status === "answered"
              ? "answered"
              : "change requested"}
        </span>
      </header>
      <q>{thread.anchor}</q>
      <p>{thread.body}</p>
      {thread.response !== undefined && (
        <div className="pr-thread-response">
          <strong>Agent</strong>
          <p>{thread.response}</p>
        </div>
      )}
      {thread.intent === "comment" && thread.status === "open" && (
        <button
          type="button"
          className="btn btn-ghost pr-conduct-change"
          disabled={disabled}
          onClick={() => void onConductCodeChange(thread.id)}
        >
          Conduct code change
        </button>
      )}
      {thread.intent === "comment" && thread.status === "change-requested" && (
        <div className="pr-change-receipt">
          <span>↗</span>
          Worktree handoff requested · waiting for agent
        </div>
      )}
      {thread.receipt !== undefined && <div className="pr-memory-receipt">✓ {thread.receipt}</div>}
    </article>
  );
}

function ThreadList({
  threads,
  disabled,
  onConductCodeChange,
}: {
  threads: ReviewThread[];
  disabled: boolean;
  onConductCodeChange: (threadId: string) => Promise<void>;
}) {
  return threads.length === 0 ? (
    <p className="pr-thread-empty">No conversations yet. Select a passage to ask or suggest a change.</p>
  ) : (
    <div className="pr-thread-list">
      {threads.map((thread) => (
        <ThreadCard
          key={thread.id}
          thread={thread}
          disabled={disabled}
          onConductCodeChange={onConductCodeChange}
        />
      ))}
    </div>
  );
}

export function ThreadRail({
  threads,
  disabled = false,
  onConductCodeChange,
}: {
  threads: ReviewThread[];
  disabled?: boolean;
  onConductCodeChange: (threadId: string) => Promise<void>;
}) {
  const unresolved = threads.filter((thread) => thread.status !== "answered").length;
  return (
    <>
      <aside className="pr-thread-rail" aria-label="review conversations">
        <header className="pr-thread-rail-head">
          <span>Conversations</span>
          <span>{unresolved} unresolved · {threads.length} total</span>
        </header>
        <ThreadList
          threads={threads}
          disabled={disabled}
          onConductCodeChange={onConductCodeChange}
        />
      </aside>
      <details className="pr-thread-drawer">
        <summary>
          Conversations
          <span>{unresolved} unresolved</span>
        </summary>
        <ThreadList
          threads={threads}
          disabled={disabled}
          onConductCodeChange={onConductCodeChange}
        />
      </details>
    </>
  );
}
