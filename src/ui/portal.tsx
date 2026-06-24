// Portal: renders modal overlays (confirm dialogs, the section menu, the mobile
// session sheet) into document.body instead of inline where they are triggered.
// Inline, an overlay is trapped in its nearest ancestor stacking context: a delete
// confirm opened from a sidebar row lives inside the position:sticky
// `.app-sidebar`, which paints before `.app-content`, so the main column's grill
// cards paint above the overlay no matter how high its z-index climbs (z stays
// local to the trapped context). Portaling to body lifts the overlay out of every
// ancestor stacking context, so its global z-index actually wins.

import { createPortal } from "react-dom";
import type { ReactNode } from "react";

export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
