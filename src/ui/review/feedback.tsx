// The selection instruments (review UI): a docked Comment/Ask bar that
// appears when review text is selected, plus the anchored composer both actions
// open. Plan review docks the bar at a fixed bottom edge so it never competes
// with the OS selection/dictionary popover; PR review reuses the instrument in
// a contextual placement next to selected prose or code. Comment delivery is
// likewise configurable: the plan can stack a draft into its drawer, while a
// PR creates a conversation thread immediately. The composer pins where it
// opened — its anchor is already captured, so the live selection no longer
// matters once it is open.

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import { useEffect, useRef, useState } from "react";
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
  placement = "docked",
}: {
  selection: CapturedSelection;
  onComment: () => void;
  onAsk: () => void;
  /** Plan review stays docked; PR review places the same actions beside prose/code selection. */
  placement?: "docked" | "contextual";
}) {
  const { anchor, rect } = selection;
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const contextual = placement === "contextual";
  const above = contextual && rect.bottom + 52 > viewportHeight;
  // The full slug + two actions measure about 280px; keep half plus a 12px
  // gutter inside the viewport, while still degrading safely below 304px.
  const contextualEdge = Math.min(152, viewportWidth / 2);
  const x = Math.max(
    contextualEdge,
    Math.min(viewportWidth - contextualEdge, rect.left + rect.width / 2),
  );
  const y = above ? rect.top - 8 : rect.bottom + 8;
  const style = contextual
    ? ({ "--sx": `${x}px`, "--sy": `${y}px` } as CSSProperties)
    : undefined;
  return (
    <div
      className={[
        "sel-bar",
        contextual && "sel-bar-contextual",
        above && "is-above",
      ].filter(Boolean).join(" ")}
      style={style}
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
    : ({ "--cx": `${state.at?.x}px`, "--cy": `${state.at?.y}px` } as CSSProperties);
  return (
    <div
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
