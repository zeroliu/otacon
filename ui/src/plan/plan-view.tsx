// The plan dossier (DESIGN.md §10): schema-aware rendering of a stored
// revision. Sections keep one continuous reading column; phases are the one
// carded element; Details collapse behind a size badge so skipping them is a
// conscious choice. Section/phase DOM ids are the anchoring contract M2c
// comments attach to (DESIGN.md §4). Default export — session-screen lazy
// loads this chunk so the index bundle stays light.

import type { CSSProperties } from "react";
import { useMemo } from "react";
import type { LintIssue } from "../../../src/shared/types";
import { CodeFence, MermaidFigure, PairFences } from "./code";
import { Markdown } from "./markdown";
import type { Block, PlanDetails, PlanPhase, PlanSection } from "./parse";
import { parsePlan } from "./parse";

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "markdown") return <Markdown key={i} source={block.text} />;
        if (block.kind === "pair") return <PairFences key={i} pair={block} />;
        if (block.lang === "mermaid") return <MermaidFigure key={i} code={block.code} />;
        return <CodeFence key={i} fence={block} />;
      })}
    </>
  );
}

function sizeBadge(details: PlanDetails): string {
  const parts = [`${details.lineCount} ${details.lineCount === 1 ? "line" : "lines"}`];
  if (details.diagrams > 0) {
    parts.push(`${details.diagrams} ${details.diagrams === 1 ? "diagram" : "diagrams"}`);
  }
  if (details.codeBlocks > 0) {
    parts.push(`${details.codeBlocks} ${details.codeBlocks === 1 ? "code block" : "code blocks"}`);
  }
  return parts.join(" · ");
}

function DetailsBlock({ details, l6 }: { details: PlanDetails; l6?: LintIssue }) {
  return (
    <details className="details">
      <summary className="details-summary">
        <span className="details-caret" aria-hidden="true">
          ▸
        </span>
        <span className="details-word">Details</span>
        <span className="details-size">{sizeBadge(details)}</span>
        {l6 && (
          <span className="l6-badge" title={l6.message}>
            ⚠ over soft cap{l6.budget !== undefined ? ` ${l6.budget}` : ""}
          </span>
        )}
      </summary>
      <div className="details-body">
        <Blocks blocks={details.blocks} />
      </div>
    </details>
  );
}

function PhaseCard({ phase, warnings }: { phase: PlanPhase; warnings: LintIssue[] }) {
  const l6 = warnings.find((w) => w.rule === "L6" && w.section === phase.id);
  return (
    <section id={phase.id} className="phase">
      <header className="phase-head">
        <span className="phase-n" aria-hidden="true">
          {String(phase.n).padStart(2, "0")}
        </span>
        <h3 className="phase-name">{phase.name}</h3>
        <span className="anchor-slug">#{phase.id}</span>
      </header>
      {phase.body.length > 0 && <Blocks blocks={phase.body} />}
      {phase.fields.length > 0 && (
        <dl className="fields">
          {phase.fields.map((field) => (
            <div key={field.key} className={`field field-${field.key}`}>
              <dt className="field-label">{field.label}</dt>
              <dd className="field-value">
                <Blocks blocks={field.blocks} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {phase.details && <DetailsBlock details={phase.details} l6={l6} />}
    </section>
  );
}

function SectionBlock({
  section,
  index,
  warnings,
}: {
  section: PlanSection;
  index: number;
  warnings: LintIssue[];
}) {
  return (
    <section
      id={section.id}
      className="plan-section"
      style={{ "--si": index } as CSSProperties}
    >
      <header className="section-rail">
        <h2 className="section-title">{section.title}</h2>
        <span className="rail-line" aria-hidden="true" />
        <span className="anchor-slug">#{section.id}</span>
      </header>
      {section.blocks.length > 0 && <Blocks blocks={section.blocks} />}
      {section.phases.map((phase) => (
        <PhaseCard key={phase.id} phase={phase} warnings={warnings} />
      ))}
    </section>
  );
}

export default function PlanView({
  markdown,
  warnings,
}: {
  markdown: string;
  warnings: LintIssue[];
}) {
  const doc = useMemo(() => parsePlan(markdown), [markdown]);
  return (
    <article className="plan">
      {doc.preamble.length > 0 && (
        <div className="plan-preamble">
          <Blocks blocks={doc.preamble} />
        </div>
      )}
      {doc.sections.map((section, index) => (
        <SectionBlock
          key={`${section.id}-${index}`}
          section={section}
          index={index}
          warnings={warnings}
        />
      ))}
    </article>
  );
}
