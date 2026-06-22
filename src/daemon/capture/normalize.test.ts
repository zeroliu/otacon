import { describe, expect, test } from "bun:test";
import type { StreamConfig } from "../../shared/config.js";
import { DEFAULT_CONFIG } from "../../shared/config.js";
import { normalize, REDACTED, redactSecrets, truncate } from "./normalize.js";

const cfg: StreamConfig = DEFAULT_CONFIG.stream;
const at = "2026-06-21T00:00:00.000Z";

describe("redactSecrets", () => {
  test("strips a bearer token", () => {
    const out = redactSecrets("Authorization: Bearer abc123DEF456ghi789");
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("abc123DEF456ghi789");
  });

  test("strips token= / password= / api_key= pairs", () => {
    expect(redactSecrets("token=s3cr3tValue123")).toBe(REDACTED);
    const out = redactSecrets("--password=hunter2longvalue --verbose");
    expect(out).not.toContain("hunter2longvalue");
    expect(out).toContain("--verbose");
  });

  test("redacts each secret-bearing pair in a printed env", () => {
    const out = redactSecrets("PASSWORD=hunter2longvalue API_KEY=sk-abcdEFGHijklMNOPqrst");
    expect(out).not.toContain("hunter2longvalue");
    expect(out).not.toContain("sk-abcdEFGHijklMNOPqrst");
  });

  test("strips an AWS access key id", () => {
    const out = redactSecrets("aws_access_key_id = AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain(REDACTED);
  });

  test("strips an OpenAI-style sk- key", () => {
    const out = redactSecrets("using sk-proj1234567890abcdefXYZ for the call");
    expect(out).not.toContain("sk-proj1234567890abcdefXYZ");
  });

  test("strips a GitHub token", () => {
    const out = redactSecrets("clone with ghp_0123456789abcdefghijABCDEFGHIJ now");
    expect(out).not.toContain("ghp_0123456789abcdefghijABCDEFGHIJ");
  });

  test("strips a PEM private-key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBdummybase64line1\nMIIBdummybase64line2\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(`key:\n${pem}\nrest`);
    expect(out).not.toContain("MIIBdummybase64line1");
    expect(out).toContain(REDACTED);
    expect(out).toContain("rest");
  });

  test("strips a .env-style KEY=secret with a long mixed value", () => {
    const out = redactSecrets("DATABASE_URL=postgresAbc123Def456Ghi789");
    expect(out).not.toContain("postgresAbc123Def456Ghi789");
  });

  test("leaves ordinary config and prose untouched", () => {
    const benign = "PORT=3000 NODE_ENV=production reading src/auth.ts and running tests";
    expect(redactSecrets(benign)).toBe(benign);
  });
});

describe("truncate", () => {
  test("returns short text unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("caps to max with a trailing ellipsis (total length = max)", () => {
    const out = truncate("abcdefghij", 5);
    expect(out).toHaveLength(5);
    expect(out.endsWith("…")).toBeTrue();
  });

  test("max <= 0 yields empty", () => {
    expect(truncate("abc", 0)).toBe("");
  });

  test("max 1 yields just the ellipsis", () => {
    expect(truncate("abc", 1)).toBe("…");
  });
});

describe("normalize", () => {
  test("stamps seq and at, caps the label, drops a tool field for a highlight", () => {
    const event = normalize({ kind: "highlight", label: "reading", detail: "body" }, cfg, 7, at);
    expect(event.seq).toBe(7);
    expect(event.at).toBe(at);
    expect(event.kind).toBe("highlight");
    expect(event.tool).toBeUndefined();
  });

  test("a tool event keeps its raw tool name and status", () => {
    const event = normalize(
      { kind: "tool", label: "Read src/auth.ts", tool: "Read", status: "ok", detail: "..." },
      cfg,
      1,
      at,
    );
    expect(event.tool).toBe("Read");
    expect(event.status).toBe("ok");
  });

  test("caps an over-long label to labelMaxChars", () => {
    const event = normalize({ kind: "text", label: "x".repeat(500) }, cfg, 1, at);
    expect(event.label.length).toBe(cfg.labelMaxChars);
    expect(event.label.endsWith("…")).toBeTrue();
  });

  test("drops detail entirely when it redacts/truncates to empty", () => {
    const event = normalize({ kind: "text", label: "x", detail: "" }, cfg, 1, at);
    expect(event.detail).toBeUndefined();
  });

  test("a ~5 KB body carrying an API key: secret redacted, body truncated to the cap", () => {
    const secret = "sk-abcdEFGHijklMNOPqrstUVWX1234567890";
    const body = `before ${secret} ` + "X".repeat(5000) + ` token=${secret}`;
    const event = normalize({ kind: "tool", label: "Bash: env", tool: "Bash", detail: body }, cfg, 1, at);
    expect(event.detail).toBeDefined();
    const detail = event.detail as string;
    expect(detail.length).toBeLessThanOrEqual(cfg.detailMaxChars);
    expect(detail).not.toContain(secret);
    expect(detail).toContain(REDACTED);
  });
});
