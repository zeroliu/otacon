import { describe, expect, test } from "bun:test";

import { hashKnowledge } from "../shared/knowledge.js";
import { hashReviewSnapshot } from "./review-snapshot.js";

describe("hashReviewSnapshot", () => {
  test("is stable and sensitive to each frozen scope and project identity", () => {
    const user = hashKnowledge("user\n");
    const otherUser = hashKnowledge("other user\n");
    const project = hashKnowledge("project\n");
    const otherProject = hashKnowledge("other project\n");
    const hash = hashReviewSnapshot(user, "acme/app", project);

    expect(hashReviewSnapshot(user, "acme/app", project)).toBe(hash);
    expect(hashReviewSnapshot(otherUser, "acme/app", project)).not.toBe(hash);
    expect(hashReviewSnapshot(user, "acme/other", project)).not.toBe(hash);
    expect(hashReviewSnapshot(user, "acme/app", otherProject)).not.toBe(hash);
  });
});
