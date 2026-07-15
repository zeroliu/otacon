import type { ReactNode } from "react";
import { useMemo } from "react";

import { parseReviewReport, stripReviewCodeGroupMetadata } from "../../shared/review-report";
import type { ReviewCodeGroup, ReviewCodeGroupKind, ReviewReportSection } from "../../shared/review-report";
import { CodeFence, MermaidFigure, PairFences } from "../plan/code";
import { Markdown } from "../plan/markdown";
import type { Block } from "../plan/parse";
import { parsePlan } from "../plan/parse";

function Blocks({ source }: { source: string }) {
  const blocks = useMemo<Block[]>(() => parsePlan(source).preamble, [source]);
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "markdown") return <Markdown key={index} source={block.text} />;
        if (block.kind === "pair") return <PairFences key={index} pair={block} />;
        if (block.lang === "mermaid") return <MermaidFigure key={index} code={block.code} />;
        return <CodeFence key={index} fence={block} />;
      })}
    </>
  );
}

function CodeGroup({ group, index }: { group: ReviewCodeGroup; index: number }) {
  return (
    <article id={group.id} className="pr-code-group" data-code-kind={group.kind} data-source-lines={`${group.startLine}-${group.endLine}`}>
      <header>
        <span>{String(index + 1).padStart(2, "0")}</span>
        <div>
          <h4>{group.title}</h4>
          {group.purpose !== undefined && <p>{group.purpose}</p>}
        </div>
      </header>
      {group.changedBehavior !== undefined && (
        <p className="pr-changed-behavior">
          <strong>Changed behavior:</strong> {group.changedBehavior}
        </p>
      )}
      <Blocks source={stripReviewCodeGroupMetadata(group.markdown)} />
      <div className="pr-surfaces" aria-label={`${group.title} code surfaces`}>
        {group.surfaces.map((surface) => (
          <div key={`${surface.file}#${surface.symbol}`}>
            <code>{surface.file}<b>#{surface.symbol}</b></code>
          </div>
        ))}
      </div>
    </article>
  );
}

const LAYERS: Array<{ kind: ReviewCodeGroupKind; id: string; kicker: string; title: string }> = [
  { kind: "interface", id: "code-interfaces", kicker: "Contract first", title: "Interface changes" },
  { kind: "integration", id: "code-integration", kicker: "Runtime wiring", title: "Integration path" },
  { kind: "implementation", id: "code-walkthrough", kicker: "Inside the change", title: "Implementation walkthrough" },
];

function sectionLead(section: ReviewReportSection, firstGroup?: ReviewCodeGroup): string {
  if (firstGroup === undefined) return section.markdown;
  const lines = section.markdown.split("\n");
  const relativeGroupLine = firstGroup.startLine - section.startLine - 1;
  return lines.slice(0, Math.max(0, relativeGroupLine)).join("\n").replace(/^\n+|\n+$/g, "");
}

export function ReportView({ markdown, quiz }: { markdown: string; quiz?: ReactNode }) {
  const parsed = useMemo(() => parseReviewReport(markdown), [markdown]);
  const background = parsed.sections.find((section) => section.name === "Background");
  const intuition = parsed.sections.find((section) => section.name === "Intuition");
  const code = parsed.sections.find((section) => section.name === "Code");
  const quizSection = parsed.sections.find((section) => section.name === "Quiz");
  return (
    <>
      {background !== undefined && (
        <section id="background" className="pr-report-section" data-source-lines={`${background.startLine}-${background.endLine}`}>
          <span className="pr-section-number">01</span><h2>Background</h2>
          <Blocks source={background.markdown} />
        </section>
      )}
      {intuition !== undefined && (
        <section id="intuition" className="pr-report-section" data-source-lines={`${intuition.startLine}-${intuition.endLine}`}>
          <span className="pr-section-number">02</span><h2>Intuition</h2>
          <Blocks source={intuition.markdown} />
        </section>
      )}
      {code !== undefined && (
        <section id="code" className="pr-report-section" data-source-lines={`${code.startLine}-${code.endLine}`}>
          <span className="pr-section-number">03</span><h2>Code</h2>
          <div className="pr-section-lead"><Blocks source={sectionLead(code, parsed.codeGroups[0])} /></div>
          {LAYERS.map((layer) => {
            const groups = parsed.codeGroups.filter((group) => group.kind === layer.kind);
            if (groups.length === 0) return null;
            return (
              <section key={layer.kind} id={layer.id} className="pr-code-layer" aria-labelledby={`${layer.id}-title`}>
                <span className="pr-code-layer-kicker">{layer.kicker}</span>
                <h3 id={`${layer.id}-title`}>{layer.title}</h3>
                {groups.map((group, index) => <CodeGroup key={group.id} group={group} index={index} />)}
              </section>
            );
          })}
          {parsed.codeGroups.some((group) => group.kind === undefined) && (
            <section id="code-recovered" className="pr-code-layer" aria-labelledby="code-recovered-title">
              <span className="pr-code-layer-kicker">Recovered content</span>
              <h3 id="code-recovered-title">Unrecognized Code groups</h3>
              {parsed.codeGroups.filter((group) => group.kind === undefined).map((group, index) => (
                <CodeGroup key={group.id} group={group} index={index} />
              ))}
            </section>
          )}
        </section>
      )}
      {quizSection !== undefined && (
        <section id="quiz" className="pr-report-section pr-quiz-section" data-source-lines={`${quizSection.startLine}-${quizSection.endLine}`}>
          <span className="pr-section-number">04</span><h2>Quiz</h2>
          <Blocks source={quizSection.markdown} />
          {quiz}
        </section>
      )}
      {parsed.errors.length > 0 && (
        <aside className="pr-report-recovery" role="note">
          Displaying the recoverable parts of this report; its stored schema is incomplete.
        </aside>
      )}
    </>
  );
}
