// The section ⋯ menu (review UI): coarse anchoring by design — every
// section/phase header carries the affordance, and on a phone it is the
// primary path because text selection is miserable there. Two verbs only:
// "comment on section" stacks into the drawer, "ask about section" fires
// instantly — both open the existing composer with a section-only anchor
// ({section}, no exact quote). On phones it docks as a bottom sheet in thumb
// range; on desktop it drops as a popover under the ⋯ button it came from.

import { useEffect, useRef } from "react";

export interface SectionMenuState {
  /** The slug id of the section/phase the ⋯ belongs to. */
  id: string;
  /** Viewport point to drop under (the ⋯ button); null = bottom sheet (phones). */
  at: { x: number; y: number } | null;
}

export function SectionMenu({
  state,
  onComment,
  onAsk,
  onClose,
}: {
  state: SectionMenuState;
  onComment: () => void;
  onAsk: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { at } = state;
  const sheet = at === null;
  const style =
    at === null
      ? undefined
      : {
          // The ⋯ sits at the line's end: hang the menu from its right edge,
          // clamped inside the viewport.
          left: Math.min(at.x, window.innerWidth - 12),
          top: at.y + 8,
        };
  return (
    <div
      className="sec-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={menuRef}
        className={sheet ? "sec-sheet" : "sec-pop"}
        style={style}
        role="menu"
        aria-label={`actions for #${state.id}`}
      >
        <div className="sec-head">
          <span className="sec-slug">#{state.id}</span>
          {sheet && (
            <button type="button" className="composer-close" onClick={onClose}>
              close
            </button>
          )}
        </div>
        <button type="button" className="sec-item" role="menuitem" onClick={onComment}>
          <span className="sec-glyph" aria-hidden="true">
            ✎
          </span>
          comment on section
          <span className="sec-hint">→ drawer</span>
        </button>
        <button type="button" className="sec-item" role="menuitem" onClick={onAsk}>
          <span className="sec-glyph" aria-hidden="true">
            ?
          </span>
          ask about section
          <span className="sec-hint">instant</span>
        </button>
      </div>
    </div>
  );
}
