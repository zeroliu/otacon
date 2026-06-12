// Sanitized markdown for plan prose. Plans are semi-trusted (the user's own
// agent wrote them), but everything still passes through DOMPurify before it
// touches the DOM — defense in depth against raw-HTML injection via plan
// content (DESIGN.md §10).

import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

marked.use({ gfm: true });

export function Markdown({ source }: { source: string }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(source, { async: false }), {
        USE_PROFILES: { html: true },
      }),
    [source],
  );
  // eslint-disable-next-line react/no-danger — sanitized above
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
