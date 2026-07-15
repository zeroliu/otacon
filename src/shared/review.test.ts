import { describe, expect, test } from "bun:test";
import type { CanonicalGitHubRepo } from "./knowledge.js";
import {
  parsePullRequestMetadata,
  pullRequestIdentity,
  pullRequestIdentityFromUrl,
} from "./review.js";

const repo = "acme/app" as CanonicalGitHubRepo;

describe("canonical pull request identity", () => {
  test("normalizes a GitHub URL to repository + number", () => {
    expect(pullRequestIdentityFromUrl("https://github.com/Acme/App/pull/42/")).toEqual(
      pullRequestIdentity(repo, 42),
    );
  });

  test("accepts PR tab URLs with trailing segments", () => {
    for (
      const url of [
        "https://github.com/acme/app/pull/42/files",
        "https://github.com/acme/app/pull/42/commits/0123abc",
        "https://github.com/acme/app/pull/42/checks?check_run_id=7",
        "https://github.com/acme/app/pull/42/files#diff-abc123",
      ]
    ) {
      expect(pullRequestIdentityFromUrl(url)).toEqual(pullRequestIdentity(repo, 42));
    }
  });

  test("rejects non-GitHub, issue, and non-positive identities", () => {
    expect(pullRequestIdentityFromUrl("https://gitlab.com/acme/app/pull/42")).toBeUndefined();
    expect(pullRequestIdentityFromUrl("https://github.com/acme/app/issues/42")).toBeUndefined();
    expect(pullRequestIdentityFromUrl("https://github.com/acme/app/pull/0")).toBeUndefined();
    expect(pullRequestIdentityFromUrl("https://github.com/acme/bad%20repo/pull/42")).toBeUndefined();
  });
});

describe("pull request metadata wire decoder", () => {
  const metadata = {
    identity: pullRequestIdentity(repo, 42),
    url: "https://github.com/acme/app/pull/42",
    title: "Typed sessions",
    author: "octo",
    baseRef: "main",
    headRef: "feature",
    headRepository: "octo/app" as CanonicalGitHubRepo,
    headSha: "a".repeat(40),
    state: "open" as const,
    isCrossRepository: true,
    permissions: { maintainerCanModify: false, viewerPermission: "write" as const, readOnly: true },
  };

  test("accepts a self-consistent typed payload", () => {
    expect(parsePullRequestMetadata(metadata)).toEqual(metadata);
  });

  test("rejects an identity which disagrees with the URL", () => {
    expect(parsePullRequestMetadata({
      ...metadata,
      identity: pullRequestIdentity(repo, 41),
    })).toBeUndefined();
  });

  test("rejects a writable claim which disagrees with viewer permission", () => {
    expect(parsePullRequestMetadata({
      ...metadata,
      isCrossRepository: false,
      permissions: { maintainerCanModify: true, viewerPermission: "read", readOnly: false },
    })).toBeUndefined();
  });

  test("rejects null nested objects without throwing", () => {
    expect(parsePullRequestMetadata({ ...metadata, identity: null })).toBeUndefined();
    expect(parsePullRequestMetadata({ ...metadata, permissions: null })).toBeUndefined();
  });

  test("rejects a head SHA that is not exactly 40 hexadecimal characters", () => {
    for (const headSha of ["invalid", "a".repeat(39), "a".repeat(41), "g".repeat(40)]) {
      expect(parsePullRequestMetadata({ ...metadata, headSha })).toBeUndefined();
    }
  });
});
