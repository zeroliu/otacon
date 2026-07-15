import type { ReviewPresentation } from "./model";

const pr = {
  owner: "zeroliu",
  repo: "otacon",
  number: 91,
  title: "Preserve a frozen knowledge snapshot per review revision",
  author: "alexchen",
  base: "main",
  head: "feat/review-knowledge-snapshot",
  headSha: "8c4e9b1",
  filesChanged: 9,
  additions: 418,
  deletions: 76,
};

const quizzes = [
  {
    id: "q1",
    concept: "snapshot boundary",
    prompt: "Why must knowledge be frozen before a report revision is authored? Describe the failure it prevents.",
    kind: "open" as const,
    expected: ["snapshot", "revision"],
    retryFeedback: "Name both the frozen snapshot and the report revision it protects from changing underneath the reader.",
    status: "unanswered" as const,
  },
  {
    id: "q2",
    concept: "evidence semantics",
    prompt: "What is the difference between seeing a function in this report and demonstrating understanding of its behavior?",
    kind: "open" as const,
    expected: ["quiz", "exposure"],
    retryFeedback: "You explained quiz evidence, but also state that reading files records exposure rather than demonstrated understanding.",
    status: "retry" as const,
    answer: "Passing the quiz demonstrates the behavior.",
    feedback: "You explained quiz evidence, but also state that reading files records exposure rather than demonstrated understanding.",
  },
  {
    id: "q3",
    concept: "revision lifecycle",
    prompt: "A quiz pass updates Project knowledge. What happens to the report currently open on screen?",
    kind: "open" as const,
    expected: ["unchanged"],
    retryFeedback: "Focus on whether the open report is mutated or remains unchanged.",
    status: "passed" as const,
    answer: "It remains unchanged; the new knowledge applies to a later report revision.",
    feedback: "The open report remains stable; a later revision may use the new knowledge.",
    knowledgeScope: "project" as const,
  },
  {
    id: "q4",
    concept: "causal ordering",
    prompt: "Why is the Code section grouped by causal reading order instead of file or diff order?",
    kind: "open" as const,
    expected: ["dependency"],
    retryFeedback: "Connect the reading order to the dependency each group creates for the next one.",
    status: "grading" as const,
    answer: "Each group establishes the dependency needed to understand the next.",
  },
];

const threads = [
  {
    id: "q1",
    intent: "question" as const,
    anchor: "A report revision keeps the snapshot hashes that shaped its explanation.",
    body: "Does the snapshot store the full Markdown or only its hash?",
    status: "answered" as const,
    response: "The revision stores an immutable copy plus its hash. The hash proves which summary shaped the report; the copy keeps it inspectable if current knowledge changes.",
    knowledgeScope: "project" as const,
    receipt: "Remembered in zeroliu/otacon knowledge",
  },
  {
    id: "t2",
    intent: "comment" as const,
    anchor: "Revision one remains unchanged after the quiz updates knowledge.",
    body: "Add a sentence that contrasts this with a live personalized feed.",
    status: "open" as const,
  },
  {
    id: "t3",
    intent: "comment" as const,
    anchor: "The store appends quiz evidence after grading.",
    body: "Please keep the snapshot write and evidence append in separate transactions.",
    status: "change-requested" as const,
    knowledgeScope: "project" as const,
    receipt: "Remembered in zeroliu/otacon knowledge",
  },
];

