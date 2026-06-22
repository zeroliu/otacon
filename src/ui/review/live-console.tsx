// The expandable live console (the live-activity stream, §10a): the full
// firehose one click below the now-playing bar. A terminal-feel scrolling list,
// newest at the bottom, that folds the raw stream into rows (a running event
// paired with its outcome, repeated calls collapsed to a count, thinking off by
// default), with kind-filter chips and a thinking toggle. Highlights ride
// through as chapter dividers. Auto-scrolls to the latest only when the user is
// already pinned to the bottom, so scrolling up to read history is never yanked.
//
// The folding/selection logic lives in console-model.ts (pure, unit-tested);
// this component owns only the chrome, the toggles, and the scroll behavior.

import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StreamEvent } from "../api";
import { buildRows, type StreamFilter } from "./console-model";
import { ConsoleRowView } from "./console-rows";

const FILTERS: { key: StreamFilter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "tool", label: "tools" },
  { key: "text", label: "text" },
  { key: "thinking", label: "thinking" },
];

/** Within this many px of the bottom counts as "pinned": auto-scroll follows. */
const PIN_SLOP = 24;

export const LiveConsole = memo(function LiveConsole({
  stream,
  now,
}: {
  stream: StreamEvent[];
  /** A ticking clock (useNow) so the rows' relative times stay honest. */
  now: number;
}) {
  const [filter, setFilter] = useState<StreamFilter>("all");
  // Thinking is the noisiest kind, so it is hidden behind an opt-in toggle that
  // is OFF by default. Picking the Thinking *filter* implies wanting to see it,
  // so that chip force-shows thinking regardless of the toggle (a coherent UX:
  // the filter is the strong intent). The toggle governs the other views.
  const [showThinking, setShowThinking] = useState(false);
  const effectiveThinking = showThinking || filter === "thinking";

  const rows = useMemo(
    () => buildRows(stream, filter, effectiveThinking),
    [stream, filter, effectiveThinking],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user is pinned to the bottom *before* the DOM updates, so
  // a new row only auto-scrolls when they were already at the latest. Read in a
  // layout effect (pre-paint) and applied after, so there is no flash, no yank.
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLOP;
  };
  // Land at the bottom on mount (a terminal opens on its tail) and on every new
  // row, but only when the user was pinned to the bottom, so reading history
  // is never yanked. `mounted` flips after the first pass so the open-at-tail
  // jump always wins regardless of the initial pinned guess.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!mounted.current || pinnedRef.current) el.scrollTop = el.scrollHeight;
    mounted.current = true;
  }, [rows.length]);

  return (
    <section className="live-console" aria-label="live activity console">
      <div className="lc-controls">
        <div className="lc-filters" role="group" aria-label="filter by kind">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filter === f.key ? "lc-chip is-on" : "lc-chip"}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={effectiveThinking ? "lc-think is-on" : "lc-think"}
          aria-pressed={effectiveThinking}
          // The Thinking filter pins thinking on; the toggle is then redundant.
          disabled={filter === "thinking"}
          onClick={() => setShowThinking((v) => !v)}
          title="thinking is hidden by default: the noisiest stream"
        >
          <span className="lc-think-box" aria-hidden="true">
            {effectiveThinking ? "▣" : "▢"}
          </span>
          thinking
        </button>
      </div>
      <div className="lc-scroll" ref={scrollRef} onScroll={onScroll}>
        {rows.length === 0 ? (
          <p className="lc-empty">// nothing captured yet</p>
        ) : (
          <ol className="lc-rows">
            {rows.map((row) => (
              <ConsoleRowView key={row.key} row={row} now={now} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
});
