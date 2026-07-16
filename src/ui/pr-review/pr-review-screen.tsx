import { CheckCheck, Eye, LoaderCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import wordmarkUrl from "../otacon.svg";
import { CodeFence } from "../plan/code";
import type { CapturedSelection } from "../review/anchor";
import { Composer, SelectionBar, useSelection } from "../review/feedback";
import type { ComposerState } from "../review/feedback";
import { useScrollLock } from "../review/keyboard";
import { isDesktopWidth } from "../session-sheet-state";
import type {
  CodeExcerpt,
  InterfaceChange,
  KnowledgeScope,
  NarrativeBlock,
  ReviewAdapter,
  ReviewNavigationItem,
  ReviewPresentation,
  QuizDefinition,
} from "./model";
import { incompleteQuizCount, LiveReviewAdapter, unresolvedThreadCount } from "./model";
import { ThreadRail } from "./thread-rail";
import { parseReviewReport } from "../../shared/review-report";
import type { ReviewReportRevisionPayload } from "../../shared/review-report";
import type { ReviewQuizPublicState } from "../../shared/review-quiz";
import type { ReviewLiveSession } from "../api";
import { postReviewCodeAction, postReviewDone, postReviewFollowup, postReviewQuizAnswer, postReviewThread, ReviewIncompleteError } from "../api";
import type { ReviewUnresolvedCounts } from "../api";
import type { PublicReviewThread } from "../../shared/types";
import { SessionMenuButton } from "../session-sheet";
import { QuizSection } from "./quiz-section";

const ReportView = lazy(() => import("./report-view").then((module) => ({ default: module.ReportView })));

const NAV_STATE = {
  active: { icon: Eye, className: "review", label: "current" },
  working: { icon: LoaderCircle, className: "working", label: "working" },
  done: { icon: CheckCheck, className: "implemented", label: "done" },
} as const;

const MODAL_FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function trapModalTab(event: KeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== "Tab" || container === null) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE)];
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  const active = container.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function ReviewNavigationRow({ item }: { item: ReviewNavigationItem }) {
  const nav = NAV_STATE[item.state];
  const Icon = nav.icon;
  return (
    <a
      className={["sl-row", "pr-nav-row", item.state === "active" && "current"]
        .filter(Boolean)
        .join(" ")}
      href={item.state === "active" ? "#top" : "#"}
      aria-current={item.state === "active" ? "page" : undefined}
    >
      <span className={`sl-glyph sl-glyph-${nav.className}`} aria-label={nav.label}>
        <Icon aria-hidden />
      </span>
      <span className="sl-text">
        <span className="sl-title">{item.title}</span>
        <span className="sl-where">{item.meta}</span>
      </span>
    </a>
  );
}

