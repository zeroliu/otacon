// Whether the viewport is at/above the 960px sidebar breakpoint, tracked live off
// the same `min-width: 960px` media query the CSS shell uses, so the JS chrome
// (the welcome pane's inline list, the session sheet's mount guard) flips in
// lockstep with the layout. The pure breakpoint math lives in session-sheet-state
// (isDesktopWidth); this is the React subscription around it, seeded from the live
// width so the first render is already correct.

import { useEffect, useState } from "react";
import { isDesktopWidth, SIDEBAR_VIEWPORT } from "./session-sheet-state";

export function useDesktopWidth(): boolean {
  const [desktop, setDesktop] = useState(() => isDesktopWidth(window.innerWidth));
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${SIDEBAR_VIEWPORT}px)`);
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return desktop;
}
