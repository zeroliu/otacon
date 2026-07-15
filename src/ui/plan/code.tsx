// Visuals v1 (plan structure, lint, and anchoring): syntax-highlighted fences, client-rendered
// mermaid diagrams, and before/after pairs. highlight.js's common-language
// build rides in the review chunk (the whole plan renderer is lazy-loaded);
// mermaid is far heavier, so it stays its own dynamic chunk fetched on the
// first diagram. Both outputs are generated markup: hljs escapes its input,
// and mermaid SVG additionally passes through DOMPurify's SVG profile.

import createDOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { useEffect, useMemo, useState } from "react";
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
  // Memoized: the dossier re-renders on every SSE frame (queue ticks
  // included), and re-highlighting every fence each time is pure waste —
  // parsePlan is memoized upstream, so fence identity is stable per revision.
  // The memo also keeps the {__html} wrapper's identity stable: a fresh
  // wrapper makes react-dom rewrite innerHTML, collapsing any selection
  // being anchored inside the fence (see markdown.tsx).
  const markup = useMemo(() => {
    const language = fence.lang !== "" && hljs.getLanguage(fence.lang) ? fence.lang : undefined;
    return {
      __html: language
        ? hljs.highlight(fence.code, { language, ignoreIllegals: true }).value
        : escapeHtml(fence.code),
    };
  }, [fence]);
  return (
    <figure className={className ? `fence ${className}` : "fence"}>
      <figcaption className="fence-head">{label ?? (fence.lang || "text")}</figcaption>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={markup} />
      </pre>
    </figure>
  );
}

/** Before/after pair, side-by-side on desktop, stacked on phones (plan structure, lint, and anchoring). */
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

function sanitizeSvg(source: string): string {
  const purify = typeof (createDOMPurify as { sanitize?: unknown }).sanitize === "function"
    ? createDOMPurify
    : createDOMPurify(window);
  return purify.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: true } });
}

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
  }).catch((error: unknown) => {
    // Don't cache a rejected promise: a transient chunk-fetch failure
    // (offline blip) would otherwise poison every future diagram until a
    // full reload. The caller still sees this rejection and falls back.
    mermaidLoad = undefined;
    throw error;
  });
  return mermaidLoad;
}

let renderSeq = 0;

export function MermaidFigure({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);
  // Stable {__html} wrapper — same selection-collapse mechanism as CodeFence.
  const markup = useMemo(() => (svg === undefined ? undefined : { __html: svg }), [svg]);

  useEffect(() => {
    let live = true;
    // Reset on a code change: Blocks keys by index, so a live revision bump
    // reuses this instance — without the reset the old revision's diagram
    // (or a stale "failed" label over fixed source) would show while the new
    // render is in flight.
    setSvg(undefined);
    setFailed(false);
    const id = `otacon-mmd-${++renderSeq}`;
    loadMermaid()
      .then((mermaid) => mermaid.render(id, code))
      .then(({ svg: rendered }) => {
        if (live) {
          setSvg(sanitizeSvg(rendered));
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
      {markup === undefined ? (
        <div className="diagram-body diagram-pending">rendering diagram…</div>
      ) : (
        <div className="diagram-body" dangerouslySetInnerHTML={markup} />
      )}
    </figure>
  );
}
