// The delete flow: a deliberate control — like Approve, no
// keyboard shortcut exists — opening a confirm sheet whose copy is honest about
// the disposition. Delete permanently removes the session's home folder
// (`~/.otacon/sessions/<id>/`) for every status: nothing is recoverable from
// otacon itself. For an approved session the durable copy survives elsewhere
// (the Save copy under the project's plans dir, or the PR for Implement plans);
// a pending one has no committed plan to keep. The daemon publishes the
// `removed` frame the screen already listens for. One stage, unlike Approve's
// warn-then-force: there is nothing to reconcile, only to confirm.

import { useEffect, useState } from "react";
import { postDelete } from "../api";

export function DeleteDialog({
  sessionId,
  approved,
  onClose,
  onDeleted,
}: {
  sessionId: string;
  /** Approved → durable copy survives elsewhere; pending → no committed plan. Drives the copy. */
  approved: boolean;
  onClose: () => void;
  /** Fires once the daemon confirms the delete; the `removed` frame closes the UI. */
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fire = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void postDelete(sessionId).then((result) => {
      setBusy(false);
      if (result.ok) {
        onDeleted();
        return;
      }
      setError(
        result.code === "E_UNREACHABLE"
          ? "couldn't reach otacond — is it up?"
          : (result.message ?? result.code),
      );
    });
  };

  return (
    <div
      className="approve-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="approve-sheet delete-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="delete session"
      >
        <div className="approve-head">
          <span className="approve-mode">{approved ? "delete session" : "⚠ delete session"}</span>
          <button type="button" className="composer-close" onClick={onClose}>
            esc
          </button>
        </div>
        <p className="approve-copy">Delete this session?</p>
        {approved ? (
          <p className="approve-sub">
            Permanently removes its home folder (<code>~/.otacon/sessions/</code>) and drops it from
            the index. This can't be undone. The approved plan still survives as the saved copy in
            your project (or in the PR for Implement plans).
          </p>
        ) : (
          <p className="approve-sub">
            Permanently removes its home folder (<code>~/.otacon/sessions/</code>) with the draft
            plan, grill, and comments. This can't be undone: there is no committed plan to keep.
          </p>
        )}
        <div className="approve-actions">
          {error !== null && <span className="composer-hint composer-failed">{error}</span>}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            cancel
          </button>
          <button type="button" className="btn btn-delete" disabled={busy} onClick={fire}>
            {busy ? "deleting…" : "✕ delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