function ReviewSidebar({
  state,
  onOpenKnowledge,
  onCollapse,
  collapseRef,
  mobileModal,
}: {
  state: ReviewPresentation;
  onOpenKnowledge?: () => void;
  onCollapse: () => void;
  collapseRef: RefObject<HTMLButtonElement | null>;
  mobileModal: boolean;
}) {
  const [mode, setMode] = useState<"plans" | "reviews">("reviews");
  const [openPrsOpen, setOpenPrsOpen] = useState(true);
  const [activeReviewsOpen, setActiveReviewsOpen] = useState(true);
  const [doneReviewsOpen, setDoneReviewsOpen] = useState(false);
  const items = mode === "reviews" ? state.navigation.reviews : state.navigation.plans;
  const openPrs = mode === "plans" ? items.filter((item) => item.group === "open-pr") : [];
  const ungroupedItems = mode === "plans" ? items.filter((item) => item.group === undefined) : [];
  const activeReviews = mode === "reviews" ? items.filter((item) => item.state !== "done") : [];
  const doneReviews = mode === "reviews" ? items.filter((item) => item.state === "done") : [];
  return (
    <aside
      id="pr-review-navigation"
      className="app-sidebar pr-review-sidebar"
      aria-label="Otacon navigation"
      role={mobileModal ? "dialog" : undefined}
      aria-modal={mobileModal || undefined}
    >
      <div className="app-sidebar-head">
        <a className="app-home" href="#top" aria-label="otacon — review top" title="otacon">
          <span
            className="wordmark"
            aria-hidden="true"
            style={{ "--wordmark": `url(${wordmarkUrl})` } as CSSProperties}
          />
        </a>
        <div className="app-sidebar-tools">
          <a
            className="settings-link"
            href="#knowledge-preview"
            aria-label="settings"
            title="settings"
            onClick={(event) => {
              event.preventDefault();
              onOpenKnowledge?.();
            }}
          >
            ⚙
          </a>
          <button
            ref={collapseRef}
            type="button"
            className="app-collapse"
            aria-label="collapse sidebar"
            title="collapse sidebar"
            onClick={onCollapse}
          >
            «
          </button>
        </div>
      </div>
      <div className="pr-sidebar-switch" role="group" aria-label="session kind">
        <button type="button" aria-pressed={mode === "plans"} onClick={() => setMode("plans")}>Plans</button>
        <button type="button" aria-pressed={mode === "reviews"} onClick={() => setMode("reviews")}>Reviews</button>
      </div>
      <nav className="session-list pr-side-list" aria-label={`${mode === "reviews" ? "review" : "plan"} sessions`}>
        {ungroupedItems.map((item) => <ReviewNavigationRow key={item.id} item={item} />)}
        {activeReviews.length > 0 && (
          <section className="sl-group" aria-label={`Active review sessions (${activeReviews.length})`}>
            <button type="button" className="sl-group-toggle" aria-expanded={activeReviewsOpen} onClick={() => setActiveReviewsOpen((open) => !open)}>
              <span className="sl-group-word">Active</span>
              <span className="sl-group-count">{activeReviews.length}</span>
              <span className="sl-group-caret" aria-hidden="true">{activeReviewsOpen ? "▾" : "▸"}</span>
            </button>
            {activeReviewsOpen && <div className="sl-group-rows">
              {activeReviews.map((item) => <ReviewNavigationRow key={item.id} item={item} />)}
            </div>}
          </section>
        )}
        {doneReviews.length > 0 && (
          <section className="sl-group" aria-label="Done review sessions">
            <button type="button" className="sl-group-toggle" aria-expanded={doneReviewsOpen} onClick={() => setDoneReviewsOpen((open) => !open)}>
              <span className="sl-group-word">Done</span>
              <span className="sl-group-caret" aria-hidden="true">{doneReviewsOpen ? "▾" : "▸"}</span>
            </button>
            {doneReviewsOpen && <div className="sl-group-rows">
              {doneReviews.map((item) => <ReviewNavigationRow key={item.id} item={item} />)}
            </div>}
          </section>
        )}
        {openPrs.length > 0 && (
          <section className="sl-group" aria-label={`Open PR sessions (${openPrs.length})`}>
            <button
              type="button"
              className="sl-group-toggle"
              aria-expanded={openPrsOpen}
              onClick={() => setOpenPrsOpen((open) => !open)}
            >
              <span className="sl-group-word">Open PRs</span>
              <span className="sl-group-count">{openPrs.length}</span>
              <span className="sl-group-caret" aria-hidden="true">{openPrsOpen ? "▾" : "▸"}</span>
            </button>
            {openPrsOpen && (
              <div className="sl-group-rows">
                {openPrs.map((item) => <ReviewNavigationRow key={item.id} item={item} />)}
              </div>
            )}
          </section>
        )}
      </nav>
      {onOpenKnowledge !== undefined && (
        <button type="button" className="pr-knowledge-link" onClick={onOpenKnowledge}>
          Knowledge <span aria-hidden="true">↗</span>
        </button>
      )}
    </aside>
  );
}

function NarrativeBlocks({ blocks }: { blocks: NarrativeBlock[] }) {
  return (
    <div className="pr-narrative">
      {blocks.map((block) => {
        if (block.kind === "sequence") {
          return (
            <figure key={block.id} className="pr-narrative-figure">
              <figcaption>{block.title}</figcaption>
              <ol>
                {block.steps.map((step, index) => (
                  <li key={`${block.id}-step-${index}`}>
                    <strong>{step.label}</strong>
                    <span>{step.detail}</span>
                  </li>
                ))}
              </ol>
              {block.caption !== undefined && <p>{block.caption}</p>}
            </figure>
          );
        }
        return (
          <div key={block.id} className="pr-reading-block">
            {block.eyebrow !== undefined && <span className="pr-reading-eyebrow">{block.eyebrow}</span>}
            {block.title !== undefined && <h3>{block.title}</h3>}
            {block.paragraphs.map((paragraph, index) => <p key={`${block.id}-paragraph-${index}`}>{paragraph}</p>)}
          </div>
        );
      })}
    </div>
  );
}

function ReviewCodeExcerpt({ excerpt }: { excerpt?: CodeExcerpt }) {
  const fence = useMemo(() => excerpt === undefined ? undefined : ({
    kind: "fence" as const,
    lang: excerpt.language,
    tags: [],
    code: excerpt.code,
  }), [excerpt]);
  if (fence === undefined || excerpt === undefined) return null;
  return <CodeFence fence={fence} label={excerpt.label} className="pr-code-excerpt" />;
}

function InterfaceChangeExcerpts({ item }: { item: InterfaceChange }) {
  const excerpts: Array<{
    state: "before" | "after" | "added" | "removed";
    excerpt: CodeExcerpt;
  }> = item.status === "changed"
    ? [{ state: "before", excerpt: item.before }, { state: "after", excerpt: item.after }]
    : item.status === "added"
      ? [{ state: "added", excerpt: item.after }]
      : [{ state: "removed", excerpt: item.before }];
  return (
    <div className="pr-contract-delta" role="group" aria-label={`${item.symbol} ${item.status} contract`}>
      {excerpts.map(({ state: excerptState, excerpt }) => (
        <div key={excerptState} className="pr-contract-excerpt" data-state={excerptState}>
          <span>{excerptState}</span>
          <ReviewCodeExcerpt excerpt={excerpt} />
        </div>
      ))}
    </div>
  );
}

interface ReportTocGroup {
  id: string;
  title: string;
  kind?: "interface" | "integration" | "implementation";
}

