// The Settings screen's save-payload logic, kept
// React-free + co-located-tested like settings.ts: the screen wires this to the
// DOM, the unit tests pin the semantics. The form models the *complete desired
// set of overrides* for the active scope, because POST /api/config REPLACES the
// scope file with the posted sparse values — a field absent from the payload is
// removed from the file and reverts to inherited/default.

import type { ConfigField, ScopeFieldError, ScopeValues } from "../shared/config.js";

/**
 * One field's editor state. `set:false` is "inherit" — the field is absent from
 * the payload (reverts to the default). `set:true` carries the override the form
 * holds:
 *   - int  → the raw `<input type=number>` string (parsed/validated on build).
 *   - bool → a real boolean, so a tri-state override can be explicitly `false`
 *            AND distinct from "inherit" (a plain checkbox can't express that).
 *   - path → the raw text (trimmed on build; empty/whitespace → omitted).
 * Storing ints/paths as strings keeps the input controlled and round-trips an
 * in-progress edit ("" / "abc") without coercing mid-keystroke.
 */
export interface FieldState {
  set: boolean;
  /** Live boolean for a `bool` field; ignored for other types. */
  bool: boolean;
  /** Live raw text for an `int`/`path` field; ignored for `bool`. */
  text: string;
}

/** Per-field editor state, keyed by `section.key` (the schema's stable id). */
export type FormState = Record<string, FieldState>;

/** The "inherit, no override" state — the fallback for an unseeded field. */
const EMPTY_FIELD_STATE: FieldState = { set: false, bool: false, text: "" };

/**
 * The stable lookup key for a field — also how field errors are addressed.
 * Accepts a `ConfigField` or a `ScopeFieldError` (anything with section + key);
 * `section` is widened to `string` so a 422 error can be keyed the same way.
 */
export function fieldId(field: { section: string; key: string }): string {
  return `${field.section}.${field.key}`;
}

/**
 * Seed the form from a scope's sparse `values`: every schema field gets an
 * entry, `set` only where the scope already overrides it. A seeded override
 * survives unrelated edits because it starts `set:true` and is re-emitted by
 * `buildPayload` unless the user clears it.
 */
export function initFormState(schema: ConfigField[], values: ScopeValues | undefined): FormState {
  const state: FormState = {};
  for (const field of schema) {
    const section = values?.[field.section] as Record<string, unknown> | undefined;
    const has = section !== undefined && field.key in section;
    const raw = has ? section[field.key] : undefined;
    state[fieldId(field)] =
      field.type === "bool"
        ? { set: has, bool: has ? Boolean(raw) : Boolean(field.default), text: "" }
        : { set: has, bool: false, text: has ? String(raw) : "" };
  }
  return state;
}

/** Read one field's state (callers pass the field, not the raw id). */
export function fieldState(form: FormState, field: ConfigField): FieldState {
  return form[fieldId(field)] ?? EMPTY_FIELD_STATE;
}

/**
 * Edit an int/path field: typing sets it. A `path` cleared to empty/whitespace
 * stays `set:true` here (so the input keeps focus and isn't yanked to the
 * placeholder mid-edit) but `buildPayload` omits it — empty text means unset.
 * An int's emptied input is likewise held as `set` text:"" and omitted on build.
 */
export function setFieldText(form: FormState, field: ConfigField, text: string): FormState {
  return { ...form, [fieldId(field)]: { set: true, bool: false, text } };
}

/** Toggle a bool field: an explicit choice always marks it `set` (true or false). */
export function setFieldBool(form: FormState, field: ConfigField, value: boolean): FormState {
  return { ...form, [fieldId(field)]: { set: true, bool: value, text: "" } };
}

/**
 * Reset a field to inherit: `set:false` drops it from the payload, so POST
 * removes it from the file and the schema default applies again. The live value
 * is reset to the default so the control reflects what will be inherited.
 */
export function clearField(form: FormState, field: ConfigField): FormState {
  const cleared: FieldState =
    field.type === "bool"
      ? { set: false, bool: Boolean(field.default), text: "" }
      : { set: false, bool: false, text: "" };
  return { ...form, [fieldId(field)]: cleared };
}

/** A field is "modified" vs the seeded scope if its set-ness or value changed. */
export function isModified(form: FormState, seeded: FormState, field: ConfigField): boolean {
  const now = fieldState(form, field);
  const was = fieldState(seeded, field);
  if (now.set !== was.set) return true;
  if (!now.set) return false; // both unset
  return field.type === "bool" ? now.bool !== was.bool : now.text.trim() !== was.text.trim();
}

/**
 * Coerce one set field's live value to its typed payload value, or `null` to
 * omit it. `int` parses the raw string to a finite number (NaN/empty → omit; the
 * daemon still validates range/min and answers 422). `path` trims (empty →
 * omit). `bool` passes the live boolean through (false is a real override).
 */
export function parseFieldInput(field: ConfigField, fs: FieldState): number | boolean | string | null {
  switch (field.type) {
    case "bool":
      return fs.bool;
    case "int": {
      const trimmed = fs.text.trim();
      if (trimmed === "") return null;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    case "path": {
      const trimmed = fs.text.trim();
      return trimmed === "" ? null : trimmed;
    }
  }
}

/**
 * Build the exact POST body: the sparse nested `{ section: { key: value } }` of
 * ONLY the fields the form holds as set (seeded overrides the user kept PLUS
 * anything they edited), MINUS any field cleared to inherit or emptied. This is
 * the complete desired override set — because POST replaces the file, anything
 * omitted here is removed from disk and inherits the default.
 */
export function buildPayload(form: FormState, schema: ConfigField[]): ScopeValues {
  const out: Record<string, Record<string, unknown>> = {};
  for (const field of schema) {
    const fs = fieldState(form, field);
    if (!fs.set) continue;
    const value = parseFieldInput(field, fs);
    if (value === null) continue;
    (out[field.section] ??= {})[field.key] = value;
  }
  return out as ScopeValues;
}

/**
 * Index a 422's field errors by `section.key` for inline display next to each
 * input. A later error for the same field wins (the daemon reports one per key).
 */
export function errorsByField(fieldErrors: ScopeFieldError[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const err of fieldErrors) map.set(fieldId(err), err.message);
  return map;
}
