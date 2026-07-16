// The selection instruments (review UI): a docked Comment/Ask bar that
// appears when review text is selected, plus the anchored composer both actions
// open. Plan review and PR review dock the bar at the same fixed bottom edge so
// it never competes with the OS selection/dictionary popover, and both pin the
// composer through the shared `composerPlacement`. Comment delivery is
// configurable: the plan can stack a draft into its drawer, while a
// PR creates a conversation thread immediately. The composer pins where it
// opened — its anchor is already captured, so the live selection no longer
// matters once it is open.

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Anchor } from "../api";
import type { CapturedSelection } from "./anchor";
import { anchorLabel, captureSelection } from "./anchor";

/** Track the live selection inside `ref` while `enabled` (composer closed). */
export function useSelection(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): CapturedSelection | null {
  const [selection, setSelection] = useState<CapturedSelection | null>(null);
  useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = ref.current;
      setSelection(el ? captureSelection(el) : null);
    };
    // selectionchange fires per mousemove during a drag and capture-phase
    // scroll per frame; coalescing to one capture per animation frame keeps
    // the O(section text) prefix/suffix serialization off the input path.
    const update = () => {
      if (raf === 0) raf = requestAnimationFrame(measure);
    };
    measure();
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true); // reposition, don't strand
    window.addEventListener("resize", update);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [ref, enabled]);
  return selection;
}

export function SelectionBar({
  selection,
  onComment,
  onAsk,
}: {
  selection: CapturedSelection;
  onComment: () => void;
  onAsk: () => void;
}) {
  const { anchor } = selection;
  return (
    <div
      className="sel-bar"
      role="toolbar"
      aria-label="selection actions"
      // preventDefault keeps the text selection alive through the click
      onMouseDown={(event) => event.preventDefault()}
    >
      <span className="sel-slug">#{anchor.section}</span>
      <button type="button" className="sel-btn" onClick={onComment}>
        comment<kbd className="sel-key">c</kbd>
      </button>
      <span className="sel-divide" aria-hidden="true" />
      <button type="button" className="sel-btn" onClick={onAsk}>
        ask<kbd className="sel-key">q</kbd>
      </button>
    </div>
  );
}

// The phone face: below this width the composer (and plan review's section ⋯
// menu) docks as a bottom sheet instead of a floating popover. Kept in
// lockstep with the CSS `max-width: 639px` breakpoint that swaps the
// bar/switcher faces (styles.css) — so the whole phone control surface (chips,
// sticky bar, sheets) flips together; a tablet-band gap where the visual face
// is the phone's but a tap opened a desktop popover anchored off-thumb would
// otherwise sit at 560–639px.
export const SHEET_VIEWPORT = 640;

const COMPOSER_WIDTH = 380;
const COMPOSER_GUESS_HEIGHT = 240;

/**
 * The composer's viewport pin for a selection rect, or null for the phone
 * bottom sheet. Centers on the selection, clamped a 12px gutter inside the
 * viewport; opens just below the selection, flipping above when the guessed
 * card height would overflow the fold. The guess only picks below vs above —
 * the rendered card self-corrects its exact pin (the nudge clamp in Composer).
 * Pure (viewport passed in) so it unit-tests without a DOM. Both review
 * surfaces MUST place through this helper — its numbers were tuned together
 * with the phone face and drifted apart once when PR review re-derived them.
 */
export function composerPlacement(
  rect: { top: number; bottom: number; left: number; width: number },
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  if (viewport.width < SHEET_VIEWPORT) {
    // Selection popovers don't fit a phone; the composer becomes a sheet.
    return null;
  }
  const width = Math.min(COMPOSER_WIDTH, viewport.width - 24);
  const x = Math.min(
    Math.max(rect.left + rect.width / 2, width / 2 + 12),
    viewport.width - width / 2 - 12,
  );
  const below = rect.bottom + 12;
  const y =
    below + COMPOSER_GUESS_HEIGHT > viewport.height
      ? Math.max(12, rect.top - COMPOSER_GUESS_HEIGHT - 12)
      : below;
  return { x, y };
}

export interface ComposerState {
  mode: "comment" | "ask";
  /** null = whole-plan comment (plan structure, lint, and anchoring). */
  anchor: Anchor | null;
  /** Viewport point to pin under; null = bottom sheet (whole-plan, phones). */
  at: { x: number; y: number } | null;
}