const TOC_LAYERS = [
  { kind: "interface", id: "code-interfaces", label: "Interface changes" },
  { kind: "integration", id: "code-integration", label: "Integration path" },
  { kind: "implementation", id: "code-walkthrough", label: "Implementation walkthrough" },
] as const;

function TableOfContents({ groups }: { groups?: ReportTocGroup[] }) {
  return (
    <nav className="pr-toc" aria-label="report contents">
      <span>Read path</span>
      <a href="#background">01 Background</a>
      <a href="#intuition">02 Intuition</a>
      <a href="#code">03 Code</a>
      {TOC_LAYERS.map((layer) => (
        <span className="pr-toc-layer" key={layer.kind}>
          <a className="nested" href={`#${layer.id}`}>{layer.label}</a>
          {groups?.filter((group) => group.kind === layer.kind).map((group) => (
            <a className="nested pr-toc-group" href={`#${group.id}`} key={group.id}>{group.title}</a>
          ))}
        </span>
      ))}
      {groups?.some((group) => group.kind === undefined) && (
        <span className="pr-toc-layer">
          <a className="nested" href="#code-recovered">Recovered groups</a>
          {groups.filter((group) => group.kind === undefined).map((group) => (
            <a className="nested pr-toc-group" href={`#${group.id}`} key={group.id}>{group.title}</a>
          ))}
        </span>
      )}
      <a href="#quiz">04 Quiz</a>
    </nav>
  );
}

function ReviewHeader({ state }: { state: ReviewPresentation }) {
  const { pr, report } = state;
  return (
    <header className="pr-head" id="top">
      <div className="pr-head-kicker">
        <span>PR REVIEW · REV {report.revision}</span>
        <span className={`pr-altitude is-${report.altitude}`}>{report.altitude} profile</span>
      </div>
      <h1>{pr.title}</h1>
      <p className="pr-repo">{pr.owner}/{pr.repo} <strong>#{pr.number}</strong> by @{pr.author}</p>
      <div className="pr-head-meta">
        <span><b>{pr.base}</b> ← <b>{pr.head}</b></span>
        <span>HEAD <code>{pr.headSha}</code></span>
        {pr.filesChanged !== undefined && <span>{pr.filesChanged} files</span>}
        {pr.additions !== undefined && <span className="pr-add">+{pr.additions}</span>}
        {pr.deletions !== undefined && <span className="pr-del">−{pr.deletions}</span>}
      </div>
      <div className="pr-personalization">
        <strong>Personalized read</strong>
        <p>{report.knowledgeSummary}</p>
        <span>Frozen knowledge snapshot for revision {report.revision}</span>
      </div>
    </header>
  );
}

