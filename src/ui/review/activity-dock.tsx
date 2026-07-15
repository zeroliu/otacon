// Shared session activity surface for both plan and PR review. The normalized
// stream, folding model, bar, and console remain one implementation; each
// session screen only chooses where the dock sits in its own reading layout.

import { useState } from "react";
import type { AnySessionStatus, StreamEvent } from "../api";
import { isAgentActive } from "./console-model";
import { LiveConsole } from "./live-console";
import { NowPlaying } from "./now-playing";

export function ActivityDock({
  stream,
  status,
  now,
  className,
  alwaysVisible = false,
}: {
  stream: StreamEvent[];
  status: AnySessionStatus;
  now: number;
  className?: string;
  /** PR review keeps the log affordance present across authoring/review/Done. */
  alwaysVisible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const visible = alwaysVisible || isAgentActive(status) || stream.length > 0;
  if (!visible) return null;
  const classes = ["now-playing-dock", open && "is-open", className].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <NowPlaying
        stream={stream}
        status={status}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      />
      {open && <LiveConsole stream={stream} now={now} />}
    </div>
  );
}
