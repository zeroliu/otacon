// Sanitized markdown for plan prose. Plans are semi-trusted (the user's own
// agent wrote them), but everything still passes through DOMPurify before it
// touches the DOM — defense in depth against raw-HTML injection via plan
// content (DESIGN.md §10).

import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useMemo } from "react";

marked.use({ gfm: true });

// memo matters here beyond performance: React re-applies
// dangerouslySetInnerHTML whenever the component re-renders (the {__html}
// wrapper object is new each time), which rebuilds the text nodes and
// collapses any user selection inside them — the review loop anchors
// selections to exactly these nodes (ui/src/review/anchor.ts).
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(source, { async: false }), {
        USE_PROFILES: { html: true },
        // The html profile still permits <form>/<style>/inline style — plan
        // prose never needs them, and they are the remaining phishing-form
        // and CSS-exfiltration surfaces. (The mermaid SVG pass keeps <style>:
        // mermaid inlines its theme CSS there, and strict mode sanitizes
        // diagram-author styles.)
        FORBID_TAGS: ["form", "style"],
        FORBID_ATTR: ["style"],
      }),
    [source],
  );
  // eslint-disable-next-line react/no-danger — sanitized above
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});
