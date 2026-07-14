/** Presentation contracts for the PR-review screen.
 *
 * Phase 1 deliberately stops at this boundary: production React components read
 * an adapter, while Storybook supplies an in-memory implementation. Later daemon
 * work can implement the same surface without rewriting the screen or its stories.
 */

export type KnowledgeScope = "user" | "project";
export type FeedbackIntent = "question" | "comment";
export type QuizStatus = "unanswered" | "grading" | "retry" | "passed";

export interface PullRequestMeta {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  base: string;
  head: string;
  headSha: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface CodeSurface {
  file: string;
  symbol: string;
  note: string;
}

export interface CodeExcerpt {
  language: string;
  label: string;
  code: string;
}

export type InterfaceContractKind = "type definition" | "function signature" | "route" | "command" | "event";

interface InterfaceChangeBase {
  id: string;
  kind: InterfaceContractKind;
  file: string;
  symbol: string;
  callerImpact: string;
}

export type InterfaceChange =
  | (InterfaceChangeBase & { status: "added"; before?: never; after: CodeExcerpt })
  | (InterfaceChangeBase & { status: "changed"; before: CodeExcerpt; after: CodeExcerpt })
  | (InterfaceChangeBase & { status: "removed"; before: CodeExcerpt; after?: never });

export interface InterfaceChangesSection {
  lead: string;
  items: InterfaceChange[];
}

export interface IntegrationStep {
  id: string;
  module: string;
  symbol: string;
  role: string;
  handoff: string;
}

export interface IntegrationBoundaryTrace {
  lead: string;
  excerpt: CodeExcerpt;
}

export interface IntegrationPathSection {
  lead: string;
  steps: IntegrationStep[];
  trace: IntegrationBoundaryTrace;
}

export interface NarrativeProseBlock {
  id: string;
  kind: "prose";
  /** Optional orienting label such as "Prerequisite" or "Mental model". */
  eyebrow?: string;
  title?: string;
  paragraphs: string[];
}

export interface NarrativeSequenceBlock {
  id: string;
  kind: "sequence";
  title: string;
  steps: Array<{ label: string; detail: string }>;
  caption?: string;
}

/** Ordered editorial blocks shared by Background and Intuition. */
export type NarrativeBlock = NarrativeProseBlock | NarrativeSequenceBlock;

export interface NarrativeSection {
  /** Optional orienting sentence before the ordered blocks. */
  lead?: string;
  blocks: NarrativeBlock[];
}

export interface IntuitionSection extends NarrativeSection {
  /** One-sentence essence of the change, before examples or implementation detail. */
  goal: string;
}

export interface CodeGroup {
  id: string;
  title: string;
  purpose: string;
  explanation: string[];
  excerpt?: CodeExcerpt;
  surfaces: CodeSurface[];
}

export interface ImplementationWalkthroughSection {
  lead: string;
  groups: CodeGroup[];
}

/** Required reader order for a PR's changed contracts, wiring, then internals. */
export interface CodeSection {
  lead: string;
  interfaces: InterfaceChangesSection;
  integration: IntegrationPathSection;
  walkthrough: ImplementationWalkthroughSection;
}

export interface ReviewNavigationItem {
  id: string;
  title: string;
  meta: string;
  state: "active" | "working" | "done";
  /** Plan-only collection membership; omitted items stay in the active list. */
  group?: "open-pr";
}

export interface ReviewNavigation {
  plans: ReviewNavigationItem[];
  reviews: ReviewNavigationItem[];
}

export interface ReviewReport {
  altitude: "balanced" | "expert";
  revision: number;
  knowledgeSummary: string;
  background: NarrativeSection;
  intuition: IntuitionSection;
  code: CodeSection;
}

export interface QuizDefinition {
  id: string;
  concept: string;
  prompt: string;
  kind: "open" | "choice";
  options?: string[];
  expected: string[];
  retryFeedback: string;
  status: QuizStatus;
  answer?: string;
  feedback?: string;
  knowledgeScope?: KnowledgeScope;
}

export interface ReviewThread {
  id: string;
  intent: FeedbackIntent;
  anchor: string;
  body: string;
  status: "open" | "answered" | "change-requested";
  response?: string;
  knowledgeScope?: KnowledgeScope;
  receipt?: string;
}

export interface ReviewPresentation {
  id: string;
  pr: PullRequestMeta;
  navigation: ReviewNavigation;
  report: ReviewReport;
  quizzes: QuizDefinition[];
  threads: ReviewThread[];
  closed: boolean;
}

export interface ThreadDraft {
  intent: FeedbackIntent;
  anchor: string;
  body: string;
  remember: boolean;
  scope: KnowledgeScope;
}

export interface ReviewAdapter {
  getSnapshot: () => ReviewPresentation;
  subscribe: (listener: () => void) => () => void;
  submitQuiz: (quizId: string, answer: string) => Promise<void>;
  createThread: (draft: ThreadDraft) => Promise<void>;
  conductCodeChange: (threadId: string) => Promise<void>;
  close: (force: boolean) => void;
}

function replaceQuiz(
  state: ReviewPresentation,
  id: string,
  update: (quiz: QuizDefinition) => QuizDefinition,
): ReviewPresentation {
  return {
    ...state,
    quizzes: state.quizzes.map((quiz) => (quiz.id === id ? update(quiz) : quiz)),
  };
}

function answerPasses(quiz: QuizDefinition, answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return quiz.expected.every((fragment) => normalized.includes(fragment.toLowerCase()));
}

/** Deterministic Storybook/test adapter; it performs no network or filesystem I/O. */
export class MemoryReviewAdapter implements ReviewAdapter {
  private state: ReviewPresentation;
  private readonly listeners = new Set<() => void>();

