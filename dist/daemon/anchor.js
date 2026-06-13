// Re-anchoring across revisions (DESIGN.md §4): when a new revision is
// accepted, every thread's text quote is re-located in the new plan. The
// ladder is strict-to-fuzzy: raw exact match → prefix/suffix-scored
// disambiguation → normalized match (whitespace collapsed, markdown emphasis
// markers stripped — quotes come from *rendered* text, the plan is markdown
// source). A unique match re-anchors, possibly rewriting the anchor to the
// new revision's text; no match or an ambiguous one orphans the thread —
// never a guess, never a drop (DECISIONS.md "Re-anchoring ladder").
import { segmentPlan } from "./diff.js";
/** How much context to capture when an anchor is rewritten from the new text. */
const CONTEXT_CHARS = 32;
/** Markdown emphasis/code markers that exist in source but not in rendered text. */
const MARKER = /[*_`]/;
/** Collapse whitespace runs to single spaces and drop emphasis markers, with an index map. */
export function normalize(raw) {
    let text = "";
    const map = [];
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (MARKER.test(ch))
            continue;
        if (/\s/.test(ch)) {
            if (text.endsWith(" ") || text === "")
                continue;
            text += " ";
        }
        else {
            text += ch;
        }
        map.push(i);
    }
    if (text.endsWith(" ")) {
        text = text.slice(0, -1);
        map.pop();
    }
    return { text, map };
}
function findAll(haystack, needle) {
    const hits = [];
    for (let idx = haystack.indexOf(needle); idx !== -1; idx = haystack.indexOf(needle, idx + 1)) {
        hits.push(idx);
    }
    return hits;
}
function longestCommonSuffix(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n])
        n++;
    return n;
}
function longestCommonPrefix(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n])
        n++;
    return n;
}
/** Prefix/suffix assist: how well the stored context matches around a candidate. */
function contextScore(anchor, text, candidate) {
    const before = normalize(text.slice(Math.max(0, candidate.start - 256), candidate.start)).text;
    const after = normalize(text.slice(candidate.end, candidate.end + 256)).text;
    const prefix = normalize(anchor.prefix ?? "").text;
    const suffix = normalize(anchor.suffix ?? "").text;
    return longestCommonSuffix(prefix, before) + longestCommonPrefix(suffix, after);
}
/**
 * Pick the one candidate the evidence singles out: a strictly best context
 * score wins; failing that, a single candidate in the anchor's original
 * section wins; anything still ambiguous is undefined (→ orphaned).
 */
function disambiguate(anchor, candidates) {
    if (candidates.length === 1)
        return candidates[0]?.candidate;
    const scored = candidates.map(({ candidate, text }) => ({
        candidate,
        score: contextScore(anchor, text, candidate),
    }));
    scored.sort((a, b) => b.score - a.score);
    const [best, second] = scored;
    if (best && (!second || best.score > second.score))
        return best.candidate;
    const inSection = scored.filter((s) => s.candidate.unit.id === anchor.section);
    return inSection.length === 1 ? inSection[0]?.candidate : undefined;
}
/**
 * Re-locate one anchor in a (linted, stored) plan revision. Anchors without a
 * quote only need their section to still exist; quoted anchors walk the
 * match ladder. A normalized (fuzzy) match rewrites the anchor to the new
 * revision's raw text so the quote tracks the plan. Callers re-locating many
 * anchors in the same plan pass the segmented `units` once instead of paying
 * a full plan parse per anchor.
 */
export function relocateAnchor(anchor, plan, units = segmentPlan(plan)) {
    const exact = anchor.exact ?? "";
    if (exact.trim() === "") {
        return units.some((u) => u.id === anchor.section)
            ? { state: "anchored", anchor }
            : { state: "orphaned" };
    }
    // Rung 1: raw occurrences of the quote, anywhere in the plan.
    const raw = [];
    for (const unit of units) {
        const text = unit.lines.join("\n");
        for (const start of findAll(text, exact)) {
            raw.push({ candidate: { unit, start, end: start + exact.length }, text });
        }
    }
    if (raw.length > 0) {
        const match = disambiguate(anchor, raw);
        return match
            ? { state: "anchored", anchor: { ...anchor, section: match.unit.id } }
            : { state: "orphaned" };
    }
    // Rung 2: normalized match — whitespace reflow and emphasis markers forgiven.
    const needle = normalize(exact).text;
    if (needle === "")
        return { state: "orphaned" };
    const fuzzy = [];
    for (const unit of units) {
        const text = unit.lines.join("\n");
        const norm = normalize(text);
        for (const idx of findAll(norm.text, needle)) {
            const start = norm.map[idx];
            const end = norm.map[idx + needle.length - 1] + 1;
            fuzzy.push({ candidate: { unit, start, end }, text, norm });
        }
    }
    if (fuzzy.length === 0)
        return { state: "orphaned" };
    const match = disambiguate(anchor, fuzzy);
    if (!match)
        return { state: "orphaned" };
    const text = match.unit.lines.join("\n");
    // Rewrite the anchor to the matched raw text: the stored quote must mean
    // something in the revision the user is now looking at.
    const rewritten = {
        section: match.unit.id,
        exact: text.slice(match.start, match.end),
        prefix: normalize(text.slice(Math.max(0, match.start - CONTEXT_CHARS), match.start)).text,
        suffix: normalize(text.slice(match.end, match.end + CONTEXT_CHARS)).text,
    };
    return { state: "anchored", anchor: rewritten };
}
//# sourceMappingURL=anchor.js.map