export const balancedFixture: ReviewPresentation = {
  id: "otr_snapshot_balanced",
  pr,
  navigation: {
    reviews: [
      { id: "review-current", title: `#${pr.number} ${pr.title}`, meta: `${pr.owner}/${pr.repo} · ${pr.head}`, state: "active" },
      { id: "review-typed-events", title: "#72 Typed events", meta: "acme/relay · done", state: "done" },
    ],
    plans: [
      { id: "plan-review-skill", title: "PR review skill", meta: "otacon · implementing", state: "working" },
      { id: "plan-cli-status", title: "CLI status surface", meta: "otacon · PR #84", state: "done", group: "open-pr" },
    ],
  },
  report: {
    altitude: "balanced",
    revision: 1,
    knowledgeSummary: "You know Otacon's plan review loop and TypeScript boundaries, but have not demonstrated the new knowledge-store lifecycle. This report expands the storage handoff and keeps React details concise.",
    background: {
      lead: "Before the change makes sense, there are three pieces of Otacon's review system to keep in view.",
      blocks: [
        {
          id: "background-personalization",
          kind: "prose",
          eyebrow: "System",
          title: "A report is generated for one reader",
          paragraphs: [
            "Otacon does not explain every PR at the same depth. Before authoring, it reads User knowledge for general preferences and Project knowledge for repository-specific concepts, then asks the agent to spend detail where this reader still has gaps.",
          ],
        },
        {
          id: "background-learning",
          kind: "prose",
          eyebrow: "Feedback loop",
          title: "The quiz changes what the next report should teach",
          paragraphs: [
            "Reading a file records exposure; passing an open-ended quiz records demonstrated understanding. That evidence updates the current knowledge summaries, so later reviews can compress concepts the reader has already proved.",
          ],
        },
        {
          id: "background-consistency",
          kind: "prose",
          eyebrow: "Problem",
          title: "Learning can move the input while the page is open",
          paragraphs: [
            "Answering this report's quiz can therefore change the same knowledge that personalized it. Without a boundary, the report becomes a moving target: its assumptions shift after grading while its prose and questions still reflect the old assumptions.",
          ],
        },
      ],
    },
    intuition: {
      goal: "Keep each report revision explainable by freezing the reader knowledge that shaped it, while letting quiz results improve future revisions.",
      lead: "Think of the report as a photograph, not a live dashboard. It captures what the agent knew about the reader at one authoring boundary.",
      blocks: [
        {
          id: "intuition-photo",
          kind: "prose",
          eyebrow: "Mental model",
          title: "The revision is a labeled photograph",
          paragraphs: [
            "When authoring begins, Otacon copies the User and Project summaries into a knowledge snapshot and pins that snapshot to the new report revision. The prose, examples, and quiz all come from that one stable view.",
            "The hashes on the revision are the label on the back of the photograph: they make it possible to inspect exactly which knowledge input produced the explanation later.",
          ],
        },
        {
          id: "intuition-example",
          kind: "prose",
          eyebrow: "Example",
          title: "Passing a quiz changes tomorrow, not yesterday",
          paragraphs: [
            "Suppose revision 1 teaches snapshot ownership and you pass its quiz. Project knowledge now records that concept as demonstrated, but revision 1 stays byte-for-byte the explanation you just read. Revision 2 may shorten that prerequisite because it starts from a new snapshot.",
          ],
        },
        {
          id: "intuition-flow",
          kind: "sequence",
          title: "One revision, one knowledge input",
          steps: [
            { label: "Capture", detail: "Copy User + Project knowledge before authoring." },
            { label: "Explain", detail: "Write the report and quiz against that snapshot." },
            { label: "Learn", detail: "Append graded evidence to current knowledge." },
            { label: "Revise", detail: "Use a fresh snapshot only for a new revision." },
          ],
          caption: "The feedback loop moves forward; it never rewrites the explanation that generated the evidence.",
        },
      ],
    },
    code: {
      lead: "Start with what callers must change, follow those contracts across module boundaries, then inspect the implementation in causal—not diff—order.",
      interfaces: {
        lead: "These declarations are the PR's caller-visible contract delta. Read them before the internals that implement them.",
        items: [
          {
            id: "interface-knowledge-snapshot",
            status: "added",
            kind: "type definition",
            file: "src/shared/review.ts",
            symbol: "ReviewKnowledgeSnapshot",
            callerImpact: "KnowledgeStore.capture now returns this value, beginRevision callers must pass it, and report inspectors can compare its hashes with the frozen User + Project Markdown.",
            after: {
              language: "ts",
              label: "review.ts · added snapshot contract",
              code: `export interface ReviewKnowledgeSnapshot {
  id: string;
  user: { markdown: string; sha256: string };
  project: { markdown: string; sha256: string };
  capturedAt: string;
}`,
            },
          },
          {
            id: "interface-review-revision",
            status: "changed",
            kind: "type definition",
            file: "src/shared/review.ts",
            symbol: "ReviewRevision",
            callerImpact: "Every revision producer must now populate snapshotId; consumers can trace the revision to frozen knowledge instead of inferring its input from mutable current summaries.",
            before: {
              language: "ts",
              label: "review.ts · previous revision contract",
              code: `export interface ReviewRevision {
  id: string;
  headSha: string;
}`,
            },
            after: {
              language: "ts",
              label: "review.ts · current revision contract",
              code: `export interface ReviewRevision {
  id: string;
  headSha: string;
  snapshotId: string;
}`,
            },
          },
          {
            id: "interface-begin-revision",
            status: "changed",
            kind: "function signature",
            file: "src/daemon/review-store.ts",
            symbol: "beginRevision",
            callerImpact: "The caller must capture knowledge first and pass the resulting snapshot into revision creation; the store no longer begins from mutable global knowledge implicitly.",
            before: {
              language: "ts",
              label: "review-store.ts · previous function signature",
              code: `beginRevision(
  pullRequest: PullRequestMeta,
  headSha: string,
): Promise<ReviewRevision>;`,
            },
            after: {
              language: "ts",
              label: "review-store.ts · current function signature",
              code: `beginRevision(input: {
  pullRequest: PullRequestMeta;
  headSha: string;
  snapshot: ReviewKnowledgeSnapshot;
}): Promise<ReviewRevision>;`,
            },
          },
        ],
      },
      integration: {
        lead: "Scan the call-site trace first to see one snapshot move across modules. Then use the boundary details to inspect what each module owns and hands off.",
        steps: [
          {
            id: "integration-start",
            module: "src/cli/commands/review.ts",
            symbol: "start",
            role: "Entry",
            handoff: "Resolves the canonical PR and HEAD, then invokes KnowledgeStore.capture with the repository key for the two reader scopes.",
          },
          {
            id: "integration-capture",
            module: "src/daemon/knowledge-store.ts",
            symbol: "capture",
            role: "Storage",
            handoff: "Persists immutable Markdown copies + hashes, then returns ReviewKnowledgeSnapshot to start, which passes it into ReviewStore.beginRevision.",
          },
          {
            id: "integration-begin",
            module: "src/daemon/review-store.ts",
            symbol: "beginRevision",
            role: "Authoring boundary",
            handoff: "Commits snapshot ownership with the empty revision, then returns ReviewRevision { id, headSha, snapshotId } to the authoring command.",
          },
          {
            id: "integration-submit",
            module: "src/cli/commands/review.ts",
            symbol: "submit",
            role: "Report publication",
            handoff: "Submits the authored report against the same snapshotId; the daemon exposes that frozen report to the UI and quiz grader.",
          },
          {
            id: "integration-grade",
            module: "src/daemon/quiz-grader.ts",
            symbol: "recordGrade",
            role: "Learning loop",
            handoff: "Appends evidence to current knowledge; a future start captures the updated summary without mutating this revision.",
          },
        ],
        trace: {
          lead: "The value names expose the whole lifecycle: capture returns frozen knowledge, beginRevision pins its id, submit verifies that id, and grading changes only the next capture.",
          excerpt: {
            language: "ts",
            label: "Abridged call-site trace · inputs, outputs, ownership",
            code: `// review.ts#start: mutable knowledge -> frozen value
const snapshot: ReviewKnowledgeSnapshot =
  await knowledgeStore.capture(repositoryKey);
// output: frozen User + Project Markdown

const revision: ReviewRevision =
  await reviewStore.beginRevision({
    pullRequest,
    headSha,
    snapshot, // input: store persists it with this revision
  });
// output: { id, headSha, snapshotId }

// review.ts#submit: enforce the pinned ownership
await reviewStore.submitReport({
  revisionId: revision.id,
  snapshotId: revision.snapshotId,
  report,
});

// quiz-grader.ts#recordGrade: update future input only
await quizGrader.recordGrade({ revisionId: revision.id, verdict });
// current knowledge changes; the pinned snapshot does not`,
          },
        },
      },
      walkthrough: {
        lead: "With the public delta and runtime wiring established, inspect the mechanisms that enforce the revision invariant.",
        groups: [
          {
            id: "code-contract",
            title: "Persist snapshot ownership",
            purpose: "Make the new contract durable before any report prose exists.",
            explanation: ["ReviewKnowledgeSnapshot records the User and Project Markdown, their hashes, and the capture time. beginRevision stores that snapshot and its id in the same revision commit."],
            surfaces: [
              { file: "src/daemon/knowledge-store.ts", symbol: "capture", note: "writes immutable scope copies" },
              { file: "src/daemon/review-store.ts", symbol: "beginRevision", note: "owns the frozen snapshot id" },
            ],
          },
          {
            id: "code-capture",
            title: "Capture before the agent writes",
            purpose: "Follow the command boundary where mutable knowledge becomes immutable report context.",
            explanation: ["The daemon reads both scopes, persists the snapshot, and only then returns authoring paths to the skill. If capture fails, no half-authored revision exists."],
            excerpt: {
              language: "ts",
              label: "review-store.ts · revision boundary",
              code: `const snapshot = await knowledge.capture(repo);
const revision = await reviewStore.beginRevision({
  pullRequest,
  headSha,
  snapshot,
});`,
            },
            surfaces: [
              { file: "src/daemon/review-store.ts", symbol: "beginRevision", note: "atomic revision + snapshot creation" },
              { file: "src/cli/commands/review.ts", symbol: "submit", note: "carries snapshot identity into report submission" },
            ],
          },
          {
            id: "code-learn",
            title: "Update the future, not the page",
            purpose: "End at grading, where the loop learns without invalidating the current report.",
            explanation: ["Passing a quiz appends evidence and updates the current Markdown summary. The open revision still renders its stored snapshot; only a later revision sees the new demonstrated concept."],
            surfaces: [
              { file: "src/daemon/quiz-grader.ts", symbol: "recordGrade", note: "appends evidence after verdict" },
              { file: "src/ui/pr-review/quiz-card.tsx", symbol: "QuizCard", note: "shows the saved knowledge destination" },
            ],
          },
        ],
      },
    },
  },
  quizzes,
  threads,
  closed: false,
};