  constructor(
    fixture: ReviewPresentation,
    private readonly gradingDelayMs = 450,
  ) {
    this.state = structuredClone(fixture);
  }

  getSnapshot = (): ReviewPresentation => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async submitQuiz(quizId: string, answer: string): Promise<void> {
    const quiz = this.state.quizzes.find((item) => item.id === quizId);
    if (
      this.state.closed
      || quiz === undefined
      || quiz.status === "grading"
      || quiz.status === "passed"
    ) return;
    this.update(replaceQuiz(this.state, quizId, (item) => ({ ...item, answer, status: "grading" })));
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, this.gradingDelayMs));
    const passed = answerPasses(quiz, answer);
    this.update(
      replaceQuiz(this.state, quizId, (item) => ({
        ...item,
        status: passed ? "passed" : "retry",
        feedback: passed
          ? "That explanation connects the mechanism to the behavior."
          : item.retryFeedback,
        knowledgeScope: passed ? "project" : undefined,
      })),
    );
  }

  async createThread(draft: ThreadDraft): Promise<void> {
    if (this.state.closed) return;
    const number = this.state.threads.length + 1;
    const scopeLabel = draft.scope === "project" ? `${this.state.pr.owner}/${this.state.pr.repo}` : "User";
    const receipt = draft.remember ? `Remembered in ${scopeLabel} knowledge` : undefined;
    this.update({
      ...this.state,
      threads: [
        ...this.state.threads,
        {
          id: `t${number}`,
          intent: draft.intent,
          anchor: draft.anchor,
          body: draft.body,
          status: "open",
          knowledgeScope: draft.remember ? draft.scope : undefined,
          receipt,
        },
      ],
    });
  }

  async conductCodeChange(threadId: string): Promise<void> {
    if (this.state.closed) return;
    const thread = this.state.threads.find((item) => item.id === threadId);
    if (thread?.intent !== "comment" || thread.status !== "open") return;
    this.update({
      ...this.state,
      threads: this.state.threads.map((item) => (
        item.id === threadId ? { ...item, status: "change-requested" } : item
      )),
    });
  }

  close(force: boolean): void {
    const unresolved = unresolvedThreadCount(this.state) > 0;
    const incomplete = this.state.quizzes.some((quiz) => quiz.status !== "passed");
    if (!force && (unresolved || incomplete)) return;
    this.update({ ...this.state, closed: true });
  }

  private update(state: ReviewPresentation): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

export function unresolvedThreadCount(state: ReviewPresentation): number {
  return state.threads.filter((thread) => thread.status !== "answered").length;
}

export function incompleteQuizCount(state: ReviewPresentation): number {
  return state.quizzes.filter((quiz) => quiz.status !== "passed").length;
}
