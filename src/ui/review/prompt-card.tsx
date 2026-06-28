// The Prompt card (review UI): the user's verbatim request echoed back at the
// very top of the review column. It points the opposite way from the agent's
// transmission cards (the grill card, the revision banner): those carry the
// agent's words *to* the reviewer with an accent top-border; this carries the
// reviewer's own words *back*, so it wears a quieter neutral treatment with a
// left accent rule (a quote motif) instead. Collapsed by default — the request
// is context the reviewer already knows, so it stays a one-line preview until
// asked for — and absent entirely when no prompt was captured (`--prompt` is
// optional), so an unprompted session shows no empty card.

import { useState } from "react";

export function PromptCard({ prompt }: { prompt?: string }) {
  const [open, setOpen] = useState(false);

  // Hidden when absent: an empty or whitespace-only prompt renders nothing, no
  // label and no chrome. Trim once and reuse so the preview is never blank.
  const text = prompt?.trim();
  if (!text) return null;

  return (
    <section className="prompt-card" aria-label="your request">
      <button
        type="button"
        className="prompt-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="prompt-glyph" aria-hidden="true">
          ❝
        </span>
        <span className="prompt-word">prompt</span>
        {!open && <span className="prompt-preview">{text}</span>}
        <span className="prompt-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && <p className="prompt-body">{text}</p>}
    </section>
  );
}
