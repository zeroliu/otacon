// The comment drawer (DESIGN.md §9, §10): comments batch here by default —
// one flush, one revision, one changelog — with a per-comment "send now"
// override. It floats as a glass instrument bar over the reading column; when
// nothing is pending it shrinks to the whole-plan affordance alone, so no
// dead Send button ever trains the eye to skip the bar.
//
// On a phone the same bar is the WHOLE control surface (§10 "sticky bar"):
// ❓ pending agent questions (tap → the question queue), ✎ whole-plan, 💬
// count + Send, ✓ Approve. One DOM, CSS-responsive — desktop keeps approve
// and the question tally in the header instrument strip and hides the
// phone-only controls here, so the two surfaces never show redundantly.

import { useState } from "react";
import type { CommentDraft } from "../api";
import { anchorLabel } from "./anchor";

export interface PendingComment extends CommentDraft {
  /** Local identity for edit/delete; never leaves the browser. */
  key: number;
}

export function CommentDrawer({
  pending,
  busy,
  failed,
  questions,
  onQuestions,
  onApprove,
  onEdit,
  onDelete,
  onSendOne,
  onSendAll,
  onWholePlan,
}: {
  pending: PendingComment[];
  busy: boolean;
  failed: boolean;
  /** Unanswered agent questions — the sticky bar's ❓ badge (phone only). */
  questions: number;
  /** Scrolls to the question queue (the ❓ tap, DESIGN.md §10). */
  onQuestions: () => void;
  /** Opens the approve confirm sheet; undefined hides the phone ✓ control. */
  onApprove?: () => void;
  onEdit: (key: number, body: string) => void;
  onDelete: (key: number) => void;
  onSendOne: (key: number) => void;
  onSendAll: () => void;
  onWholePlan: () => void;
}) {
  const [open, setOpen] = useState(false);
  const count = pending.length;
  const blocked = pending.some((item) => item.body.trim() === "");
  return (
    <div className="drawer">
      {open && count > 0 && (
        <div className="drawer-list">
          {pending.map((item) => (
            <article key={item.key} className="pending">
              <div className="pending-meta">
                <span className="pending-slug">{anchorLabel(item.anchor)}</span>
                <button
                  type="button"
                  className="pending-act"
                  disabled={busy || item.body.trim() === ""}
                  onClick={() => onSendOne(item.key)}
                >
                  send now ↗
                </button>
                <button
                  type="button"
                  className="pending-act pending-delete"
                  aria-label={`delete comment on ${anchorLabel(item.anchor)}`}
                  onClick={() => onDelete(item.key)}
                >
                  ✕
                </button>
              </div>
              {item.anchor?.exact !== undefined && (
                <blockquote className="pending-quote">{item.anchor.exact}</blockquote>
              )}
              <textarea
                className="pending-body"
                aria-label="edit comment"
                rows={2}
                value={item.body}
                // Frozen while a send is in flight: the daemon got the text
                // as it was at click time, so a mid-flight edit would be
                // silently dropped when the sent items clear.
                disabled={busy}
                onChange={(event) => onEdit(item.key, event.target.value)}
              />
            </article>
          ))}
        </div>
      )}
      <div className={count === 0 ? "drawer-bar drawer-bar-empty" : "drawer-bar"}>
        {questions > 0 && (
          <button
            type="button"
            className="bar-quest"
            onClick={onQuestions}
            aria-label={`${questions} agent ${questions === 1 ? "question" : "questions"} pending — jump to the queue`}
          >
            <span className="bar-quest-glyph" aria-hidden="true">
              ?
            </span>
            <span className="bar-count">{questions}</span>
          </button>
        )}
        <button type="button" className="drawer-whole" onClick={onWholePlan}>
          ✎ <span className="drawer-whole-word">whole-plan comment</span>
        </button>
        {count > 0 && (
          <>
            <button
              type="button"
              className="drawer-tally"
              aria-expanded={open}
              aria-label={`${count} pending ${count === 1 ? "comment" : "comments"}`}
              onClick={() => setOpen((value) => !value)}
            >
              {/* ◆ = comment, ? = question: the rail's glyph family, not emoji —
                  the bar stays mono telemetry like every other instrument. */}
              <span className="tally-glyph" aria-hidden="true">
                ◆
              </span>
              <span className="drawer-count">{count}</span>
              <span className="tally-word">pending</span>
            </button>
            <button
              type="button"
              className="btn btn-ghost drawer-review"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? "hide" : "review"}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || blocked}
              onClick={onSendAll}
            >
              {busy ? "sending…" : "send all"}
            </button>
          </>
        )}
        {onApprove && (
          <button type="button" className="bar-approve" onClick={onApprove}>
            <span aria-hidden="true">✓</span>
            <span className="bar-approve-word">approve</span>
          </button>
        )}
        {failed && <span className="drawer-failed">send failed — retry</span>}
      </div>
    </div>
  );
}
