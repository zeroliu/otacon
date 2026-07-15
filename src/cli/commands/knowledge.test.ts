import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CanonicalGitHubRepo } from "../../shared/knowledge.js";
import { canonicalizeGitHubRepo } from "../../shared/knowledge.js";
import type { ApiResponse } from "../client.js";
import { CliError } from "../output.js";
import { knowledgeCommand, type KnowledgeCommandDeps } from "./knowledge.js";

let output: string[];
let originalWrite: typeof process.stdout.write;
let requests: Array<{ method: string; path: string; body?: unknown }>;
let response: ApiResponse;
let files: Record<string, string>;
let identity: CanonicalGitHubRepo | undefined;

beforeEach(() => {
  output = [];
  requests = [];
  files = { "/repo/summary.md": "# User knowledge\n" };
  identity = canonicalizeGitHubRepo("Acme/App");
  response = {
    status: 200,
    body: {
      document: {
        scope: "project",
        repo: "acme/app",
        path: "/home/.otacon/knowledge/projects/github.com/acme/app/knowledge.md",
        markdown: "# Project knowledge\n",
        hash: "a".repeat(64),
      },
    },
  };
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
});

function deps(): KnowledgeCommandDeps {
  return {
    ensureDaemon: async () => undefined,
    api: async (method, path, body) => {
      requests.push({ method, path, ...(body === undefined ? {} : { body }) });
      return response;
    },
    readFile: (path) => {
      const value = files[path];
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
    cwd: () => "/repo",
    projectIdentity: () => identity,
  };
}

const printed = () => JSON.parse(output.join("").trim()) as Record<string, unknown>;

describe("knowledge get", () => {
  test("prints one JSON line and sends the canonical project key", async () => {
    expect(await knowledgeCommand(["get", "--scope", "project", "--repo", "/clone"], deps())).toBe(0);
    expect(requests).toEqual([{
      method: "GET",
      path: "/api/knowledge?scope=project&repo=acme%2Fapp",
    }]);
    expect(printed()).toEqual({ ok: true, ...response.body });
  });

  test("user scope needs no repo identity", async () => {
    identity = undefined;
    expect(await knowledgeCommand(["get", "--scope", "user"], deps())).toBe(0);
    expect(requests[0]?.path).toBe("/api/knowledge?scope=user");
  });

  test("project scope refuses a clone without a GitHub origin", async () => {
    identity = undefined;
    expect(knowledgeCommand(["get", "--scope", "project"], deps())).rejects.toMatchObject({
      code: "E_GITHUB_REPO",
      exitCode: 1,
    } satisfies Partial<CliError>);
  });
});

describe("knowledge put", () => {
  test("reads --file and forwards the base hash", async () => {
    expect(await knowledgeCommand([
      "put",
      "--scope", "project",
      "--file", "summary.md",
      "--base-hash", "b".repeat(64),
    ], deps())).toBe(0);
    expect(requests[0]).toEqual({
      method: "PUT",
      path: "/api/knowledge",
      body: {
        scope: "project",
        repo: "acme/app",
        markdown: "# User knowledge\n",
        baseHash: "b".repeat(64),
      },
    });
  });

  test("surfaces conflict code and current disk document", async () => {
    response = {
      status: 409,
      body: {
        error: { code: "E_KNOWLEDGE_CONFLICT", message: "changed" },
        document: { markdown: "newer", hash: "c".repeat(64) },
      },
    };
    let caught: unknown;
    try {
      await knowledgeCommand([
        "put", "--scope", "project", "--file", "summary.md", "--base-hash", "b".repeat(64),
      ], deps());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "E_KNOWLEDGE_CONFLICT",
      extra: { document: response.body.document },
    });
  });

  test("missing flags are usage errors and an unreadable file is actionable", async () => {
    expect(knowledgeCommand(["put", "--scope", "user"], deps())).rejects.toMatchObject({
      code: "E_USAGE",
      exitCode: 2,
    });
    expect(knowledgeCommand([
      "put", "--scope", "user", "--file", "missing.md", "--base-hash", "a".repeat(64),
    ], deps())).rejects.toMatchObject({ code: "E_FILE", exitCode: 1 });
  });
});

test("unknown subcommand and scope are usage errors", async () => {
  expect(knowledgeCommand(["delete", "--scope", "user"], deps())).rejects.toMatchObject({ code: "E_USAGE" });
  expect(knowledgeCommand(["get", "--scope", "team"], deps())).rejects.toMatchObject({ code: "E_USAGE" });
});
