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
// warning state with two ways past it (re-firing the SAME variant the user
// picked — the warn stage remembers it):
//   • send to agent (comment & approve) — when open comments exist, hand them
//     to the agent for one fold-in pass; the daemon defers the finalize
//     (`finalizing`) and the SSE frame drives the screen, so the dialog just
//     closes. The reviewer is done the instant they click.
//   • commit anyway — force-drop the open threads and finalize now.
// A plain approve ends read-only behind the quiet approved notice; an implement
// approve hands off to the live `implementing` frame; a send-to-agent approve
// shows the read-only finalizing notice (ApprovingNote) until the agent commits.

import { useEffect, useState } from "react";
import type { ApproveOptions } from "../api";
import { postApprove } from "../api";

type Stage =
  | { kind: "confirm" }
  | { kind: "warn"; unresolved: number; openComments: number };

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
  // The variant a warn-stage action must re-fire. Set when the unresolved-threads
  // warning bounces the first attempt, so both "Send to agent" and "Commit
  // anyway" carry the same implement flag the user chose at the confirm stage
  // (rather than silently downgrading an Approve & Implement to a plain approve).
  const [pendingImplement, setPendingImplement] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fire = (opts: ApproveOptions) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void postApprove(sessionId, opts).then((result) => {
      setBusy(false);
      if (result.ok) {
        // Comment & approve: the daemon deferred the finalize. The SSE
        // `finalizing` frame drives the screen — just close the sheet.
        if ("finalizing" in result) {
          onClose();
          return;
        }
        onApproved(result.path, opts.implement ?? false);
        return;
      }
      // The unresolved-threads warning — on the first attempt, or when a "Send to
      // agent" retry lost its race (the open comments were resolved out from under
      // the click, so the daemon refused the defer and 409'd; re-render the warn
      // stage, now with openComments=0, so the user keeps the friendly escape
      // instead of dropping into a raw error). A `force` attempt never bounces here.
      if (
        !opts.force &&
        result.code === "E_UNRESOLVED_THREADS" &&
        result.unresolved !== undefined
      ) {
        setPendingImplement(opts.implement ?? false);
        setStage({
          kind: "warn",
          unresolved: result.unresolved,
          openComments: result.openComments ?? 0,
        });
        return;
      }
      setError(
        result.code === "E_UNREACHABLE"
          ? "couldn't reach otacond — is it up?"
          : (result.message ?? result.code),
      );
    });
  };

  const canSend = stage.kind === "warn" && stage.openComments > 0;

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
              {canSend && (
                <>
                  <strong>Send to agent</strong> hands{" "}
                  {stage.openComments === 1
                    ? "the open comment"
                    : `the ${stage.openComments} open comments`}{" "}
                  back for one fold-in pass, then{" "}
                  {pendingImplement ? "commits and starts the build" : "commits"} — you're done the
                  moment you click, and the agent's resolutions land in the plan's Review notes.{" "}
                </>
              )}
              {pendingImplement
                ? "Commit & Implement anyway finalizes the plan as it stands and starts the build; the open threads close unaddressed."
                : "Commit anyway finalizes the plan as it stands; the open threads end with the session."}
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
                onClick={() => fire({ implement: false })}
              >
                {busy ? "committing…" : "Commit Plan"}
              </button>
              <button
                type="button"
                className="btn btn-implement"
                disabled={busy}
                onClick={() => fire({ implement: true })}
              >
                {busy ? "starting…" : "Commit & Implement"}
              </button>
            </>
          ) : (
            <>
              {canSend && (
                <button
                  type="button"
                  className="btn btn-send"
                  disabled={busy}
                  onClick={() => fire({ sendOpenComments: true, implement: pendingImplement })}
                >
                  {busy ? "sending…" : "Send to agent"}
                </button>
              )}
              <button
                type="button"
                className="btn btn-force"
                disabled={busy}
                // Re-fire the SAME variant the user chose: a Commit & Implement
                // that hit unresolved threads must still implement on retry.
                onClick={() => fire({ force: true, implement: pendingImplement })}
              >
                {busy
                  ? pendingImplement
                    ? "starting…"
                    : "committing…"
                  : pendingImplement
                    ? "Commit & Implement anyway"
                    : "Commit anyway"}
              </button>
            </>
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

/**
 * The read-only finalizing notice (comment & approve, §12, D2): the screen the
 * reviewer sees the instant they hit "Send to agent" — the agent is folding the
 * open comments in and will commit on its next pass, after which the SSE frame
 * flips the screen to the approved notice (or stays live as `implementing`). A
 * hung fold-in is escapable: "Commit anyway" force-drops the still-open threads
 * and finalizes the current revision now (D7).
 */
export function ApprovingNote({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commitAnyway = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // The daemon honors the implement choice carried on pendingApproval, so the
    // escape doesn't need to re-send it — just force the current revision through.
    void postApprove(sessionId, { force: true }).then((result) => {
      setBusy(false);
      // Success: the SSE frame flips the screen (approved / implementing). On
      // the rare failure, surface it so the reviewer isn't left guessing.
      if (!result.ok) {
        setError(
          result.code === "E_UNREACHABLE"
            ? "couldn't reach otacond — is it up?"
            : (result.message ?? result.code),
        );
      }
    });
  };

  return (
    <aside className="approving-note" role="status">
      <span className="approving-spin" aria-hidden="true">
        ⏳
      </span>
      <span className="approved-word">approving</span>
      <span className="approving-detail">agent finalizing — folding open comments in…</span>
      <button type="button" className="approving-escape" disabled={busy} onClick={commitAnyway}>
        {busy ? "committing…" : "Commit anyway"}
      </button>
      {error !== null && <span className="approving-error">{error}</span>}
    </aside>
  );
}