export const expertFixture: ReviewPresentation = {
  ...balancedFixture,
  id: "otr_snapshot_expert",
  report: {
    altitude: "expert",
    revision: 1,
    knowledgeSummary: "You have demonstrated the session store, append-only evidence, and React external-store boundaries. This read compresses those prerequisites and concentrates on the new atomicity seam and revision invariant.",
    background: {
      blocks: [
        {
          id: "expert-background-invariant",
          kind: "prose",
          eyebrow: "Invariant",
          paragraphs: [
            "Report revision R must remain a pure function of PR head H and knowledge snapshot K, even after R's quizzes mutate current knowledge K′.",
          ],
        },
      ],
    },
    intuition: {
      goal: "Pin K to R before authoring; write K′ only after a verdict and use it for the next revision.",
      blocks: [
        {
          id: "expert-intuition-boundary",
          kind: "prose",
          paragraphs: [
            "Snapshot both summaries before authoring and retain their hashes on the revision. Evidence changes the next authoring context, never the current renderer input.",
          ],
        },
      ],
    },
    code: {
      lead: "Review the changed contract and its atomicity seam before the two invariant checks.",
      interfaces: {
        lead: "Only the public delta that changes an expert caller's obligations is expanded.",
        items: balancedFixture.report.code.interfaces.items.filter(
          (item) => item.id !== "interface-review-revision",
        ),
      },
      integration: {
        lead: "The compressed path keeps the ownership transfer and future-knowledge boundary visible.",
        steps: balancedFixture.report.code.integration.steps.filter(
          (step) => step.id !== "integration-capture",
        ),
        trace: balancedFixture.report.code.integration.trace,
      },
      walkthrough: {
        lead: "The remaining implementation detail is concentrated in two checks.",
        groups: [
          {
            id: "expert-atomicity",
            title: "The atomicity seam",
            purpose: "Review the only new failure boundary: snapshot + empty revision creation.",
            explanation: ["beginRevision stages the two Markdown copies and revision metadata in one rename-based commit. Submission rejects a snapshot id that does not belong to the target revision."],
            excerpt: {
              language: "ts",
              label: "review-store.ts · ownership check",
              code: `if (report.snapshotId !== revision.snapshotId) {
  throw new ReviewSnapshotMismatch(revision.id);
}`,
            },
            surfaces: [
              { file: "src/daemon/review-store.ts", symbol: "beginRevision", note: "single durable commit boundary" },
              { file: "src/daemon/review-store.ts", symbol: "submitReport", note: "snapshot ownership check" },
            ],
          },
          {
            id: "expert-invariant",
            title: "The revision invariant in the UI",
            purpose: "Verify that post-grade updates cannot leak into an already-open revision.",
            explanation: ["The detail payload includes snapshot metadata and report content together. The quiz mutation updates cards and evidence receipts, but does not replace the report payload."],
            surfaces: [
              { file: "src/daemon/app.ts", symbol: "GET /api/reviews/:id", note: "revision-scoped detail" },
              { file: "src/ui/pr-review/pr-review-screen.tsx", symbol: "PrReviewScreen", note: "one adapter snapshot boundary" },
            ],
          },
        ],
      },
    },
  },
  quizzes: quizzes.slice(0, 3),
  threads,
};

export const knowledgeMarkdown = `# Project knowledge

## Preferences
- Lead with the invariant, then show the storage boundary.
- Group code causally rather than by diff order.

## Demonstrated concepts
- Session registry lifecycle and terminal statuses.
- Append-only evidence vs current summaries.
- React external subscriptions with useSyncExternalStore.

## Needs reinforcement
- Report knowledge snapshot ownership across revisions.
- Same-repository worktree routing after explicit comment escalation.

## Code exposure
- src/daemon/review-store.ts#beginRevision
- src/ui/pr-review/quiz-card.tsx#QuizCard
`;

export const userKnowledgeMarkdown = `# User knowledge

## Preferences
- Explain the invariant before implementation details.
- Prefer open-ended checks over recognition-based questions.

## Demonstrated concepts
- TypeScript API boundaries and React external stores.
- Transactional storage and append-only audit logs.

## Needs reinforcement
- Distinguishing code exposure from demonstrated understanding.
`;

export const newerKnowledgeMarkdown = knowledgeMarkdown.replace(
  "## Needs reinforcement",
  "## Demonstrated concepts added by another review\n- Canonical GitHub repository identity.\n\n## Needs reinforcement",
);
