// The approve flow: a deliberate control —
// no keyboard shortcut exists, on purpose — opening a confirm sheet whose
// copy is honest about what happens. Two primary actions:
//   • save plan: the daemon writes the approved plan to your home store
//     (~/.otacon/sessions/) AND a copy into this project's plans dir (default
//     .otacon/plans). You commit the project copy if you want it in git. The
//     session is over.
//   • implement: same finalize, but the plan stays in the home store only
//     (nothing into the project) and the same agent builds it (worktree →
//     per-phase implement+review loop → PR); the session stays live as
//     `implementing` rather than ending, and asks you on the first blocker.
// Unresolved threads answer 409 with the count; the sheet flips to its amber
// warning state with two ways past it (re-firing the SAME variant the user
// picked — the warn stage remembers it):
//   • send to agent (comment & approve) — when open comments exist, hand them
//     to the agent for one fold-in pass; the daemon defers the finalize
//     (`finalizing`) and the SSE frame drives the screen, so the dialog just
//     closes. The reviewer is done the instant they click.
//   • save anyway / implement anyway — force-drop the open threads and finalize.
// A Save ends read-only behind the quiet approved notice (naming the saved
// location); an Implement hands off to the live `implementing` frame; a
// send-to-agent approve shows the read-only finalizing notice (ApprovingNote)
// until the agent finalizes.

import { useEffect, useState } from "react";
import type { ApproveOptions, ApproveResult } from "../api";
import { postApprove } from "../api";

type Stage =
  | { kind: "confirm" }
  // The drafts gate (review UI, D1/D3): a Save/Implement variant was picked
  // while unsent drawer drafts are staged. Interjects before finalize so they're
  // never silently dropped; carries the variant on `pendingImplement`.
  | { kind: "drafts" }
  | { kind: "warn"; unresolved: number; openComments: number };

/**
 * The next UI move from an approve POST result, factored out so the direct
 * "fire" path and the drafts "Send & approve" flush-then-fold path share one
 * honest translation (and it stays unit-testable without a live daemon). A
 * `force` caller never bounces to the warn stage: a forced approve drops the
 * open threads on purpose, so its 409 surfaces as an error, not a second warn.
 * `approved` carries both the reported `path` (Save = the project copy, Implement
 * = the home copy) and the absolute `home` copy path, so the note is honest
 * about every place the plan landed.
 */
export type ApproveMove =
  | { kind: "approved"; path: string; home: string }
  | { kind: "finalizing" }
  | { kind: "warn"; unresolved: number; openComments: number }
  | { kind: "error"; message: string };

export function approveMove(result: ApproveResult, force: boolean): ApproveMove {
  if (result.ok) {
    return "finalizing" in result
      ? { kind: "finalizing" }
      : { kind: "approved", path: result.path, home: result.home };
  }
  if (!force && result.code === "E_UNRESOLVED_THREADS" && result.unresolved !== undefined) {
    return { kind: "warn", unresolved: result.unresolved, openComments: result.openComments ?? 0 };
  }
  return {
    kind: "error",
    message:
      result.code === "E_UNREACHABLE"
        ? "couldn't reach otacond — is it up?"
        : (result.message ?? result.code),
  };
}

