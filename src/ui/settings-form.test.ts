// Pins the Settings save-payload logic (mirrors settings.test.ts — pure, no DOM,
// runs under tsconfig.test.json/bun). The schema fixtures are a trimmed stand-in
// for CONFIG_SCHEMA: the form logic only reads section/key/type/default/min.

import { describe, expect, test } from "bun:test";
import type { ConfigField, ScopeValues } from "../shared/config.js";
import {
  buildPayload,
  clearField,
  errorsByField,
  fieldState,
  initFormState,
  isModified,
  parseFieldInput,
  setFieldBool,
  setFieldText,
} from "./settings-form.js";

const summaryLines: ConfigField = {
  section: "budgets",
  key: "summaryLines",
  label: "Summary lines",
  type: "int",
  default: 5,
  min: 1,
};
const cap: ConfigField = {
  section: "activity",
  key: "cap",
  label: "Activity feed cap",
  type: "int",
  default: 20,
  min: 1,
};
const desktop: ConfigField = {
  section: "notifications",
  key: "desktop",
  label: "Desktop notifications",
  type: "bool",
  default: true,
};
const worktreeDir: ConfigField = {
  section: "worktree",
  key: "dir",
  label: "Worktree directory",
  type: "path",
  default: ".otacon/worktrees",
};

const schema = [summaryLines, cap, desktop, worktreeDir];

describe("buildPayload — replace semantics", () => {
  test("the approved case: only summaryLines=8 set → exactly {budgets:{summaryLines:8}}", () => {
    // A User form where every field is unset, then the user sets summaryLines=8.
    let form = initFormState(schema, {});
    form = setFieldText(form, summaryLines, "8");
    expect(buildPayload(form, schema)).toEqual({ budgets: { summaryLines: 8 } });
  });

  test("a seeded override survives an unrelated edit (still in the payload)", () => {
    // cap=30 comes seeded; the user edits summaryLines. Both must be sent — POST
    // replaces the file, so omitting cap would wipe the existing override.
    const seeded: ScopeValues = { activity: { cap: 30 } };
    let form = initFormState(schema, seeded);
    form = setFieldText(form, summaryLines, "8");
    expect(buildPayload(form, schema)).toEqual({
      activity: { cap: 30 },
      budgets: { summaryLines: 8 },
    });
  });

  test("clearing a seeded field omits it (reverts to inherited/default)", () => {
    const seeded: ScopeValues = { activity: { cap: 30 }, budgets: { summaryLines: 8 } };
    let form = initFormState(schema, seeded);
    form = clearField(form, cap);
    expect(buildPayload(form, schema)).toEqual({ budgets: { summaryLines: 8 } });
  });

  test("a bool explicitly set to false is sent as false; a reset bool is omitted", () => {
    // desktop seeded true → user toggles it off → false is a real override.
    let form = initFormState(schema, { notifications: { desktop: true } });
    form = setFieldBool(form, desktop, false);
    expect(buildPayload(form, schema)).toEqual({ notifications: { desktop: false } });

    // Reset to inherit → omitted entirely (not sent as the default).
    form = clearField(form, desktop);
    expect(buildPayload(form, schema)).toEqual({});
  });

  test("an empty/whitespace path is treated as unset (omitted)", () => {
    let form = initFormState(schema, {});
    form = setFieldText(form, worktreeDir, "   ");
    expect(buildPayload(form, schema)).toEqual({});
    // A real path trims and is included.
    form = setFieldText(form, worktreeDir, "  build/wt  ");
    expect(buildPayload(form, schema)).toEqual({ worktree: { dir: "build/wt" } });
  });

  test("an int cleared to empty text is omitted even though the row is 'set'", () => {
    let form = initFormState(schema, { budgets: { summaryLines: 8 } });
    form = setFieldText(form, summaryLines, "");
    expect(buildPayload(form, schema)).toEqual({});
  });

  test("an all-unset form yields an empty payload (every override removed)", () => {
    const form = initFormState(schema, {});
    expect(buildPayload(form, schema)).toEqual({});
  });
});

describe("initFormState + setters", () => {
  test("seeds set-ness and live values from the sparse scope", () => {
    const form = initFormState(schema, {
      budgets: { summaryLines: 8 },
      notifications: { desktop: false },
    });
    expect(fieldState(form, summaryLines)).toEqual({ set: true, bool: false, text: "8" });
    expect(fieldState(form, desktop)).toEqual({ set: true, bool: false, text: "" });
    // unset fields fall back to the schema default for their live control value
    expect(fieldState(form, cap)).toEqual({ set: false, bool: false, text: "" });
    expect(fieldState(form, desktop).set).toBe(true);
  });

  test("an unset bool seeds its live value from the default", () => {
    const form = initFormState(schema, {});
    expect(fieldState(form, desktop)).toEqual({ set: false, bool: true, text: "" });
  });

  test("clearField resets a bool's live value to its default", () => {
    let form = initFormState(schema, { notifications: { desktop: false } });
    form = clearField(form, desktop);
    const fs = fieldState(form, desktop);
    expect(fs.set).toBe(false);
    expect(fs.bool).toBe(true); // back to the default
  });
});

describe("parseFieldInput", () => {
  test("coerces per type and omits empties / non-finite ints", () => {
    expect(parseFieldInput(summaryLines, { set: true, bool: false, text: "12" })).toBe(12);
    expect(parseFieldInput(summaryLines, { set: true, bool: false, text: "" })).toBeNull();
    expect(parseFieldInput(summaryLines, { set: true, bool: false, text: "abc" })).toBeNull();
    expect(parseFieldInput(desktop, { set: true, bool: false, text: "" })).toBe(false);
    expect(parseFieldInput(worktreeDir, { set: true, bool: false, text: "  a/b " })).toBe("a/b");
    expect(parseFieldInput(worktreeDir, { set: true, bool: false, text: "  " })).toBeNull();
  });
});

describe("isModified", () => {
  test("flags set-ness flips, value edits, and clears", () => {
    const seeded = initFormState(schema, { budgets: { summaryLines: 8 } });
    expect(isModified(seeded, seeded, summaryLines)).toBe(false);

    const edited = setFieldText(seeded, summaryLines, "9");
    expect(isModified(edited, seeded, summaryLines)).toBe(true);

    const newlySet = setFieldText(seeded, cap, "30");
    expect(isModified(newlySet, seeded, cap)).toBe(true);

    const cleared = clearField(seeded, summaryLines);
    expect(isModified(cleared, seeded, summaryLines)).toBe(true);
  });
});

describe("errorsByField", () => {
  test("maps section.key → message for inline display", () => {
    const map = errorsByField([
      { section: "budgets", key: "summaryLines", message: "invalid value for budgets.summaryLines" },
      { section: "activity", key: "cap", message: "invalid value for activity.cap" },
    ]);
    expect(map.get("budgets.summaryLines")).toBe("invalid value for budgets.summaryLines");
    expect(map.get("activity.cap")).toBe("invalid value for activity.cap");
    expect(map.get("notifications.desktop")).toBeUndefined();
  });
});
