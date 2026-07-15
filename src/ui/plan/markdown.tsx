// Sanitized markdown for plan prose. Plans are semi-trusted (the user's own
// agent wrote them), but everything still passes through DOMPurify before it
// touches the DOM — defense in depth against raw-HTML injection via plan
// content (review UI).

import createDOMPurify from "dompurify";
import { memo, useMemo } from "react";
// marked, configured with the plan's markdown-native visuals (decision
// matrices) and inline tokens (callout badges, scope pills). The whole
// transform pipeline lives in marked-setup so it stays DOM-free and testable;
// here we only parse + sanitize.
import { marked } from "./marked-setup";

// The {__html} wrapper identity is what matters here: react-dom re-assigns
// innerHTML whenever the wrapper object is new, which rebuilds the text nodes
// and collapses any user selection inside them — the review loop anchors
// selections to exactly these nodes (src/ui/review/anchor.ts). The useMemo
// keeps the wrapper stable across re-renders at the mechanism level; memo on
// top skips the re-render entirely.
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  // dompurify's Node import is a window-bound factory; another renderer may
  // import it before a test/browser window exists. Bind at render time when
  // needed so lazy PR-report reuse is independent of module import order.
  const purify = typeof (createDOMPurify as { sanitize?: unknown }).sanitize === "function"
    ? createDOMPurify
    : createDOMPurify(window);
  const markup = useMemo(
    () => ({
      __html: purify.sanitize(marked.parse(source, { async: false }), {
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
    [purify, source],
  );
  // eslint-disable-next-line react/no-danger — sanitized above
  return <div className="md" dangerouslySetInnerHTML={markup} />;
});