export function ApproveDialog({
  sessionId,
  revision,
  pendingCount,
  onFlushDrafts,
  onDiscardDrafts,
  onClose,
  onApproved,
}: {
  sessionId: string;
  revision: number;
  /** Unsent drawer drafts (browser-only until Send): >0 arms the drafts gate. */
  pendingCount: number;
  /** Flush the staged drafts as one batch (POST /comments); true on the 202. */
  onFlushDrafts: () => Promise<boolean>;
  /** Drop the browser-only drafts (irreversible); local drawer state only. */
  onDiscardDrafts: () => void;
  onClose: () => void;
  /**
   * Receives the saved plan's reported path (Save = the project copy, Implement
   * = the home copy) plus the absolute `home` copy path, so the approved note
   * can name both. The session frame flips the UI; `implement` is the chosen
   * variant — the caller leaves the screen interactive for it (the `implementing`
   * frame drives the UI), read-only for a plain Save end.
   */
  onApproved: (path: string, home: string, implement: boolean) => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "confirm" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The variant a warn-stage action must re-fire. Set when the unresolved-threads
  // warning bounces the first attempt, so both "Send to agent" and "Save/Implement
  // anyway" carry the same implement flag the user chose at the confirm stage
  // (rather than silently downgrading an Implement to a plain Save).
  const [pendingImplement, setPendingImplement] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Consume a move from approveMove: approved closes through onApproved (the
  // caller pins the path / leaves the build live), a deferred finalize just
  // closes (the SSE `finalizing` frame drives the screen), an unresolved 409
  // re-asks on the warn stage carrying the chosen variant, and an error stays
  // put with the reason shown. The "lost race" re-render (a Send-to-agent retry
  // whose open comments vanished, now openComments=0) rides the warn case too.
  const apply = (move: ApproveMove, implement: boolean) => {
    switch (move.kind) {
      case "approved":
        onApproved(move.path, move.home, implement);
        return;
      case "finalizing":
        onClose();
        return;
      case "warn":
        setPendingImplement(implement);
        setStage({ kind: "warn", unresolved: move.unresolved, openComments: move.openComments });
        return;
      case "error":
        setError(move.message);
        return;
    }
  };

  const fire = (opts: ApproveOptions) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void postApprove(sessionId, opts).then((result) => {
      setBusy(false);
      apply(approveMove(result, opts.force ?? false), opts.implement ?? false);
    });
  };

  // An approve variant was chosen (Save Plan / Implement). With unsent drawer
  // drafts staged, interject the drafts gate carrying the variant (D1/D3); a
  // clean drawer finalizes straight away.
  const pickVariant = (implement: boolean) => {
    if (busy) return;
    setError(null); // a prior sendAndApprove error bounced us here; don't carry it in
    if (pendingCount > 0) {
      setPendingImplement(implement);
      setStage({ kind: "drafts" });
      return;
    }
    fire({ implement });
  };

  // Send & approve (D2): flush the staged drafts into real OPEN threads, then fold
  // them in through the existing comment & approve path in one click. Busy stays
  // lit across both legs (the `finally` is the single release, so even a thrown
  // post can't strand it). A failed flush keeps the drafts (never sent) and shows
  // the reason. Once the flush lands the drafts are real threads (not lost), so a
  // later approve *error* drops back to confirm with the reason shown (retry the
  // approve, nothing to re-send); a residual 409 (the open comments were resolved
  // out from under the flush) re-asks on the warn stage through `apply`.
  const sendAndApprove = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        if (!(await onFlushDrafts())) {
          setError("couldn't send your staged comments. They're still here; try again");
          return;
        }
        const move = approveMove(
          await postApprove(sessionId, { sendOpenComments: true, implement: pendingImplement }),
          false,
        );
        if (move.kind === "error") {
          setStage({ kind: "confirm" });
          setError(move.message);
          return;
        }
        apply(move, pendingImplement);
      } finally {
        setBusy(false);
      }
    })();
  };

  // Discard & approve: drop the browser-only drafts (irreversible) and finalize the
  // chosen variant. Server-side open threads, if any, still route through the
  // normal warn on the fire below; only the local drafts are dropped here.
  const discardAndApprove = () => {
    if (busy) return;
    onDiscardDrafts();
    fire({ implement: pendingImplement });
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
        className={
          stage.kind === "warn"
            ? "approve-sheet approve-warning"
            : stage.kind === "drafts"
              ? "approve-sheet approve-drafts"
              : "approve-sheet"
        }
        role="dialog"
        aria-modal="true"
        aria-label="approve plan"
      >
        <div className="approve-head">
          <span className="approve-mode">
            {stage.kind === "warn"
              ? "⚠ unresolved threads"
              : stage.kind === "drafts"
                ? "✎ unsent comments"
                : "approve plan"}
          </span>
          <button type="button" className="composer-close" onClick={onClose}>
            esc
          </button>
        </div>
        {stage.kind === "confirm" ? (
          <>
            <p className="approve-copy">
              Finalize <strong>r{revision}</strong>. otacon never commits it — you commit it
              yourself if you want. Either save the plan, or hand the same agent the build.
            </p>
            <p className="approve-sub">
              <strong>Save Plan</strong> writes the plan to your home store (
              <code>~/.otacon/sessions/</code>) and a copy into this project&apos;s plans dir
              (default <code>.otacon/plans</code>); the session is over.{" "}
              <strong>Implement</strong> keeps the plan in the home store (nothing into the
              project) and hands the same agent the build: it opens a worktree and walks the phases
              (implement → review → fix), opening a PR when every phase is green. The session stays
              live as <em>implementing</em> and asks you on the first blocker.
            </p>
          </>
        ) : stage.kind === "drafts" ? (
          <>
            <p className="approve-copy">
              <strong>{pendingCount}</strong> staged{" "}
              {pendingCount === 1 ? "comment" : "comments"} in the drawer{" "}
              {pendingCount === 1 ? "hasn't" : "haven't"} been sent yet. Send{" "}
              {pendingCount === 1 ? "it" : "them"} to the agent with this approve, or discard{" "}
              {pendingCount === 1 ? "it" : "them"}.
            </p>
            <p className="approve-sub">
              <strong>Send &amp; approve</strong> flushes{" "}
              {pendingCount === 1 ? "the comment" : `the ${pendingCount} comments`} as open
              threads and hands {pendingCount === 1 ? "it" : "them"} to the agent to fold in, then{" "}
              {pendingImplement ? "saves the plan and starts the build" : "saves the plan"}.{" "}
              <strong>Discard &amp; approve</strong> drops {pendingCount === 1 ? "it" : "them"} from
              your browser (this can't be undone) and finalizes the plan as it stands.
            </p>
          </>
        ) : (
          <>
            <p className="approve-copy">
              <strong>{stage.unresolved}</strong> unresolved{" "}
              {stage.unresolved === 1 ? "thread" : "threads"} — comments you haven't
              Resolved, plus asks with neither an answer nor a Resolve.
            </p>
            <p className="approve-sub">
              {canSend && (
                <>
                  <strong>Send to agent</strong> hands{" "}
                  {stage.openComments === 1
                    ? "the comment still owed a response"
                    : `the ${stage.openComments} comments still owed a response`}{" "}
                  back for one fold-in pass, then{" "}
                  {pendingImplement ? "saves and starts the build" : "saves the plan"} — you're done the
                  moment you click, and the agent's replies land in the plan's Review notes.{" "}
                </>
              )}
              {pendingImplement
                ? "Implement anyway finalizes the plan as it stands and starts the build; the open threads close unaddressed."
                : "Save anyway finalizes the plan as it stands; the open threads end with the session."}
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
                onClick={() => pickVariant(false)}
              >
                {busy ? "saving…" : "Save Plan"}
              </button>
              <button
                type="button"
                className="btn btn-implement"
                disabled={busy}
                onClick={() => pickVariant(true)}
              >
                {busy ? "starting…" : "Implement"}
              </button>
            </>
          ) : stage.kind === "drafts" ? (
            <>
              {/* Discard is the irreversible move, so it carries the amber escape
                  tone and sits left of the recommended Send; Cancel stays the
                  safe default (leftmost, plain). */}
              <button
                type="button"
                className="btn btn-force"
                disabled={busy}
                onClick={discardAndApprove}
              >
                {busy ? (pendingImplement ? "starting…" : "saving…") : "Discard & approve"}
              </button>
              <button
                type="button"
                className="btn btn-send"
                disabled={busy}
                onClick={sendAndApprove}
              >
                {busy ? "sending…" : "Send & approve"}
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
                // Re-fire the SAME variant the user chose: an Implement that hit
                // unresolved threads must still implement on retry.
                onClick={() => fire({ force: true, implement: pendingImplement })}
              >
                {busy
                  ? pendingImplement
                    ? "starting…"
                    : "saving…"
                  : pendingImplement
                    ? "Implement anyway"
                    : "Save anyway"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The quiet post-approve notice (review UI): the saved plan's location right after
 * approving (this tab heard the response) — the project copy under the plans
 * dir, plus the home copy. otacon never commits it; after a reload the live
 * path is gone, so the notice falls back to naming the home copy folder.
 */
export function ApprovedNote({ path, home }: { path: string | null; home?: string | null }) {
  return (
    <aside className="approved-note" role="status">
      <span className="approved-check" aria-hidden="true">
        ✓
      </span>
      <span className="approved-word">approved</span>
      <span className="approved-path">
        → {path ?? "~/.otacon/sessions/ (home copy)"}
        {path !== null && home ? ` · saved in ${home}` : ""}
      </span>
      <span className="approved-over">session over · read-only</span>
    </aside>
  );
}

/**
 * The read-only finalizing notice (comment & approve, approval and archive lifecycle, D2): the screen the
 * reviewer sees the instant they hit "Send to agent" — the agent is folding the
 * open comments in and will commit on its next pass, after which the SSE frame
 * flips the screen to the approved notice (or stays live as `implementing`). A
 * hung fold-in is escapable: "Finalize anyway" force-drops the still-open threads
 * and finalizes the current revision now (D7).
 */
export function ApprovingNote({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finalizeAnyway = () => {
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
      <button type="button" className="approving-escape" disabled={busy} onClick={finalizeAnyway}>
        {busy ? "finalizing…" : "Finalize anyway"}
      </button>
      {error !== null && <span className="approving-error">{error}</span>}
    </aside>
  );
}
