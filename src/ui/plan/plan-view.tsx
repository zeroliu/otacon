// The plan dossier (review UI): schema-aware rendering of a stored
// revision. Sections keep one continuous reading column; phases are the one
// carded element; Details collapse behind a size badge so skipping them is a
// conscious choice. Section/phase DOM ids are the anchoring contract M2c
// comments attach to (plan structure, lint, and anchoring). Default export — session-screen lazy
// loads this chunk so the index bundle stays light.

import type { CSSProperties } from "react";
import { memo, useLayoutEffect, useMemo } from "react";
import { parseGwt } from "../../shared/gwt";
import type { Ledger, LintIssue } from "../../shared/types";
import { CITATION_RE } from "../../shared/types";
import { CodeFence, MermaidFigure, PairFences } from "./code";
import { Markdown } from "./markdown";
import type { Block, PlanDetails, PlanPhase, PlanSection } from "./parse";
import { parsePlan } from "./parse";
import { ScenarioCards } from "./scenario-card";

/**
 * Verify-before-merge context for a phase's Verification blocks (Phase 2): the
 * phase number, the ledger keyed by it, and `base` — the flat scenario index
 * this field's first gwt scenario occupies within the phase. `base` is non-zero
 * only when a phase has more than one Verification field, so the per-phase flat
 * index keeps accumulating across them, exactly as the daemon flattens every
 * Verification gwt block of a phase into one 0-based list (ledger.ts). Carried
 * only into Verification fields so a scenario card can find its attestation;
 * absent everywhere else.
 */
interface GwtContext {
  phase: number;
  base: number;
  ledger?: Ledger;
}

/**
 * The section/phase ⋯ menu affordance (review UI): always available, and
 * the primary anchoring path on a phone, where text selection is miserable.
 * Pure markup — the click is delegated in session-screen (like the q-cite
 * links), so PlanView stays callback-free and its memo survives.
 */
function MenuButton({ id }: { id: string }) {
  return (
    <button type="button" className="sec-menu" data-menu={id} aria-label={`actions for #${id}`} aria-haspopup="menu">
      ⋯
    </button>
  );
}

function Blocks({ blocks, gwt }: { blocks: Block[]; gwt?: GwtContext }) {
  // Running flat scenario index across this field's gwt fences — the daemon's
  // canonical (phase, flat index) key convention (ledger.ts) computed on the UI
  // side so the badge lands on the right scenario when a phase has >1 gwt fence.
  // Seeded from `gwt.base` so a second Verification field continues the phase's
  // flat index rather than restarting at 0 (matching the daemon's flattening).
  let scenarioBase = gwt?.base ?? 0;
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "markdown") return <Markdown key={i} source={block.text} />;
        if (block.kind === "pair") return <PairFences key={i} pair={block} />;
        if (block.lang === "mermaid") return <MermaidFigure key={i} code={block.code} />;
        if (block.lang === "gwt") {
          const base = scenarioBase;
          if (gwt) scenarioBase += parseGwt(block.code).scenarios.length;
          return (
            <ScenarioCards
              key={i}
              fence={block}
              phase={gwt?.phase}
              base={base}
              ledger={gwt?.ledger}
            />
          );
        }
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

