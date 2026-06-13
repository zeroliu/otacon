// Sanitized markdown for plan prose. Plans are semi-trusted (the user's own
// agent wrote them), but everything still passes through DOMPurify before it
// touches the DOM — defense in depth against raw-HTML injection via plan
// content (DESIGN.md §10).

import DOMPurify from "dompurify";
import { memo, useMemo } from "react";
// marked, configured with the plan's markdown-native visuals (callouts,
// decision matrices). The whole transform pipeline lives in marked-setup so it
// stays DOM-free and testable; here we only parse + sanitize.
import { marked } from "./marked-setup";

// The {__html} wrapper identity is what matters here: react-dom re-assigns
// innerHTML whenever the wrapper object is new, which rebuilds the text nodes
// and collapses any user selection inside them — the review loop anchors
// selections to exactly these nodes (src/ui/review/anchor.ts). The useMemo
// keeps the wrapper stable across re-renders at the mechanism level; memo on
// top skips the re-render entirely.
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const markup = useMemo(
    () => ({
      __html: DOMPurify.sanitize(marked.parse(source, { async: false }), {
        USE_PROFILES: { html: true },
        // The html profile still permits <form>/<style>/inline style — plan
        // prose never needs them, and they are the remaining phishing-form
        // and CSS-exfiltration surfaces. (The mermaid SVG pass keeps <style>:
        // mermaid inlines its theme CSS there, and strict mode sanitizes
        // diagram-author styles.)
        FORBID_TAGS: ["form", "style"],
        FORBID_ATTR: ["style"],
      }),
    }),
    [source],
  );
  // eslint-disable-next-line react/no-danger — sanitized above
  return <div className="md" dangerouslySetInnerHTML={markup} />;
});
