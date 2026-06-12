// The comment drawer (DESIGN.md §9, §10): comments batch here by default —
// one flush, one revision, one changelog — with a per-comment "send now"
// override. It floats as a glass instrument bar over the reading column; when
// nothing is pending it shrinks to the whole-plan affordance alone, so no
// dead Send button ever trains the eye to skip the bar.

import { useState } from "react";
import type { CommentDraft } from "../api";

export interface PendingComment extends CommentDraft {
  /** Local identity for edit/delete; never leaves the browser. */
  key: number;
}

export function CommentDrawer({
  pending,
  busy,
  failed,
  onEdit,
  onDelete,
  onSendOne,
  onSendAll,
  onWholePlan,
}: {
  pending: PendingComment[];
  busy: boolean;
  failed: boolean;
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
                <span className="pending-slug">
                  {item.anchor ? `#${item.anchor.section}` : "whole plan"}
                </span>
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
                  aria-label={`delete comment on ${item.anchor ? `#${item.anchor.section}` : "whole plan"}`}
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
                onChange={(event) => onEdit(item.key, event.target.value)}
              />
            </article>
          ))}
        </div>
      )}
      <div className={count === 0 ? "drawer-bar drawer-bar-empty" : "drawer-bar"}>
        <button type="button" className="drawer-whole" onClick={onWholePlan}>
          ✎ whole-plan comment
        </button>
        {count > 0 && (
          <>
            <span className="drawer-tally">
              <span className="drawer-count">{count}</span>
              pending
            </span>
            <button
              type="button"
              className="btn btn-ghost"
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
        {failed && <span className="drawer-failed">send failed — retry</span>}
      </div>
    </div>
  );
}
