import type { LintIssue } from "../shared/types.js";
import { type DiagramFence, parsePlan } from "./linter/parse.js";

// Daemon-side mermaid render gate (L8). The UI renders every ```mermaid fence
// with mermaid + DOMPurify at securityLevel "strict"; a fence mermaid cannot
// parse shows up as a broken "failed to render" card. This validator catches
// that at submit time so the agent fixes it before review, instead of the
// reviewer finding a dead diagram. It runs mermaid's own parser headlessly and
// emits one blocking L8 per unparseable fence.
//
// Fail-open: if the headless mermaid setup itself can't be stood up (bad
// import, missing globals, init throw), we return [] rather than wedge every
// submit on an infra problem. A diagram that won't render is a nuisance; a
// linter that won't let anyone submit is a brick wall.

/**
 * The mermaid `parse` surface we depend on: it resolves on valid syntax and
 * rejects/throws on invalid. We avoid importing mermaid's types eagerly (the
 * import is lazy and off the hot path), so this is the minimal shape we call.
 */
interface MermaidParser {
  parse(text: string): Promise<unknown>;
}

// Module-level singleton: stand mermaid up at most once per daemon lifetime.
// `null` resolution = setup failed → fail-open. We cache the *promise* so
// concurrent submits share one init, and we don't re-run the heavy import on
// every call.
let mermaidSetup: Promise<MermaidParser | null> | undefined;

function setupMermaid(): Promise<MermaidParser | null> {
  mermaidSetup ??= (async (): Promise<MermaidParser | null> => {
    try {
      // mermaid reads DOM globals (document/window) during init and parse in
      // Node. happy-dom provides them. Register minimally and defensively —
      // only assign globals that aren't already present, so we never clobber a
      // host (e.g. a test env or bundler) that already supplies a DOM.
      const { Window } = await import("happy-dom");
      const win = new Window();
      const g = globalThis as Record<string, unknown>;
      if (typeof g.window === "undefined") g.window = win;
      if (typeof g.document === "undefined") g.document = win.document;

      const { default: mermaid } = await import("mermaid");
      // Match the UI's strict security level (src/ui/plan/code.tsx) so what we
      // accept here is exactly what the renderer will accept there.
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      return mermaid as unknown as MermaidParser;
    } catch {
      // Setup is unavailable. Don't permanently poison future calls on a
      // transient failure: clear the cache so a later submit can retry, but
      // this call fails open.
      mermaidSetup = undefined;
      return null;
    }
  })();
  return mermaidSetup;
}

/** Collapse a thrown error to one concise line the agent can act on. */
function fenceErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const first = lines[0] ?? "unknown error";
  // mermaid's grammar errors lead with a bare "Parse error on line N:" header and
  // push the actionable detail ("Expecting …, got 'X'") onto the LAST line, with a
  // source excerpt + caret pointer in between. Keep the message one line but carry
  // that detail so the agent knows *what* is wrong, not just *that* something is.
  // Type errors ("No diagram type detected …") are self-contained on the first
  // line, so they pass through untouched.
  const detail =
    /^Parse error on line \d+:?$/.test(first) && lines.length > 1
      ? `${first} ${lines[lines.length - 1]}`
      : first;
  return `Diagram does not render: ${detail}`;
}

/**
 * One blocking L8 lint error per ```mermaid fence that mermaid cannot parse.
 *
 * Returns [] when every fence parses, when the plan has no mermaid fences, or
 * when the headless mermaid setup itself fails (fail-open). Never throws.
 */
export async function validateDiagrams(content: string): Promise<LintIssue[]> {
  const diagrams: DiagramFence[] = parsePlan(content).diagrams;
  // No diagrams → skip the heavy mermaid import entirely.
  if (diagrams.length === 0) return [];

  const mermaid = await setupMermaid();
  if (!mermaid) return []; // fail-open: infra problem must not wedge submit.

  const issues: LintIssue[] = [];
  for (const fence of diagrams) {
    try {
      // mermaid.parse rejects on unparseable input. Empirically (verified in
      // this headless setup) this covers: an unknown diagram type
      // ("No diagram type detected…") and grammar errors ("Parse error on
      // line N…"). A single bad fence must not abort the rest, so we catch
      // per fence and keep going.
      await mermaid.parse(fence.code);
    } catch (err) {
      issues.push({
        rule: "L8",
        code: "E_DIAGRAM_UNRENDERABLE",
        severity: "error",
        line: fence.startLine,
        section: fence.section,
        message: fenceErrorMessage(err),
      });
    }
  }
  return issues;
}
