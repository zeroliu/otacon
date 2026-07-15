---
type: otacon-pr-review
version: 1
session: otc_test01
revision: 1
pr: github.com/acme/app#42
head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
knowledge-snapshot: 0000000000000000000000000000000000000000000000000000000000000000
altitude: balanced
---

## Background

The report used to read mutable profile knowledge while the reviewer was still learning.
That made the explanation difficult to reproduce after a quiz changed the profile.

## Intuition

Treat each report revision as a labeled photograph of the knowledge that shaped it.
New evidence changes the next photograph, never the report that produced the evidence.

## Code

Read the public contract before following the runtime handoff and storage boundary.

### Interface changes — Frozen snapshot contract

**Purpose:** Make the report's frozen knowledge input explicit to every caller.
**Changed behavior:** Revisions now point at a copied snapshot instead of mutable profile state.
**Surfaces:** `src/shared/review.ts#ReviewKnowledgeSnapshot`

The revision contract owns the snapshot hash that personalized the explanation.

```ts
interface ReviewRevision {
  snapshotHash: string;
}
```

### Integration path — Capture before publication

**Purpose:** Follow one immutable snapshot across the report publication boundary.
**Changed behavior:** Submission verifies snapshot ownership before exposing the report to readers.
**Surfaces:** `src/daemon/app.ts#submitReview`

The daemon captures knowledge first, then accepts the report and quiz for that identity.

### Implementation walkthrough — Atomic revision storage

**Purpose:** Inspect the crash-safe boundary that keeps report and quiz revisions aligned.
**Changed behavior:** The report and its quiz become visible together after one durable commit.
**Surfaces:** `src/daemon/review-store.ts#submit`

The store publishes one immutable revision directory only after both companions validate.

## Quiz

Explain the boundary in your own words, then confirm the caller-visible consequence.
