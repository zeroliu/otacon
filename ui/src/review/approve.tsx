// The approve flow (DESIGN.md §6 step 6, §9, §10): a deliberate control —
// no keyboard shortcut exists, on purpose — opening a confirm sheet whose
// copy is honest about what happens: the daemon finalizes rN into docs/plans/
// (the exact filename is picked at approve time, so only the folder is
// promised) and the session ends. Unresolved threads answer 409 with the
// count; the sheet flips to its amber warning state and "approve anyway"
// retries with force. After the flip the screen goes read-only behind the
// quiet approved notice.

import { useEffect, useState } from "react";
import { postApprove } from "../api";

type Stage = { kind: "confirm" } | { kind: "warn"; unresolved: number };

export function ApproveDialog({
  sessionId,
  revision,
  onClose,
  onApproved,
}: {
  sessionId: string;
  revision: number;
  onClose: () => void;
  /** Receives the artifact's repo-relative path; the session frame flips the UI. */
  onApproved: (path: string) => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "confirm" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fire = (force: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void postApprove(sessionId, force).then((result) => {
      setBusy(false);
      if (result.ok) {
        onApproved(result.path);
        return;
      }
      if (!force && result.code === "E_UNRESOLVED_THREADS" && result.unresolved !== undefined) {
        setStage({ kind: "warn", unresolved: result.unresolved });
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
        className={stage.kind === "warn" ? "approve-sheet approve-warning" : "approve-sheet"}
        role="dialog"
        aria-modal="true"
        aria-label="approve plan"
      >
        <div className="approve-head">
          <span className="approve-mode">
            {stage.kind === "warn" ? "⚠ unresolved threads" : "approve plan"}
          </span>
          <button type="button" className="composer-close" onClick={onClose}>
            esc
          </button>
        </div>
        {stage.kind === "confirm" ? (
          <>
            <p className="approve-copy">
              Finalize <strong>r{revision}</strong> → <code>docs/plans/</code> and end the
              session.
            </p>
            <p className="approve-sub">
              otacond writes the approved plan (interview transcript appended) into the repo's
              docs/plans/; the agent commits it. No revisions after this — the session is over.
            </p>
          </>
        ) : (
          <>
            <p className="approve-copy">
              <strong>{stage.unresolved}</strong> unresolved{" "}
              {stage.unresolved === 1 ? "thread" : "threads"} — comments without a resolution,
              or questions still unanswered.
            </p>
            <p className="approve-sub">
              Approving anyway finalizes the plan as it stands; the open threads end with the
              session.
            </p>
          </>
        )}
        <div className="approve-actions">
          {error !== null && (
            <span className="composer-hint composer-failed">{error}</span>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            cancel
          </button>
          {stage.kind === "confirm" ? (
            <button
              type="button"
              className="btn btn-approve"
              disabled={busy}
              onClick={() => fire(false)}
            >
              {busy ? "finalizing…" : "✓ finalize & end"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-force"
              disabled={busy}
              onClick={() => fire(true)}
            >
              {busy ? "approving…" : "approve anyway"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The quiet post-approve notice (§10): the exact artifact path right after
 * approving (this tab heard the response); after a reload the path lives in
 * the committed repo, so the notice falls back to the destination folder.
 */
export function ApprovedNote({ path }: { path: string | null }) {
  return (
    <aside className="approved-note" role="status">
      <span className="approved-check" aria-hidden="true">
        ✓
      </span>
      <span className="approved-word">approved</span>
      <span className="approved-path">
        → {path ?? "docs/plans/ (committed by the agent)"}
      </span>
      <span className="approved-over">session over · read-only</span>
    </aside>
  );
}
