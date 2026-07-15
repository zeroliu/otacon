import { describe, expect, test } from "bun:test";
import type { CanonicalGitHubRepo } from "../shared/knowledge.js";
import { GitHubResolutionError, localGitHubRepository, resolvePullRequest } from "./github.js";

const repo = "acme/app" as CanonicalGitHubRepo;
const payload = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  title: "Typed sessions",
  author: { login: "octo" },
  baseRefName: "main",
  headRefName: "feature",
  headRefOid: "a".repeat(40),
  headRepository: { nameWithOwner: "octo/app", name: "app" },
  headRepositoryOwner: { login: "octo" },
  state: "OPEN",
  isCrossRepository: true,
  maintainerCanModify: false,
  ...overrides,
});
const permissionPayload = (viewerPermission = "WRITE") => JSON.stringify({ viewerPermission });

describe("local GitHub repository", () => {
  test("canonicalizes the origin clone URL", () => {
    expect(localGitHubRepository("/repo", { run: () => "git@github.com:Acme/App.git" })).toBe(repo);
  });

  test("fails clearly when origin is missing", () => {
    expect(() => localGitHubRepository("/repo", { run: () => { throw new Error("missing"); } }))
      .toThrow(GitHubResolutionError);
  });
});

describe("gh pr view adapter", () => {
  test("resolves a PR number and fork permission fields", () => {
    const calls: string[][] = [];
    const result = resolvePullRequest("42", "/repo", repo, {
      run: (_command, args) => {
        calls.push(args);
        return args[0] === "pr" ? payload() : permissionPayload();
      },
    });
    expect(calls[0]?.slice(0, 5)).toEqual(["pr", "view", "42", "--repo", "acme/app"]);
    expect(calls[1]).toEqual(["repo", "view", "acme/app", "--json", "viewerPermission"]);
    expect(result.identity.key).toBe("github.com/acme/app#42");
    expect(result.headRepository).toBe("octo/app" as CanonicalGitHubRepo);
    expect(result.permissions).toEqual({
      maintainerCanModify: false,
      viewerPermission: "write",
      readOnly: true,
    });
  });

  test("accepts a canonical PR URL", () => {
    expect(resolvePullRequest("https://github.com/acme/app/pull/42", "/repo", repo, {
      run: (_command, args) => args[0] === "pr" ? payload() : permissionPayload(),
    }).identity.number).toBe(42);
  });

  test("keeps a same-repo PR read-only without authenticated push permission", () => {
    const result = resolvePullRequest("42", "/repo", repo, {
      run: (_command, args) => args[0] === "pr"
        ? payload({
            isCrossRepository: false,
            headRepository: { nameWithOwner: "acme/app", name: "app" },
            headRepositoryOwner: { login: "acme" },
          })
        : permissionPayload("READ"),
    });
    expect(result.permissions).toEqual({
      maintainerCanModify: false,
      viewerPermission: "read",
      readOnly: true,
    });
  });

  test("rejects branches and malformed gh output", () => {
    expect(() => resolvePullRequest("feature", "/repo", repo, { run: () => payload() })).toThrow(/number or GitHub PR URL/);
    expect(() => resolvePullRequest("42", "/repo", repo, { run: () => "not-json" })).toThrow(/malformed JSON/);
    expect(() => resolvePullRequest("42", "/repo", repo, { run: () => payload({ number: 41 }) })).toThrow(/inconsistent/);
  });
});
