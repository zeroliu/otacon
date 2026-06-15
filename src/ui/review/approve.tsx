// The approve flow (DESIGN.md §6 step 6, §9, §10, §12): a deliberate control —
// no keyboard shortcut exists, on purpose — opening a confirm sheet whose
// copy is honest about what happens. Two primary actions:
//   • commit plan — the daemon writes rN into docs/plans/ (the exact filename
//     is picked at approve time, so only the folder is promised), the agent
//     commits it, and the session is over.
//   • commit & implement — same finalize+commit, but the agent then keeps
//     building (worktree → per-phase implement+review loop → PR); the session
//     stays live as `implementing` rather than ending.
// Unresolved threads answer 409 with the count; the sheet flips to its amber
// warning state and "commit anyway" retries with force — re-firing the SAME
// variant the user picked (the warn stage remembers it). A plain approve ends
// read-only behind the quiet approved notice; an implement approve hands off to
// the live `implementing` frame.

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
  /**
   * Receives the artifact's repo-relative path; the session frame flips the UI.
   * `implement` is the chosen variant — the caller leaves the screen interactive
   * for it (the `implementing` frame drives the UI), read-only for a plain end.
   */
  onApproved: (path: string, implement: boolean) => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "confirm" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The variant a force retry must re-fire. Set when the unresolved-threads
  // warning bounces the first attempt, so "approve anyway" carries the same
  // implement flag the user chose at the confirm stage (rather than silently
  // downgrading an Approve & Implement to a plain approve).
  const [pendingImplement, setPendingImplement] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fire = (force: boolean, implement: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void postApprove(sessionId, force, implement).then((result) => {
      setBusy(false);
      if (result.ok) {
        onApproved(result.path, implement);
        return;
      }
      if (!force && result.code === "E_UNRESOLVED_THREADS" && result.unresolved !== undefined) {
        setPendingImplement(implement);
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
              Finalize <strong>r{revision}</strong> → <code>docs/plans/</code>; the agent commits
              it. Then either end here, or keep the agent building.
            </p>
            <p className="approve-sub">
              <strong>Commit Plan</strong> stops after the commit — no revisions after this, the
              session is over. <strong>Commit &amp; Implement</strong> hands the same agent the
              build: it opens a worktree and walks the phases (implement → review → fix → commit),
              opening a PR when every phase is green. The session stays live as{" "}
              <em>implementing</em> and asks you on the first blocker.
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
              {pendingImplement
                ? "Implementing anyway finalizes the plan as it stands and starts the build; the open threads close unaddressed."
                : "Approving anyway finalizes the plan as it stands; the open threads end with the session."}
            </p>
          </>
        )}
        {error !== null && (
          <p className="approve-error composer-hint composer-failed">{error}</p>
        )}
        <div className="approve-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {stage.kind === "confirm" ? (
            <>
              <button
                type="button"
                className="btn btn-approve"
                disabled={busy}
                onClick={() => fire(false, false)}
              >
                {busy ? "committing…" : "Commit Plan"}
              </button>
              <button
                type="button"
                className="btn btn-implement"
                disabled={busy}
                onClick={() => fire(false, true)}
              >
                {busy ? "starting…" : "Commit & Implement"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-force"
              disabled={busy}
              // Re-fire the SAME variant the user chose: a Commit & Implement
              // that hit unresolved threads must still implement on retry.
              onClick={() => fire(true, pendingImplement)}
            >
              {busy
                ? pendingImplement
                  ? "starting…"
                  : "committing…"
                : pendingImplement
                  ? "Commit & Implement anyway"
                  : "Commit anyway"}
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
