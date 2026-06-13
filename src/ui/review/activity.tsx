// The live activity log (DESIGN.md §6, §10): the agent's `otacon progress`
// narration as append-only telemetry — what it's reading, drafting, revising —
// so the review surface shows work happening from the first second, before any
// revision exists. A compact collapsible panel on the review screen (near the
// Interview panel); the pre-plan placeholder leads with it open, since during
// research + drafting it's the main thing to watch. The newest note also rides
// the draft status chip (src/ui/chip.tsx); the full feed lives here.

import { memo, useState } from "react";
import type { ActivityNote } from "../api";
import { relativeTime } from "../format";

// memo'd like the Interview panel: the review loop re-renders per selection
// tick, while the feed and the clock only change on SSE frames or the screen
// tick.
export const ActivityLog = memo(function ActivityLog({
  activity,
  now,
  defaultOpen = false,
}: {
  activity: ActivityNote[];
  /** A ticking clock (useNow) so "3m ago" stays honest while the screen idles. */
  now: number;
  /** Pre-plan leads with the log open; the review screen starts it collapsed. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (activity.length === 0) return null;
  const latest = activity[activity.length - 1];

  return (
    <section className="activity" aria-label="agent activity log">
      <button
        type="button"
        className="activity-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="activity-glyph" aria-hidden="true">
          »
        </span>
        <span className="activity-word">activity</span>
        {!open && latest && <span className="activity-latest">{latest.text}</span>}
        <span className="activity-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        // column-reverse renders newest-on-top while DOM order stays oldest→
        // newest, so append-only forward-index keys never churn.
        <ol className="activity-body">
          {activity.map((note, i) => (
            <li className="act-entry" key={i}>
              <span className="act-when">{relativeTime(note.at, now)}</span>
              <span className="act-text">{note.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
});
