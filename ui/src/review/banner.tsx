// The re-review chrome (DESIGN.md §9, §10): the new-revision banner — an
// incoming-transmission card carrying the agent's changelog with the
// _changelog / diff / dismiss_ verbs — and the controls strip under the
// session head: the [clean|diff] segmented toggle, the diff baseline picker
// ("vs r2 ▾"), the changed-section tally with its j/k hint, and the changelog
// recall button. Banner visibility is *derived server state*: it shows while
// lastReviewedRevision < revision, and Dismiss simply POSTs /reviewed — the
// session SSE frame that answers it moves the baseline and unmounts the
// banner, clears the gutter markers, and re-aims the default diff, all
// without local bookkeeping.

import { useState } from "react";

export function RevisionBanner({
  revision,
  changelog,
  fresh,
  onViewDiff,
  onDismiss,
  onClose,
}: {
  revision: number;
  /** undefined = the payload for this revision is still loading. */
  changelog: string | null | undefined;
  /** True while unreviewed (banner mode); false = changelog recall strip. */
  fresh: boolean;
  onViewDiff: () => void;
  /** POSTs /reviewed; resolves false on failure (banner stays, hint shows). */
  onDismiss: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const dismiss = () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    void onDismiss().then((ok) => {
      // On success the session frame moves the baseline and unmounts this.
      setBusy(false);
      if (!ok) setFailed(true);
    });
  };

  return (
    <aside
      className={fresh ? "rev-banner rev-fresh" : "rev-banner"}
      role="status"
      aria-label={fresh ? `revision ${revision} received` : `changelog for revision ${revision}`}
    >
      <div className="rev-head">
        <span className="rev-pulse" aria-hidden="true">
          ▌
        </span>
        <span className="rev-label">{fresh ? `r${revision} received` : `changelog · r${revision}`}</span>
        {!fresh && (
          <button type="button" className="composer-close" onClick={onClose}>
            close
          </button>
        )}
      </div>
      <p className="rev-changelog">
        {changelog === undefined ? "…" : changelog ?? "(the agent sent no changelog)"}
      </p>
      {fresh && (
        <div className="rev-actions">
          {failed && (
            <span className="composer-hint composer-failed">couldn't mark reviewed — is otacond up?</span>
          )}
          <button type="button" className="btn btn-ghost" onClick={onViewDiff}>
            view diff
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={dismiss}>
            {busy ? "dismissing…" : "dismiss"}
          </button>
        </div>
      )}
    </aside>
  );
}

export type ReviewView = "clean" | "diff";

export function ReviewControls({
  view,
  onView,
  revision,
  lastReviewed,
  baseline,
  onBaseline,
  changedCount,
  showChangelog,
  changelogOpen,
  onToggleChangelog,
  onApprove,
}: {
  view: ReviewView;
  onView: (view: ReviewView) => void;
  revision: number;
  lastReviewed: number;
  /** The effective diff baseline (a pick, or last-reviewed by default). */
  baseline: number;
  onBaseline: (n: number) => void;
  changedCount: number;
  showChangelog: boolean;
  changelogOpen: boolean;
  onToggleChangelog: () => void;
  /**
   * Opens the approve confirm sheet (DESIGN.md §10) — undefined on an
   * approved session. Click-only: no keyboard shortcut exists, on purpose.
   */
  onApprove?: () => void;
}) {
  // Prior revisions, newest first, down to the always-reachable empty plan;
  // last-reviewed keeps its seat even when it equals the current revision.
  const top = lastReviewed === revision ? revision : revision - 1;
  const options: number[] = [];
  for (let n = top; n >= 0; n--) options.push(n);
  return (
    <div className="review-controls">
      <div className="seg" role="group" aria-label="plan view">
        <button
          type="button"
          className={view === "clean" ? "seg-btn seg-on" : "seg-btn"}
          aria-pressed={view === "clean"}
          onClick={() => onView("clean")}
        >
          clean
        </button>
        <button
          type="button"
          className={view === "diff" ? "seg-btn seg-on" : "seg-btn"}
          aria-pressed={view === "diff"}
          onClick={() => onView("diff")}
        >
          diff
        </button>
      </div>
      {view === "diff" && (
        <label className="baseline">
          vs
          <span className="baseline-wrap">
            <select
              aria-label="diff baseline"
              value={baseline}
              onChange={(event) => onBaseline(Number(event.target.value))}
            >
              {options.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "r0 · empty" : `r${n}`}
                  {n === lastReviewed && n > 0 ? " · last reviewed" : ""}
                </option>
              ))}
            </select>
          </span>
        </label>
      )}
      {changedCount > 0 && (
        <span className="changed-tally">
          <span className="tally-mark" aria-hidden="true">
            ▌
          </span>
          {changedCount} changed
          <span className="tally-keys">
            <kbd>j</kbd>/<kbd>k</kbd>
          </span>
        </span>
      )}
      {showChangelog && (
        <button
          type="button"
          className="ctrl-changelog"
          aria-pressed={changelogOpen}
          onClick={onToggleChangelog}
        >
          changelog
        </button>
      )}
      {onApprove && (
        <button type="button" className="ctrl-approve" onClick={onApprove}>
          <span aria-hidden="true">✓</span> approve
        </button>
      )}
    </div>
  );
}
