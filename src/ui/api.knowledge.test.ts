import { afterEach, describe, expect, test } from "bun:test";
import { saveKnowledge } from "./api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("knowledge API client", () => {
  test("PUTs the complete project CAS contract and returns the persisted document", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = { url: String(input), init };
      return Response.json({
        document: {
          scope: "project",
          repo: "acme/app",
          path: "/home/knowledge.md",
          markdown: "# Project knowledge\n",
          hash: "a".repeat(64),
        },
      });
    }) as unknown as typeof fetch;

    const result = await saveKnowledge(
      "project",
      "acme/app",
      "# Project knowledge\n",
      "b".repeat(64),
    );

    expect(request?.url).toBe("/api/knowledge");
    expect(request?.init?.method).toBe("PUT");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      scope: "project",
      repo: "acme/app",
      markdown: "# Project knowledge\n",
      baseHash: "b".repeat(64),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(String(result.document.hash)).toBe("a".repeat(64));
  });

  test("returns the current document on a stale-hash conflict", async () => {
    globalThis.fetch = (async () => Response.json({
      error: { code: "E_KNOWLEDGE_CONFLICT", message: "knowledge changed on disk" },
      document: {
        scope: "user",
        path: "/home/user.md",
        markdown: "# User knowledge\n",
        hash: "c".repeat(64),
      },
    }, { status: 409 })) as unknown as typeof fetch;

    const result = await saveKnowledge("user", undefined, "draft", "b".repeat(64));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error.code).toBe("E_KNOWLEDGE_CONFLICT");
      expect(String(result.document?.hash)).toBe("c".repeat(64));
    }
  });

  test("normalizes an unreachable daemon into a typed error", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const result = await saveKnowledge("user", undefined, "draft", "b".repeat(64));
    expect(result).toEqual({
      ok: false,
      status: 0,
      error: { code: "E_UNREACHABLE", message: "couldn't reach otacond" },
    });
  });
});
