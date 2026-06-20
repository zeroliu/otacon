// The selection instruments (review UI): a docked Comment/Ask bar that
// appears when plan text is selected — Comment stacks into the drawer, Ask
// fires instantly — and the anchored composer both actions open. The bar is
// pinned to a fixed bottom edge (thumb range on phone, a slim strip on
// desktop), not floating over the selection, so it never lands in the zone
// where the OS draws its own un-suppressable selection/dictionary popover
// (DECISIONS.md: coexist by placement). It keeps the inverted paper-on-ink
// treatment — the UI's one inverted surface — so it still reads as the codec
// cursor, an instrument over the document rather than part of it. The composer
// pins where it opened — its anchor is already captured, so the live selection
// no longer matters once it is open.

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
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
}: {
  selection: CapturedSelection;
  onComment: () => void;
  onAsk: () => void;
}) {
  // Docked, so the live rect no longer drives placement — only the anchor's
  // section slug is shown; CSS pins the bar to the bottom edge (styles.css).
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
}: {
  state: ComposerState;
  onClose: () => void;
  /** Comment → drawer; parent closes the composer. */
  onStack: (body: string) => void;
  /** Per-comment "send now" override; resolves false on failure (stay open). */
  onSendNow: (body: string) => Promise<boolean>;
  /** Question fires instantly; resolves false on failure (stay open). */
  onAsk: (body: string) => Promise<boolean>;
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
    if (state.mode === "comment") onStack(body);
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
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-foot">
        <span className={failed ? "composer-hint composer-failed" : "composer-hint"}>
          {failed ? "send failed — is otacond up?" : "⌘⏎ send"}
        </span>
        <div className="composer-actions">
          {state.mode === "comment" ? (
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
