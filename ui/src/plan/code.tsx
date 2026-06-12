// Visuals v1 (DESIGN.md §4): syntax-highlighted fences, client-rendered
// mermaid diagrams, and before/after pairs. highlight.js's common-language
// build rides in the review chunk (the whole plan renderer is lazy-loaded);
// mermaid is far heavier, so it stays its own dynamic chunk fetched on the
// first diagram. Both outputs are generated markup: hljs escapes its input,
// and mermaid SVG additionally passes through DOMPurify's SVG profile.

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { useEffect, useState } from "react";
import type { FenceBlock, PairBlock } from "./parse";

function escapeHtml(code: string): string {
  return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function CodeFence({
  fence,
  label,
  className,
}: {
  fence: FenceBlock;
  label?: string;
  className?: string;
}) {
  const language = fence.lang !== "" && hljs.getLanguage(fence.lang) ? fence.lang : undefined;
  const html = language
    ? hljs.highlight(fence.code, { language, ignoreIllegals: true }).value
    : escapeHtml(fence.code);
  return (
    <figure className={className ? `fence ${className}` : "fence"}>
      <figcaption className="fence-head">{label ?? (fence.lang || "text")}</figcaption>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </figure>
  );
}

/** Before/after pair, side-by-side on desktop, stacked on phones (DESIGN.md §4). */
export function PairFences({ pair }: { pair: PairBlock }) {
  const tag = (fence: FenceBlock, word: string) =>
    fence.lang === "" ? word : `${word} · ${fence.lang}`;
  return (
    <div className="pair">
      <CodeFence fence={pair.before} label={tag(pair.before, "before")} className="pair-before" />
      <CodeFence fence={pair.after} label={tag(pair.after, "after")} className="pair-after" />
    </div>
  );
}

type MermaidApi = (typeof import("mermaid"))["default"];
let mermaidLoad: Promise<MermaidApi> | undefined;

/** Lazy singleton: the ~MB mermaid chunk is fetched once, on the first diagram. */
function loadMermaid(): Promise<MermaidApi> {
  mermaidLoad ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // Diagram text is plan content: strict mode keeps labels inert, and
      // htmlLabels:false keeps everything in plain SVG text nodes so the
      // DOMPurify SVG pass below (which strips foreignObject) cannot break
      // label rendering. The TOP-LEVEL htmlLabels is the one that counts:
      // mermaid 11's unified renderer ignores flowchart.htmlLabels for node
      // labels (verified empirically — flowchart-scoped alone leaves labels
      // in foreignObjects, which sanitization then removes).
      securityLevel: "strict",
      htmlLabels: false,
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "neutral",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      flowchart: { htmlLabels: false },
    });
    return mermaid;
  });
  return mermaidLoad;
}

let renderSeq = 0;

export function MermaidFigure({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const id = `otacon-mmd-${++renderSeq}`;
    loadMermaid()
      .then((mermaid) => mermaid.render(id, code))
      .then(({ svg: rendered }) => {
        if (live) {
          setSvg(DOMPurify.sanitize(rendered, { USE_PROFILES: { svg: true, svgFilters: true } }));
          setFailed(false);
        }
      })
      .catch(() => {
        document.getElementById(`d${id}`)?.remove(); // mermaid's leaked scratch node
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [code]);

  // A diagram that will not render is still plan content: show the source.
  if (failed) {
    return (
      <CodeFence
        fence={{ kind: "fence", lang: "", tags: [], code }}
        label="mermaid · failed to render"
      />
    );
  }
  return (
    <figure className="fence diagram">
      <figcaption className="fence-head">diagram</figcaption>
      {svg === undefined ? (
        <div className="diagram-body diagram-pending">rendering diagram…</div>
      ) : (
        <div className="diagram-body" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </figure>
  );
}
