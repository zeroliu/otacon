// The grill-question spec: the one shape + validator behind
// `otacon ask`. The CLI validates client-side (single flag form and --batch)
// so the agent fixes its invocation before the daemon sees it; the daemon
// re-validates as the trust boundary. Keeping both layers on this single
// definition is what stops them drifting — a payload one accepts the other
// accepts, with no "passes the CLI, 400s at the daemon" surprises.

/** One question for `otacon ask` (a single ask or a --batch member). */
export interface QuestionSpec {
  question: string;
  /** Option labels in the agent's order; the UI puts `recommend` first. */
  options?: string[];
  recommend?: string;
  multi?: boolean;
}

/**
 * Validate one question body: returns the normalized spec, or an error message
 * string (no flag/index context — callers prefix their own). Normalization
 * drops an absent options/recommend and a `multi:false` so the stored shape is
 * canonical (the daemon maps the string to a 400; the CLI to a usage error).
 */
export function parseQuestionSpec(raw: unknown): QuestionSpec | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "must be a question object";
  }
  const { question, options, recommend, multi } = raw as Record<string, unknown>;
  if (typeof question !== "string" || question.trim() === "") {
    return "question must be a non-empty string";
  }
  if (options !== undefined) {
    const ok =
      Array.isArray(options) &&
      options.length >= 2 &&
      options.every((o) => typeof o === "string" && o.trim() !== "") &&
      new Set(options).size === options.length;
    if (!ok) return "options must be 2+ distinct non-empty strings";
  }
  if (recommend !== undefined) {
    if (!Array.isArray(options) || typeof recommend !== "string" || !options.includes(recommend)) {
      return "recommend must name one of the options";
    }
  }
  if (multi !== undefined && (typeof multi !== "boolean" || (multi && options === undefined))) {
    return "multi must be a boolean and requires options";
  }
  return {
    question,
    ...(options !== undefined ? { options: options as string[] } : {}),
    ...(recommend !== undefined ? { recommend: recommend as string } : {}),
    ...(multi === true ? { multi: true } : {}),
  };
}
