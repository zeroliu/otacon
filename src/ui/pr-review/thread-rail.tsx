import { useEffect, useRef, useState } from "react";
import { conversationIsUnresolved, groupReviewThreads, type ReviewConversation } from "./group.js";
import type { ReviewThread } from "./model";

const LABEL = { question: "Question", comment: "Comment" } as const;

function Turn({ thread, root = false }: { thread: ReviewThread; root?: boolean }) {
  return (
    <div className={root ? "pr-thread-turn is-root" : "pr-thread-turn is-followup"} data-thread-id={thread.id}>
      {!root && <p className="pr-thread-followup-label">↳ you · {thread.id}</p>}
      <p>{thread.body}</p>
      {thread.response !== undefined && (
        <div className="pr-thread-response">
          <strong>Agent</strong>
          <p>{thread.response}</p>
        </div>
      )}
      {thread.receipt !== undefined && <div className="pr-memory-receipt">✓ {thread.receipt}</div>}
    </div>
  );
}

function FollowupBox({
  root,
  onFollowup,
}: {
  root: ReviewThread;
  onFollowup: (rootId: string, body: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  const close = () => { setOpen(false); setBody(""); setBusy(false); setFailed(false); };
  const send = async () => {
    if (body.trim() === "" || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onFollowup(root.id, body.trim());
      close();
    } catch {
      setBusy(false);
      setFailed(true);
    }
  };
  if (!open) {
    return <button type="button" className="thread-followup-open" onClick={() => setOpen(true)}>follow up</button>;
  }
  return (
    <div className="thread-followup pr-thread-followup">
      <textarea
        ref={input}
        className="thread-followup-input"
        placeholder={root.intent === "question" ? "ask a follow-up…" : "add a follow-up…"}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
          if (event.key === "Escape") close();
        }}
      />
      <div className="thread-followup-foot">
        <span className={failed ? "composer-hint composer-failed" : "composer-hint"}>
          {failed ? "send failed — is otacond up?" : "⌘⏎ send"}
        </span>
        <div className="thread-followup-actions">
          <button type="button" className="btn btn-ghost" onClick={close}>cancel</button>
          <button type="button" className="btn btn-primary" disabled={body.trim() === "" || busy} onClick={() => void send()}>
            {root.intent === "question" ? (busy ? "asking…" : "ask") : busy ? "adding…" : "add"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConversationCard({
  conversation,
  disabled,
  onFollowup,
  onConductCodeChange,
}: {
  conversation: ReviewConversation;
  disabled: boolean;
  onFollowup: (rootId: string, body: string) => Promise<void>;
  onConductCodeChange: (threadId: string) => Promise<void>;
}) {
  const { root, turns } = conversation;
  const action = root.codeActionStatus;
  const unresolved = conversationIsUnresolved(conversation);
  const status = action !== undefined && action !== "completed" ? "change-requested" : unresolved ? "open" : "answered";
  return (
    <article className={`pr-thread is-${status}`} data-thread-id={root.id}>
      <header>
        <span>{LABEL[root.intent]}</span>
        <span>{root.id}</span>
        <span className="pr-thread-status">{status === "change-requested" ? "change requested" : status}</span>
      </header>
      <q>{root.anchor}</q>
      {turns.map((turn, index) => <Turn key={turn.id} thread={turn} root={index === 0} />)}
      {!disabled && root.canFollowup !== false && <FollowupBox root={root} onFollowup={onFollowup} />}
      {root.intent === "comment" && action === undefined && root.canConductCodeChange !== false && (
        <button
          type="button"
          className="btn btn-ghost pr-conduct-change"
          disabled={disabled}
          onClick={() => void onConductCodeChange(root.id)}
        >
          Conduct code change
        </button>
      )}
      {root.intent === "comment" && action !== undefined && (
        <div className="pr-change-receipt">
          <span>↗</span>
          {action === "working" ? "Code change in progress"
            : action === "completed" ? "Code change completed"
              : action === "failed" ? "Code change failed"
                : "Worktree handoff requested · waiting for agent"}
          {root.actionMessage !== undefined && <> · {root.actionMessage}</>}
        </div>
      )}
    </article>
  );
}

function ThreadList({
  conversations,
  disabled,
  onFollowup,
  onConductCodeChange,
}: {
  conversations: ReviewConversation[];
  disabled: boolean;
  onFollowup: (rootId: string, body: string) => Promise<void>;
  onConductCodeChange: (threadId: string) => Promise<void>;
}) {
  return conversations.length === 0 ? (
    <p className="pr-thread-empty">No conversations yet. Select a passage to ask or suggest a change.</p>
  ) : (
    <div className="pr-thread-list">
      {conversations.map((conversation) => (
        <ConversationCard
          key={conversation.root.id}
          conversation={conversation}
          disabled={disabled}
          onFollowup={onFollowup}
          onConductCodeChange={onConductCodeChange}
        />
      ))}
    </div>
  );
}

export function ThreadRail({
  threads,
  disabled = false,
  onFollowup,
  onConductCodeChange,
}: {
  threads: ReviewThread[];
  disabled?: boolean;
  onFollowup: (rootId: string, body: string) => Promise<void>;
  onConductCodeChange: (threadId: string) => Promise<void>;
}) {
  const conversations = groupReviewThreads(threads);
  const unresolved = conversations.filter(conversationIsUnresolved).length;
  return (
    <>
      <aside className="pr-thread-rail" aria-label="review conversations">
        <header className="pr-thread-rail-head"><span>Conversations</span><span>{unresolved} unresolved · {conversations.length} total</span></header>
        <ThreadList conversations={conversations} disabled={disabled} onFollowup={onFollowup} onConductCodeChange={onConductCodeChange} />
      </aside>
      <details className="pr-thread-drawer">
        <summary>Conversations<span>{unresolved} unresolved</span></summary>
        <ThreadList conversations={conversations} disabled={disabled} onFollowup={onFollowup} onConductCodeChange={onConductCodeChange} />
      </details>
    </>
  );
}