function PhaseCard({
  phase,
  warnings,
  changed,
  ledger,
}: {
  phase: PlanPhase;
  warnings: LintIssue[];
  changed: ReadonlySet<string>;
  ledger?: Ledger;
}) {
  const l6 = warnings.find((w) => w.rule === "L6" && w.section === phase.id);
  // gwt scenarios only count under Verification (the daemon's gate convention),
  // so only that field's blocks carry the verify-before-merge context. The
  // daemon flattens *every* Verification gwt block of a phase into one 0-based
  // list (ledger.ts), so when a phase has more than one Verification field the
  // flat index must keep climbing across them — track the running base here.
  let verificationBase = 0;
  return (
    <section id={phase.id} className={changed.has(phase.id) ? "phase unit-changed" : "phase"}>
      <header className="phase-head">
        <span className="phase-n" aria-hidden="true">
          {String(phase.n).padStart(2, "0")}
        </span>
        <h3 className="phase-name">{phase.name}</h3>
        <span className="anchor-slug">#{phase.id}</span>
        <MenuButton id={phase.id} />
      </header>
      {phase.body.length > 0 && <Blocks blocks={phase.body} />}
      {phase.fields.length > 0 && (
        <dl className="fields">
          {phase.fields.map((field, fieldIndex) => {
            let gwt: GwtContext | undefined;
            if (field.key === "verification") {
              gwt = { phase: phase.n, base: verificationBase, ledger };
              // Advance the phase's running flat index past this field's gwt
              // scenarios so a later Verification field keys off the right base.
              for (const block of field.blocks) {
                if (block.kind === "fence" && block.lang === "gwt") {
                  verificationBase += parseGwt(block.code).scenarios.length;
                }
              }
            }
            return (
              // Index in the key: a phase may repeat a field label (e.g. two
              // Verification fields), so field.key alone is not unique.
              <div key={`${field.key}-${fieldIndex}`} className={`field field-${field.key}`}>
                <dt className="field-label">{field.label}</dt>
                <dd className="field-value">
                  <Blocks blocks={field.blocks} gwt={gwt} />
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {phase.details && <DetailsBlock details={phase.details} l6={l6} />}
    </section>
  );
}

// CITATION_RE is the linter's L3 grammar itself (src/shared/types.ts): the
// q ids are \d+-only capture groups, so the injected markup carries no
// attacker-controlled text — and the whole render still passes DOMPurify.

/**
 * Decision traceability chrome (plan structure, lint, and anchoring, interview questions): `← q7` citations become
 * deep-links into the Interview panel (the click is delegated in
 * session-screen, so this stays a pure text transform and PlanView's memo
 * survives), and `[assumed]` becomes the visible "veto me" tag.
 *
 * Runs on the markdown source before `<Markdown>` parses it, so `[assumed]` is
 * already a `<span>` (brackets gone) by the time the inline-pill extension
 * (marked-setup.ts) scans for bracket tokens — and `assumed` is not in the pill
 * set anyway, so the two transforms never compete for the same token.
 */
export function markDecisionTraces(text: string): string {
  return text
    .replace(CITATION_RE, (_match, ids: string) => {
      const links = ids
        .split(",")
        .map((raw) => raw.trim())
        .map((id) => `<a href="#interview" class="q-cite" data-q="${id}">${id}</a>`)
        .join(", ");
      return `← ${links}`;
    })
    .replace(
      /\[assumed\]/g,
      '<span class="assumed-tag" title="decided without asking — veto me">assumed</span>',
    );
}

function decisionBlocks(blocks: Block[]): Block[] {
  return blocks.map((block) =>
    block.kind === "markdown" ? { ...block, text: markDecisionTraces(block.text) } : block,
  );
}

// The optional review-altitude sections (plan structure, lint, and anchoring): Contract (the interface
// the reviewer signs off) and Impact (blast radius). They render through the
// same SectionBlock as any H2, but carry an `altitude` class so the codec ink
// marks them as the intent/risk layer above the phase detail.
const ALTITUDE_SECTIONS = new Set(["contract", "impact"]);

function SectionBlock({
  section,
  index,
  warnings,
  changed,
  ledger,
}: {
  section: PlanSection;
  index: number;
  warnings: LintIssue[];
  changed: ReadonlySet<string>;
  ledger?: Ledger;
}) {
  const blocks =
    section.id === "decisions" ? decisionBlocks(section.blocks) : section.blocks;
  // Summary leads the document; `plan-lead` lets CSS lift its recommended lead
  // diagram (a mermaid fence, plan structure, lint, and anchoring) as the headline figure — an accent
  // top rule and inked caption (.plan-lead .diagram), no card or fill.
  const className = [
    "plan-section",
    ALTITUDE_SECTIONS.has(section.id) ? "plan-altitude" : "",
    section.id === "summary" ? "plan-lead" : "",
    changed.has(section.id) ? "unit-changed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section
      id={section.id}
      className={className}
      style={{ "--si": index } as CSSProperties}
    >
      <header className="section-rail">
        <h2 className="section-title">{section.title}</h2>
        <span className="rail-line" aria-hidden="true" />
        <span className="anchor-slug">#{section.id}</span>
        <MenuButton id={section.id} />
      </header>
      {blocks.length > 0 && <Blocks blocks={blocks} />}
      {section.phases.map((phase) => (
        <PhaseCard key={phase.id} phase={phase} warnings={warnings} changed={changed} ledger={ledger} />
      ))}
    </section>
  );
}

/**
 * The advisory drift callout (Phase 3): when the build changed source files no
 * phase's `Files:` cited, the reviewer sees them flagged at the top of the
 * dossier as "shipped beyond the plan, review these". Reuses the risk-callout
 * ink (a flat top rule + label, no fill); the copy makes plain it is advisory,
 * not a gate. Degrades to nothing when there is no drift (the caller guards).
 */
function ShippedBeyondPlan({ files }: { files: string[] }) {
  return (
    <div className="callout callout-risk shipped-beyond" role="note">
      <p className="callout-label">▲ Shipped beyond the plan</p>
      <div className="callout-body">
        <p>
          The build changed {files.length} file{files.length === 1 ? "" : "s"} no phase's Files list
          named. Review these (advisory; it never blocked the build):
        </p>
        <ul>
          {files.map((f) => (
            <li key={f}>
              <code>{f}</code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// memo'd so the review loop's state churn (selection tracking, drawer edits)
// never re-renders the dossier: a re-render rewrites the .md innerHTML (see
// markdown.tsx), which would collapse the very selection being anchored. The
// props are a string, the revision payload's stable warnings array, and the
// changed-unit ids *as one space-joined string* (a Set or array prop would
// get a fresh identity per parent render and defeat the memo), so the
// shallow compare only fails when a new revision or diff actually lands.
export default memo(function PlanView({
  markdown,
  warnings,
  changedIds = "",
  verificationLedger,
  shippedBeyondPlan = "",
  onRendered,
}: {
  markdown: string;
  warnings: LintIssue[];
  /** Space-joined slug ids changed vs the diff baseline (gutter markers, review UI). */
  changedIds?: string;
  /** The verify-before-merge attestation for this revision (Phase 2), if the
   *  build is reported done — renders a per-scenario badge. From the revision
   *  payload, so a stable identity for a given revision (the memo survives). */
  verificationLedger?: Ledger;
  /** Newline-joined uncited changed files (Phase 3 drift): when non-empty,
   *  renders an advisory "shipped beyond the plan" callout. A string (not an
   *  array) so a fresh array identity per parent render can't defeat the memo,
   *  mirroring `changedIds`. Empty (the default) renders nothing. */
  shippedBeyondPlan?: string;
  /** Fired after each commit so the persistent thread marks can repaint once
   *  the (memo'd) dossier's DOM lands — a new revision swaps the whole subtree.
   *  Must be a stable identity (a parent useCallback) or it defeats the memo. */
  onRendered?: () => void;
}) {
  const doc = useMemo(() => parsePlan(markdown), [markdown]);
  const changed = useMemo(
    () => new Set(changedIds.split(" ").filter(Boolean)),
    [changedIds],
  );
  const drift = useMemo(
    () => shippedBeyondPlan.split("\n").filter(Boolean),
    [shippedBeyondPlan],
  );
  // Runs after every PlanView commit (mount + each revision/diff prop change) —
  // the memo means that is exactly when planRef's DOM is (re)written.
  useLayoutEffect(() => {
    onRendered?.();
  });
  return (
    <article className="plan">
      {drift.length > 0 && <ShippedBeyondPlan files={drift} />}
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
          changed={changed}
          ledger={verificationLedger}
        />
      ))}
    </article>
  );
});
