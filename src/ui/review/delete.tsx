// The delete flow (DESIGN.md §6, §12): a deliberate, destructive control —
// like Approve, no keyboard shortcut exists — opening a confirm sheet whose
// copy is honest that it is permanent. Available only on a pending
// (non-approved) session; the daemon hard-removes its working state (no
// archive, unlike `otacon clean`) and publishes the `removed` frame the screen
// already listens for. One stage, unlike Approve's warn-then-force: there is
// nothing to reconcile, only to confirm.

import { useEffect, useState } from "react";
import { postDelete } from "../api";

export function DeleteDialog({
  sessionId,
  onClose,
  onDeleted,
}: {
  sessionId: string;
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
          <span className="approve-mode">⚠ delete session</span>
          <button type="button" className="composer-close" onClick={onClose}>
            esc
          </button>
        </div>
        <p className="approve-copy">Delete this session?</p>
        <p className="approve-sub">
          Permanently removes the draft plan, grill, and comments. This can't be undone — there is
          no approved plan to keep.
        </p>
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
