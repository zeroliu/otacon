// Keyboard-aware bottom sheets (review UI): on a phone the on-screen
// keyboard slides over the bottom-docked composer/menu/approve sheets, burying
// their Send buttons, and the page behind keeps scrolling while you type. The
// hooks here fix both: `useKeyboardInset` measures how much of the layout the
// keyboard now covers, `useKeyboardInsetVar` publishes that as the CSS var
// sheets ride, `useSheetViewport` tracks the phone breakpoint, and
// `useScrollLock` pins the page behind an open sheet. The math/DOM primitives
// are pulled out as pure functions so they unit-test without a real
// VisualViewport or a live React tree (the same split as compact.ts).

import { useEffect, useState } from "react";

/**
 * The gap (px) between the layout viewport's bottom and the visual viewport's
 * bottom — i.e. how much of the layout the on-screen keyboard now covers.
 * `layoutHeight` is `window.innerHeight`; `vv` is the live `VisualViewport`
 * (null when unsupported). Clamped at 0: no keyboard, an absent API, or a
 * pulled-down URL bar (which makes the visual viewport *taller*) all read as
 * "no inset", so a sheet only ever rises, never sinks below its resting spot.
 */
export function keyboardInset(
  layoutHeight: number,
  vv: { height: number; offsetTop: number } | null,
): number {
  if (!vv) return 0;
  return Math.max(0, layoutHeight - (vv.height + vv.offsetTop));
}

/**
 * The live keyboard inset in px, tracked off `window.visualViewport`
 * (recomputed on its `resize` + `scroll` events, both removed on teardown).
 * 0 whenever no keyboard is up or the API is unsupported — every desktop
 * browser, where there is no on-screen keyboard to clear. Bottom-anchored
 * sheets add this to their `bottom` (the `--kb-inset` CSS var) to ride above
 * the keyboard as it animates in and out.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return; // unsupported / desktop without an on-screen keyboard
    const measure = () =>
      setInset(keyboardInset(window.innerHeight, { height: vv.height, offsetTop: vv.offsetTop }));
    measure();
    vv.addEventListener("resize", measure);
    vv.addEventListener("scroll", measure);
    return () => {
      vv.removeEventListener("resize", measure);
      vv.removeEventListener("scroll", measure);
    };
  }, []);
  return inset;
}

/**
 * Publish the live keyboard inset as the `--kb-inset` CSS var on the root
 * element (removed on unmount). Bottom sheets style their `bottom` with
 * `var(--kb-inset, 0px)` (styles.css), so any screen that mounts this hook
 * gets keyboard-riding sheets; the fallback keeps them resting when no
 * screen publishes the var.
 */
export function useKeyboardInsetVar(): void {
  const inset = useKeyboardInset();
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--kb-inset", `${inset}px`);
    return () => {
      root.style.removeProperty("--kb-inset");
    };
  }, [inset]);
}

/**
 * True below `breakpoint` px, tracked reactively via matchMedia so the value
 * follows rotations and window resizes. Callers gate phone-sheet concerns
 * (the scroll lock, bottom-sheet placement) on it; pass a breakpoint kept in
 * lockstep with the CSS face-swap media query (SHEET_VIEWPORT, feedback.tsx)
 * so the lock engages exactly when sheets are bottom-docked.
 */
export function useSheetViewport(breakpoint: number): boolean {
  // Guard the initializer only: it runs wherever the component renders (a
  // window-less environment included), while the effect below is browser-only.
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && window.innerWidth < breakpoint,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => setPhone(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpoint]);
  return phone;
}

/**
 * Pin `body` in place and return a thunk that restores it. The fixed-position +
 * negative-top technique — `overflow: hidden` alone does not hold iOS Safari's
 * momentum scroll — shifted up by `scrollY` so the page does not visibly jump.
 * Every touched style is saved and put back exactly (so nothing leaks if `body`
 * already carried inline styles); the caller re-applies the scroll offset after
 * restoring, since clearing `position: fixed` drops it.
 */
export function lockScroll(body: HTMLElement, scrollY: number): () => void {
  const prior = {
    position: body.style.position,
    top: body.style.top,
    left: body.style.left,
    right: body.style.right,
    width: body.style.width,
    overflow: body.style.overflow,
  };
  body.style.position = "fixed";
  body.style.top = `-${scrollY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.style.overflow = "hidden";
  return () => {
    body.style.position = prior.position;
    body.style.top = prior.top;
    body.style.left = prior.left;
    body.style.right = prior.right;
    body.style.width = prior.width;
    body.style.overflow = prior.overflow;
  };
}

/**
 * Freeze the page behind a bottom sheet while `active`, restoring the exact
 * scroll position on release. Engaged only by the caller's phone-width +
 * sheet-open gate, so desktop popovers are untouched. The keyboard can shift
 * the page behind an open sheet as the layout reflows; locking the body stops
 * that drift so only the sheet moves.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const scrollY = window.scrollY;
    const restore = lockScroll(document.body, scrollY);
    return () => {
      restore();
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}