export function Composer({
  state,
  onClose,
  onStack,
  onSendNow,
  onAsk,
  commentDelivery = "batch",
  options,
}: {
  state: ComposerState;
  onClose: () => void;
  /** Comment → drawer; parent closes the composer. */
  onStack: (body: string) => void;
  /** Per-comment "send now" override; resolves false on failure (stay open). */
  onSendNow: (body: string) => Promise<boolean>;
  /** Question fires instantly; resolves false on failure (stay open). */
  onAsk: (body: string) => Promise<boolean>;
  /** PR review creates the Comment thread immediately; plan review keeps drawer batching. */
  commentDelivery?: "batch" | "immediate";
  /** Product-specific controls that belong between the draft and its send action. */
  options?: ReactNode;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);

  // The pinned card's height is content-driven (the quote block grows with
  // the selection), so no caller-side estimate can keep it on screen. Measure
  // the rendered card and clamp the pin inside the viewport; `nudge` is the
  // correction applied on top of the caller's point.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [nudge, setNudge] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const pinX = state.at?.x;
  const pinY = state.at?.y;
  useLayoutEffect(() => {
    setNudge({ x: 0, y: 0 });
    if (pinX === undefined || pinY === undefined) return;
    const card = cardRef.current;
    const win = card?.ownerDocument.defaultView;
    if (!card || !win) return;
    const rect = card.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // non-layout test DOM
    const halfWidth = rect.width / 2;
    const x = Math.max(halfWidth + 12, Math.min(win.innerWidth - halfWidth - 12, pinX));
    const y = Math.max(12, Math.min(win.innerHeight - rect.height - 12, pinY));
    if (x !== pinX || y !== pinY) setNudge({ x: x - pinX, y: y - pinY });
  }, [pinX, pinY]);

  const ready = body.trim() !== "" && !busy;
  const fire = (action: (body: string) => Promise<boolean>) => {
    if (!ready) return;
    setBusy(true);
    setFailed(false);
    void action(body).then((ok) => {
      // On success the parent closes this composer; only failure needs UI.
      setBusy(false);
      if (!ok) setFailed(true);
    });
  };
  const primary = () => {
    if (!ready) return;
    if (state.mode === "comment" && commentDelivery === "batch") onStack(body);
    else if (state.mode === "comment") fire(onSendNow);
    else fire(onAsk);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      primary();
    }
    if (event.key === "Escape") onClose();
  };

  const sheet = state.at === null;
  const style = sheet
    ? undefined
    : ({
        "--cx": `${(state.at?.x ?? 0) + nudge.x}px`,
        "--cy": `${(state.at?.y ?? 0) + nudge.y}px`,
      } as CSSProperties);
  return (
    <div
      ref={cardRef}
      className={sheet ? "composer composer-sheet" : "composer"}
      style={style}
      role="dialog"
      aria-label={state.mode === "comment" ? "comment composer" : "question composer"}
    >
      <div className="composer-head">
        <span className="composer-mode">{state.mode}</span>
        <span className="composer-target">→ {anchorLabel(state.anchor)}</span>
        <button type="button" className="composer-close" onClick={onClose}>
          esc
        </button>
      </div>
      {state.anchor?.exact !== undefined && (
        <blockquote className="composer-quote">{state.anchor.exact}</blockquote>
      )}
      <textarea
        ref={inputRef}
        className="composer-input"
        placeholder={state.mode === "comment" ? "what should change…" : "what do you want to know…"}
        value={body}
        onInput={(event) => setBody(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      {options}
      <div className="composer-foot">
        <span className={failed ? "composer-hint composer-failed" : "composer-hint"}>
          {failed ? "send failed — is otacond up?" : "⌘⏎ send"}
        </span>
        <div className="composer-actions">
          {state.mode === "comment" ? (
            commentDelivery === "immediate" ? (
              <button type="button" className="btn btn-primary" disabled={!ready} onClick={primary}>
                {busy ? "Sending…" : "Comment"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!ready}
                  onClick={() => fire(onSendNow)}
                >
                  {busy ? "sending…" : "send now"}
                </button>
                <button type="button" className="btn btn-primary" disabled={!ready} onClick={primary}>
                  add to drawer
                </button>
              </>
            )
          ) : (
            <button type="button" className="btn btn-primary" disabled={!ready} onClick={primary}>
              {busy ? "asking…" : "ask now"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
