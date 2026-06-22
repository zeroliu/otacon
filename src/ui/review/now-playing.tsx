// The always-on "now playing" status bar (the live-activity stream, §10a): a
// slim, sticky one-line readout pinned directly under the ReviewHeader that
// answers "what is the agent doing right now?" at a glance, and toggles the full
// live console open. It replaces the old buried, default-closed activity fold:
// this bar is ALWAYS visible while the agent is active or any stream data
// exists, so the work is never hidden.
//
// Left to right: a kind glyph for the current event, the current label (a
// trailing `thinking` shows dimmed/italic), a ticking elapsed timer when the
// latest tool call is still running, then a pushed-right cluster of a small
// live/notes mode badge, a pulse dot (only while the session is agent-active),
// and the expand caret. Clicking the bar toggles the console.

import { memo, useEffect, useState } from "react";
import type { SessionStatus, StreamEvent } from "../api";
import { isAgentActive, nowPlaying, streamMode } from "./console-model";
import { KIND_GLYPH } from "./console-rows";

/** mm:ss elapsed since `iso`, clamped at 0; a tool call's run-time on the bar. */
function elapsed(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "0:00";
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * A 1s clock that runs only while `active` (a tool call is running), so the
 * elapsed timer actually ticks per second instead of jumping with the shared
 * 30s `useNow`. Returns `Date.now()` and stops its interval the moment the call
 * settles, so an idle bar carries no perpetual re-render.
 */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export const NowPlaying = memo(function NowPlaying({
  stream,
  status,
  open,
  onToggle,
}: {
  stream: StreamEvent[];
  status: SessionStatus;
  /** Whether the console below is expanded; drives the caret + aria-expanded. */
  open: boolean;
  onToggle: () => void;
}) {
  const np = nowPlaying(stream);
  const active = isAgentActive(status);
  const mode = streamMode(stream);
  // The elapsed timer needs per-second resolution; the shared 30s clock would
  // make it lurch. Tick locally only while a tool call is running.
  const now = useSecondTick(np?.running ?? false);

  // The resting line when no stream event exists yet (pre-capture, or the floor
  // before the first progress note): calm, no pulse, but still the affordance to
  // open the console so the user learns it is there.
  const label = np ? np.event.label : active ? "working…" : "idle";

  return (
    <button
      type="button"
      className={`now-playing${active ? " is-active" : ""}${open ? " is-open" : ""}`}
      aria-expanded={open}
      aria-label="agent activity: toggle the live console"
      onClick={onToggle}
    >
      <span className="np-glyph" aria-hidden="true">
        {np ? KIND_GLYPH[np.event.kind] : "·"}
      </span>
      <span className={np?.dim ? "np-label is-dim" : "np-label"}>{label}</span>
      {np?.running && (
        <span className="np-timer" aria-label="elapsed">
          {elapsed(np.event.at, now)}
        </span>
      )}
      <span className="np-spacer" />
      <span className={`np-mode np-mode-${mode}`} title={MODE_TITLE[mode]}>
        {mode}
      </span>
      {active && (
        <span className="np-pulse" aria-hidden="true">
          <span className="np-pulse-dot" />
        </span>
      )}
      <span className="np-caret" aria-hidden="true">
        {open ? "▾" : "▸"}
      </span>
    </button>
  );
});

const MODE_TITLE: Record<"live" | "notes", string> = {
  live: "capturing the agent's tool/text activity (an adapter is attached)",
  notes: "manual otacon progress notes only (no capture adapter for this agent)",
};
