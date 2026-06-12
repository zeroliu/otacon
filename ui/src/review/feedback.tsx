// The selection instruments (DESIGN.md §10): a floating toolbar over selected
// plan text — Comment stacks into the drawer, Ask fires instantly — and the
// anchored composer both actions open. The toolbar is the UI's one inverted
// surface (paper-on-ink): it floats above the page, so it reads as the codec
// cursor, not part of the document. Both are fixed-position and re-derive
// their spot from the live selection, so scrolling never strands them.

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type { Anchor } from "../api";
import type { CapturedSelection } from "./anchor";
import { captureSelection } from "./anchor";

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
    const update = () => {
      const el = ref.current;
      setSelection(el ? captureSelection(el) : null);
    };
    update();
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true); // reposition, don't strand
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [ref, enabled]);
  return selection;
}

export function SelectionToolbar({
  selection,
  onComment,
  onAsk,
}: {
  selection: CapturedSelection;
  onComment: () => void;
  onAsk: () => void;
}) {
  const { rect, anchor } = selection;
  const below = rect.top < 72; // no room above the selection: flip under it
  const x = Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140);
  const y = below ? rect.bottom + 10 : rect.top - 10;
  return (
    <div
      className={below ? "sel-toolbar sel-below" : "sel-toolbar"}
      style={{ left: x, top: y }}
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
  /** null = whole-plan comment (DESIGN.md §4). */
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
        <span className="composer-target">
          → {state.anchor ? `#${state.anchor.section}` : "whole plan"}
        </span>
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