function Report({
  state,
  adapter,
}: {
  state: ReviewPresentation;
  adapter: ReviewAdapter;
}) {
  return (
    <>
      <section id="background" className="pr-report-section">
        <span className="pr-section-number">01</span><h2>Background</h2>
        {state.report.background.lead !== undefined && <p className="pr-section-lead">{state.report.background.lead}</p>}
        <NarrativeBlocks blocks={state.report.background.blocks} />
      </section>
      <section id="intuition" className="pr-report-section">
        <span className="pr-section-number">02</span><h2>Intuition</h2>
        <p className="pr-intuition-goal"><strong>The goal</strong>{" "}{state.report.intuition.goal}</p>
        {state.report.intuition.lead !== undefined && <p className="pr-section-lead">{state.report.intuition.lead}</p>}
        <NarrativeBlocks blocks={state.report.intuition.blocks} />
      </section>
      <section id="code" className="pr-report-section">
        <span className="pr-section-number">03</span><h2>Code</h2>
        <p className="pr-section-lead">{state.report.code.lead}</p>
        <section id="code-interfaces" className="pr-code-layer" aria-labelledby="code-interfaces-title">
          <span className="pr-code-layer-kicker">Contract first</span>
          <h3 id="code-interfaces-title">Interface changes</h3>
          <p>{state.report.code.interfaces.lead}</p>
          <div className="pr-interface-list">
            {state.report.code.interfaces.items.map((item) => (
              <article
                key={item.id}
                data-interface-id={item.id}
                data-contract-status={item.status}
                className="pr-interface-change"
              >
                <header>
                  <div><span className="pr-contract-status">{item.status}</span><span className="pr-contract-kind">{item.kind}</span></div>
                  <h4><code>{item.file}<b>#{item.symbol}</b></code></h4>
                </header>
                <p>{item.callerImpact}</p>
                <InterfaceChangeExcerpts item={item} />
              </article>
            ))}
          </div>
        </section>
        <section id="code-integration" className="pr-code-layer" aria-labelledby="code-integration-title">
          <span className="pr-code-layer-kicker">Runtime wiring</span>
          <h3 id="code-integration-title">Integration path</h3>
          <p>{state.report.code.integration.lead}</p>
          <section className="pr-integration-trace" aria-labelledby="code-integration-trace-title">
            <h4 id="code-integration-trace-title">Quick boundary trace</h4>
            <p>{state.report.code.integration.trace.lead}</p>
            <ReviewCodeExcerpt excerpt={state.report.code.integration.trace.excerpt} />
          </section>
          <h4 id="code-integration-details-title" className="pr-integration-details-title">Boundary details</h4>
          <ol className="pr-integration-path" aria-labelledby="code-integration-details-title">
            {state.report.code.integration.steps.map((step, index) => (
              <li key={step.id} data-integration-id={step.id}>
                <span className="pr-integration-number">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <span className="pr-integration-role">{step.role}</span>
                  <h4><code>{step.module}<b>#{step.symbol}</b></code></h4>
                  <p><strong>Handoff:</strong> {step.handoff}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <section id="code-walkthrough" className="pr-code-layer" aria-labelledby="code-walkthrough-title">
          <span className="pr-code-layer-kicker">Inside the change</span>
          <h3 id="code-walkthrough-title">Implementation walkthrough</h3>
          <p>{state.report.code.walkthrough.lead}</p>
          {state.report.code.walkthrough.groups.map((group, index) => (
            <article key={group.id} id={group.id} className="pr-code-group">
              <header><span>{String(index + 1).padStart(2, "0")}</span><div><h4>{group.title}</h4><p>{group.purpose}</p></div></header>
              {group.explanation.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              <ReviewCodeExcerpt excerpt={group.excerpt} />
              <div className="pr-surfaces" aria-label={`${group.title} code surfaces`}>
                {group.surfaces.map((surface) => (
                  <div key={`${surface.file}#${surface.symbol}`}>
                    <code>{surface.file}<b>#{surface.symbol}</b></code><span>{surface.note}</span>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>
      </section>
      <section id="quiz" className="pr-report-section pr-quiz-section">
        <span className="pr-section-number">04</span><h2>Quiz</h2>
        <p className="pr-section-lead">Explain the mechanism in your own words. Passing answers update demonstrated knowledge; reading alone only records exposure.</p>
        <QuizSection
          quizzes={state.quizzes}
          disabled={state.closed}
          onSubmit={(id, answer) => adapter.submitQuiz(id, answer)}
        />
      </section>
    </>
  );
}

function DoneDialog({
  state,
  counts,
  initialError,
  onCancel,
  onClose,
  returnFocusRef,
}: {
  state: ReviewPresentation;
  counts?: ReviewUnresolvedCounts;
  initialError?: string;
  onCancel: () => void;
  onClose: (force: boolean) => Promise<void>;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const threads = counts?.conversations ?? unresolvedThreadCount(state);
  const quizzes = counts?.quizzes ?? incompleteQuizCount(state);
  const unresolved = threads > 0 || quizzes > 0;
  const continueRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);

  useEffect(() => {
    continueRef.current?.focus();
    const backdrop = dialogRef.current?.parentElement;
    const background = backdrop === null || backdrop === undefined
      ? []
      : [...backdrop.parentElement!.children].filter((element) => element !== backdrop);
    const previouslyInert = background.map((element) => element.hasAttribute("inert"));
    background.forEach((element) => element.setAttribute("inert", ""));
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else {
        trapModalTab(event, dialogRef.current);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      background.forEach((element, index) => {
        if (!previouslyInert[index]) element.removeAttribute("inert");
      });
      returnFocusRef.current?.ownerDocument.defaultView?.requestAnimationFrame(() => {
        returnFocusRef.current?.focus();
      });
    };
  }, [onCancel, returnFocusRef]);

  const finish = async (): Promise<void> => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onClose(unresolved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not finish this review.");
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="pr-modal-backdrop">
      <div
        ref={dialogRef}
        className="pr-done-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="done-title"
        aria-describedby="done-description"
        tabIndex={-1}
      >
        <span className="pr-done-glyph" aria-hidden="true">{unresolved ? "!" : "✓"}</span>
        <h2 id="done-title">{unresolved ? "This review still has loose ends" : "Finish this review?"}</h2>
        {unresolved && <div className="pr-done-counts">
          <span><strong>{threads}</strong> unresolved {threads === 1 ? "conversation" : "conversations"}</span>
          <span><strong>{quizzes}</strong> unfinished {quizzes === 1 ? "quiz" : "quizzes"}</span>
        </div>}
        <p id="done-description">{unresolved
          ? "You can keep working, or close anyway. Your report, conversations, and attempts remain readable."
          : "This keeps the completed report and review history available as read-only."}</p>
        {error !== undefined && <p className="error" role="alert">{error}</p>}
        <footer>
          <button type="button" className="btn btn-ghost" disabled={submitting} onClick={() => void finish()}>
            {submitting ? "Closing…" : unresolved ? "Close anyway" : "Finish review"}
          </button>
          <button ref={continueRef} type="button" className="btn btn-primary" disabled={submitting} onClick={onCancel}>
            {unresolved ? "Continue review" : "Keep reviewing"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function PrReviewScreen({
  adapter,
  onOpenKnowledge,
  selectionOverride,
  embedded = false,
  renderReport,
  revisionBanner,
  tocGroups,
  interactionsEnabled = true,
  feedbackEnabled = interactionsEnabled,
  doneEnabled = interactionsEnabled,
  interactionNotice,
  activityDock,
}: {
  adapter: ReviewAdapter;
  onOpenKnowledge?: () => void;
  /** Deterministic Storybook/test seam; production captures the browser selection. */
  selectionOverride?: CapturedSelection;
  /** Production already lives inside AppShell; Storybook keeps the full shell. */
  embedded?: boolean;
  renderReport?: (state: ReviewPresentation, adapter: ReviewAdapter) => ReactNode;
  revisionBanner?: ReactNode;
  tocGroups?: ReportTocGroup[];
  /** Phase-gated production capabilities; Storybook remains fully interactive. */
  interactionsEnabled?: boolean;
  feedbackEnabled?: boolean;
  doneEnabled?: boolean;
  interactionNotice?: ReactNode;
  /** Shared plan/PR activity surface, placed directly below the PR identity header. */
  activityDock?: ReactNode;
}) {
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot);
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneCounts, setDoneCounts] = useState<ReviewUnresolvedCounts>();
  const [doneError, setDoneError] = useState<string>();
  const [doneSubmitting, setDoneSubmitting] = useState(false);
  const doneSubmittingRef = useRef(false);
  const doneButtonRef = useRef<HTMLButtonElement | null>(null);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState<KnowledgeScope>("project");
  const reportRef = useRef<HTMLDivElement | null>(null);
  const collapseRef = useRef<HTMLButtonElement | null>(null);
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavWasOpenRef = useRef(false);
  const capturedSelection = useSelection(
    reportRef,
    feedbackEnabled && !state.closed && composer === null && selectionOverride === undefined,
  );
  const selection = selectionOverride ?? capturedSelection;
  const looseEnds = unresolvedThreadCount(state) + incompleteQuizCount(state);
  const shellClass = [
    "pr-review-app",
    !embedded && "app-shell",
    embedded && "is-embedded",
    state.closed && "is-closed",
    navCollapsed && "collapsed",
    mobileNavOpen && "is-mobile-nav-open",
  ].filter(Boolean).join(" ");

  useScrollLock(mobileNavOpen);

  useLayoutEffect(() => {
    if (mobileNavOpen) collapseRef.current?.focus();
    else if (mobileNavWasOpenRef.current) {
      const button = isDesktopWidth(window.innerWidth) ? collapseRef.current : expandRef.current;
      button?.ownerDocument.defaultView?.requestAnimationFrame(() => button.focus());
    }
    mobileNavWasOpenRef.current = mobileNavOpen;
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const handleModalKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMobileNavOpen(false);
      } else {
        trapModalTab(event, collapseRef.current?.closest("aside") ?? null);
      }
    };
    document.addEventListener("keydown", handleModalKey);
    return () => document.removeEventListener("keydown", handleModalKey);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeAtDesktop = (): void => {
      if (isDesktopWidth(window.innerWidth)) setMobileNavOpen(false);
    };
    closeAtDesktop();
    window.addEventListener("resize", closeAtDesktop);
    return () => window.removeEventListener("resize", closeAtDesktop);
  }, [mobileNavOpen]);

  const openComposer = (mode: ComposerState["mode"]): void => {
    if (selection === null || selection === undefined || state.closed) return;
    const narrow = typeof window !== "undefined" && window.innerWidth < 600;
    // .composer is a fixed 380px-wide card centered on --cx whose top sits at
    // --cy; a selection near a viewport edge would otherwise pin it off
    // screen. Mirror SelectionBar: flip above short-bottomed selections, then
    // clamp both axes to the viewport.
    const composerHeight = 300;
    const edge = Math.min(202, window.innerWidth / 2);
    const x = Math.max(
      edge,
      Math.min(window.innerWidth - edge, selection.rect.left + selection.rect.width / 2),
    );
    const below = selection.rect.bottom + 48;
    const y = below + composerHeight > window.innerHeight
      ? Math.max(12, selection.rect.top - 8 - composerHeight)
      : below;
    setComposer({
      mode,
      anchor: selection.anchor,
      at: narrow ? null : { x, y },
    });
  };
  const sendThread = async (
    mode: ComposerState["mode"],
    body: string,
  ): Promise<boolean> => {
    if (composer?.anchor?.exact === undefined) return false;
    try {
      await adapter.createThread({
        intent: mode === "ask" ? "question" : "comment",
        anchor: composer.anchor.exact,
        sourceAnchor: composer.anchor,
        body: body.trim(),
        remember,
        scope,
      });
      setComposer(null);
      setRemember(false);
      setScope("project");
      return true;
    } catch {
      return false;
    }
  };

  const closeCleanReview = async (): Promise<void> => {
    if (doneSubmittingRef.current) return;
    doneSubmittingRef.current = true;
    setDoneSubmitting(true);
    try {
      await adapter.close(false);
    } catch (caught) {
      if (caught instanceof ReviewIncompleteError) {
        setDoneCounts(caught.unresolved);
      } else {
        setDoneError(caught instanceof Error ? caught.message : "Could not finish this review.");
      }
      setDoneOpen(true);
    } finally {
      doneSubmittingRef.current = false;
      setDoneSubmitting(false);
    }
  };

  const Page = embedded ? "div" : "main";
  return (
    <div className={shellClass}>
      {!embedded && <ReviewSidebar
        state={state}
        onOpenKnowledge={onOpenKnowledge}
        collapseRef={collapseRef}
        mobileModal={mobileNavOpen}
        onCollapse={() => {
          setNavCollapsed(true);
          setMobileNavOpen(false);
        }}
      />}
      {!embedded && mobileNavOpen && (
        <button
          type="button"
          className="pr-nav-scrim"
          aria-label="close session navigation"
          onClick={() => {
            setMobileNavOpen(false);
          }}
        />
      )}
      <Page
        className={embedded ? "pr-review-page" : "app-content pr-review-page"}
        inert={mobileNavOpen || undefined}
      >
        {!embedded && <button
          ref={expandRef}
          type="button"
          className="app-expand"
          aria-label="show sessions"
          aria-controls="pr-review-navigation"
          aria-expanded={mobileNavOpen}
          title="show sessions"
          onClick={() => {
            setNavCollapsed(false);
            setMobileNavOpen(typeof window !== "undefined" && window.innerWidth < 960);
          }}
        >
          »
        </button>}
        {state.closed && <div className="pr-closed-banner">Review closed · report preserved as read-only</div>}
        {revisionBanner}
        {interactionNotice}
        <ReviewHeader state={state} />
        {activityDock}
        <div className="pr-review-grid">
          <TableOfContents groups={tocGroups} />
          <div className="pr-report" ref={reportRef}>
            {renderReport === undefined ? <Report state={state} adapter={adapter} /> : renderReport(state, adapter)}
          </div>
          <ThreadRail
            threads={state.threads}
            disabled={state.closed || !feedbackEnabled}
            onFollowup={(rootId, body) => adapter.createFollowup(rootId, body)}
            onConductCodeChange={(threadId) => adapter.conductCodeChange(threadId)}
          />
        </div>
        <footer className="pr-review-finish">
          <div>
            <strong>Reached the end.</strong>
            <span>{!doneEnabled
              ? "Conversation review is live; Done is enabled by the lifecycle phase."
              : looseEnds === 0 ? "Everything is resolved." : `${looseEnds} items still need attention.`}</span>
          </div>
          <button
            ref={doneButtonRef}
            type="button"
            className="btn btn-primary"
            disabled={state.closed || !doneEnabled || doneSubmitting}
            title={doneEnabled ? undefined : "Done is enabled by the review lifecycle phase"}
            onClick={() => {
              setDoneCounts(undefined);
              setDoneError(undefined);
              if (looseEnds === 0) void closeCleanReview();
              else setDoneOpen(true);
            }}>{doneSubmitting ? "Finishing…" : "Done"}</button>
        </footer>
      </Page>
      {feedbackEnabled && selection !== null && selection !== undefined && composer === null && !state.closed && (
        <SelectionBar
          selection={selection}
          placement="contextual"
          onComment={() => openComposer("comment")}
          onAsk={() => openComposer("ask")}
        />
      )}
      {composer !== null && (
        <Composer
          state={composer}
          commentDelivery="immediate"
          onClose={() => setComposer(null)}
          onStack={() => undefined}
          onSendNow={(body) => sendThread("comment", body)}
          onAsk={(body) => sendThread("ask", body)}
          options={(
            <div className="pr-remember-row">
              <label>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                Add this exchange to knowledge
              </label>
              {remember && (
                <div className="pr-memory-scope" role="group" aria-label="knowledge scope">
                  {(["project", "user"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={scope === value ? "active" : ""}
                      aria-pressed={scope === value}
                      onClick={() => setScope(value)}
                    >
                      {value === "project" ? "Project" : "User"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        />
      )}
      {doneOpen && <DoneDialog
        state={state}
        counts={doneCounts}
        initialError={doneError}
        returnFocusRef={doneButtonRef}
        onCancel={() => {
          setDoneOpen(false);
          setDoneCounts(undefined);
          setDoneError(undefined);
        }}
        onClose={async (force) => {
          await adapter.close(force);
          setDoneOpen(false);
          setDoneCounts(undefined);
          setDoneError(undefined);
        }}
      />}
    </div>
  );
}

export function quizDefinitions(raw: unknown): QuizDefinition[] {
  const questions = (raw as ReviewQuizPublicState | undefined)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((rawQuestion, index) => {
    if (typeof rawQuestion !== "object" || rawQuestion === null) return [];
    const question = rawQuestion as unknown as Record<string, unknown>;
    if (typeof question.prompt !== "string" || question.prompt.trim() === "") return [];
    const kind = question.mode === "choice" ? "choice" : "open";
    const options = Array.isArray(question.options)
      ? question.options.filter((item): item is string => typeof item === "string")
      : undefined;
    return [{
      id: typeof question.id === "string" ? question.id : `q${index + 1}`,
      concept: typeof question.concept === "string" ? question.concept : "important change",
      ...(typeof question.concept === "object" && question.concept !== null && typeof (question.concept as { label?: unknown }).label === "string"
        ? { concept: (question.concept as { label: string }).label }
        : {}),
      prompt: question.prompt,
      kind,
      ...(kind === "choice" && options !== undefined ? { options } : {}),
      expected: [],
      retryFeedback: typeof (question.latest as { feedback?: unknown } | undefined)?.feedback === "string"
        ? (question.latest as { feedback: string }).feedback
        : "Explain the missing causal link and try again.",
      status: question.status === "grading" || question.status === "retry" || question.status === "passed"
        ? question.status
        : "unanswered" as const,
      ...(typeof (question.latest as { answer?: unknown } | undefined)?.answer === "string"
        ? { answer: (question.latest as { answer: string }).answer }
        : {}),
      ...(typeof (question.latest as { feedback?: unknown } | undefined)?.feedback === "string"
        ? { feedback: (question.latest as { feedback: string }).feedback }
        : {}),
      ...((question.latest as { knowledge?: { scope?: unknown } } | undefined)?.knowledge?.scope === "user"
        ? { knowledgeScope: "user" as const }
        : (question.latest as { knowledge?: { scope?: unknown } } | undefined)?.knowledge?.scope === "project"
          ? { knowledgeScope: "project" as const }
          : {}),
    }];
  });
}

export function productionPresentation(
  session: ReviewLiveSession,
  payload: ReviewReportRevisionPayload,
  liveThreads: PublicReviewThread[] = [],
): ReviewPresentation {
  const [owner = "", repo = ""] = session.review.pullRequest.identity.repository.split("/");
  const frontmatter = payload.report === undefined ? undefined : parseReviewReport(payload.report).frontmatter;
  const quizzes = quizDefinitions(payload.quiz);
  return {
    id: session.id,
    headRevision: session.review.revision,
    pr: {
      owner,
      repo,
      number: session.review.pullRequest.identity.number,
      title: session.review.pullRequest.title,
      author: session.review.pullRequest.author,
      base: session.review.pullRequest.baseRef,
      head: session.review.pullRequest.headRef,
      headSha: payload.revision.headSha,
    },
    navigation: { plans: [], reviews: [] },
    report: {
      altitude: frontmatter?.altitude ?? "balanced",
      revision: payload.revision.revision,
      knowledgeSummary: `${frontmatter?.altitude === "expert" ? "Expert" : "Balanced"} read authored from frozen User and ${payload.snapshot.project.repo} knowledge. Snapshot ${payload.snapshot.hash.slice(0, 12)} remains attached to this revision.`,
      background: { blocks: [] },
      intuition: { goal: "", blocks: [] },
      code: {
        lead: "",
        interfaces: { lead: "", items: [] },
        integration: { lead: "", steps: [], trace: { lead: "", excerpt: { language: "", label: "", code: "" } } },
        walkthrough: { lead: "", groups: [] },
      },
    },
    quizzes,
    threads: liveThreads.map((thread) => ({
      id: thread.id,
      intent: thread.intent,
      anchor: thread.anchor.exact ?? thread.anchor.section,
      ...(thread.anchorState === "orphaned" ? { unanchored: true } : {}),
      sourceAnchor: thread.anchor,
      body: thread.body,
      createdAt: thread.createdAt,
      ...(thread.replyTo === undefined ? {} : { replyTo: thread.replyTo }),
      status: thread.codeAction?.status === "completed" && thread.response !== undefined
        ? "answered"
        : thread.codeAction !== undefined ? "change-requested" : thread.response !== undefined ? "answered" : "open",
      ...(thread.response === undefined ? {} : { response: thread.response.body }),
      ...(thread.remember === undefined ? {} : { knowledgeScope: thread.remember.scope }),
      ...(thread.saved === undefined ? {} : {
        receipt: thread.saved.scope === "user"
          ? "Saved in User knowledge"
          : `Saved in ${session.review.pullRequest.identity.repository} Project knowledge`,
      }),
      identity: {
        reportRevision: thread.identity.reportRevision,
        headRevision: thread.identity.headRevision,
        headSha: thread.identity.headSha,
      },
      canConductCodeChange: thread.intent === "comment" &&
        thread.replyTo === undefined &&
        session.review.pullRequest.state === "open" &&
        !session.review.pullRequest.permissions.readOnly &&
        ["write", "maintain", "admin"].includes(session.review.pullRequest.permissions.viewerPermission) &&
        !session.review.pullRequest.isCrossRepository &&
        session.review.pullRequest.headRepository === session.review.pullRequest.identity.repository &&
        thread.identity.headRevision === session.review.revision &&
        thread.identity.headSha === session.review.head.sha,
      canFollowup: thread.replyTo === undefined &&
        thread.identity.headRevision === session.review.revision &&
        thread.identity.headSha === session.review.head.sha &&
        thread.codeAction?.status !== "requested" && thread.codeAction?.status !== "working",
      ...(thread.codeAction === undefined ? {} : {
        codeActionStatus: thread.codeAction.status,
        ...(thread.codeAction.message === undefined ? {} : { actionMessage: thread.codeAction.message }),
      }),
    })),
    closed: session.status === "done",
  };
}

/** Real daemon-backed report composition; the outer AppShell remains the only sidebar. */
export function ProductionPrReviewScreen({
  session,
  payload,
  liveQuiz,
  liveThreads = [],
  activityDock,
}: {
  session: ReviewLiveSession;
  payload: ReviewReportRevisionPayload;
  liveQuiz?: ReviewQuizPublicState;
  liveThreads?: PublicReviewThread[];
  activityDock?: ReactNode;
}) {
  const matchingLiveQuiz = liveQuiz?.session === payload.revision.session &&
    liveQuiz.revision === payload.revision.revision &&
    liveQuiz.headRevision === payload.revision.headRevision &&
    liveQuiz.headSha === payload.revision.headSha
    ? liveQuiz
    : undefined;
  const presentation = useMemo(
    () => productionPresentation(session, matchingLiveQuiz === undefined ? payload : { ...payload, quiz: matchingLiveQuiz }, liveThreads),
    [session, payload, matchingLiveQuiz, liveThreads],
  );
  // Keep transport state (especially a response-loss idempotency key) stable
  // across ordinary session/quiz SSE renders. A report revision is a new
  // immutable quiz contract, so only that identity gets a fresh adapter.
  const adapterKey = `${session.id}:r${payload.revision.revision}`;
  const adapterSlot = useRef<{ key: string; adapter: LiveReviewAdapter } | undefined>(undefined);
  if (adapterSlot.current?.key !== adapterKey) {
    adapterSlot.current = {
      key: adapterKey,
      adapter: new LiveReviewAdapter(
        presentation,
        async (question, answer, idempotencyKey) => quizDefinitions(
          await postReviewQuizAnswer(session.id, payload.revision.revision, question, answer, idempotencyKey),
        ),
        async (draft, idempotencyKey) => {
          if (draft.sourceAnchor === undefined) throw new Error("review selection lost its anchor");
          const thread = await postReviewThread(session.id, {
            intent: draft.intent,
            anchor: draft.sourceAnchor,
            body: draft.body,
            reportRevision: payload.revision.revision,
            headRevision: payload.revision.headRevision,
            headSha: payload.revision.headSha,
            idempotencyKey,
            ...(draft.remember ? { rememberScope: draft.scope } : {}),
          });
          return productionPresentation(session, payload, [thread]).threads[0]!;
        },
        async (thread) => {
          if (thread.identity === undefined) throw new Error("review Comment lost its immutable identity");
          const updated = await postReviewCodeAction(session.id, thread.id, thread.identity);
          return productionPresentation(session, payload, [updated]).threads[0]!;
        },
        async (force) => postReviewDone(session.id, force),
        async (root, body, idempotencyKey) => {
          const thread = await postReviewFollowup(session.id, root.id, {
            body,
            reportRevision: payload.revision.revision,
            headRevision: payload.revision.headRevision,
            headSha: payload.revision.headSha,
            idempotencyKey,
          });
          return productionPresentation(session, payload, [thread]).threads[0]!;
        },
      ),
    };
  }
  const adapter = adapterSlot.current.adapter;
  // The same adapter consumes the newest parent/SSE projection before paint;
  // its private retry-key map deliberately survives this snapshot replacement.
  useLayoutEffect(() => adapter.replaceSnapshot(presentation), [adapter, presentation]);
  const parsed = useMemo(() => parseReviewReport(payload.report ?? ""), [payload.report]);
  const staleHead = payload.revision.headRevision !== session.review.revision ||
    payload.revision.headSha !== session.review.head.sha;
  const olderReport = payload.revision.revision !== session.revision;
  return (
    <PrReviewScreen
      adapter={adapter}
      embedded
      feedbackEnabled={!staleHead && !olderReport}
      doneEnabled={!staleHead && !olderReport}
      tocGroups={parsed.codeGroups.map(({ id, title, kind }) => ({ id, title, kind }))}
      revisionBanner={(
        <div className="pr-report-revision-banner">
          <SessionMenuButton className="pr-mobile-session-menu" />
          <strong>Report revision {payload.revision.revision}</strong>
          {olderReport && <span className="pr-stale-report">Loading current report revision {session.revision}</span>}
          <span>report head generation {payload.revision.headRevision} · <code>{payload.revision.headSha.slice(0, 12)}</code></span>
          {staleHead && (
            <span className="pr-stale-report">
              Archived report · current head generation {session.review.revision} · <code>{session.review.head.sha.slice(0, 12)}</code>
            </span>
          )}
          <span>snapshot <code>{payload.snapshot.hash.slice(0, 12)}</code></span>
        </div>
      )}
      interactionNotice={(
        <div className="pr-report-capability-note" role="note">
          Quiz answers, anchored conversations, and durable completion are live.
        </div>
      )}
      activityDock={activityDock}
      renderReport={(state, liveAdapter) => (
        <Suspense fallback={<p className="loading">loading report renderer…</p>}>
          <ReportView
            markdown={payload.report ?? ""}
            quiz={state.quizzes.length === 0 ? undefined : (
              <QuizSection
                quizzes={state.quizzes}
                disabled={staleHead || olderReport || state.closed}
                onSubmit={(id, answer) => liveAdapter.submitQuiz(id, answer)}
              />
            )}
          />
        </Suspense>
      )}
    />
  );
}
