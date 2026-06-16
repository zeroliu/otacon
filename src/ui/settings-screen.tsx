// The /settings screen (DESIGN.md §6 config surface): toggle User | Project |
// Project · local scope, pick the Project repo, surface the exact target file the
// scope writes, and render every config field with its current value (schema
// default shown as the placeholder when unset). Each field surfaces what it
// inherits when unset, mirroring the overlay order defaults ← user ← project ←
// project.local (§16). Edits auto-save (DECISIONS.md "Settings auto-saves
// on blur"): a text/number field commits when it loses focus, a checkbox and a
// reset commit on the spot, so there is no Save button to forget. Each save posts a
// *sparse* payload (settings-form.buildPayload) that REPLACES the scope file, so
// the form always models the complete desired override set. Saves are single-
// flighted so rapid edits can't land out of order; 422 errors render inline; each
// field can be reset to inherit (cleared from the payload).

import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConfigField, ConfigScope, ConfigScopeName } from "./api";
import { saveConfig, useConfig, useSessions } from "./api";
import { linkClick } from "./router";
import type { InheritedValue, OverrideScope, ParentScope } from "./settings";
import { distinctRepos, fieldsBySection, inheritedValue, overriddenBy } from "./settings";
import type { FormState } from "./settings-form";
import {
  buildPayload,
  clearField,
  errorsByField,
  fieldId,
  fieldState,
  initFormState,
  isModified,
  setFieldBool,
  setFieldText,
} from "./settings-form";

type Scope = ConfigScopeName;

/** Whether a scope writes a repo-relative file (vs the global user file). */
function isProjectScope(scope: Scope): boolean {
  return scope === "project" || scope === "project.local";
}

/** The `?repo=` query param, decoded — the screen defaults the Project repo to it. */
function repoFromQuery(): string {
  return new URLSearchParams(window.location.search).get("repo") ?? "";
}

export function SettingsScreen() {
  const [scope, setScope] = useState<Scope>("user");
  // Default the Project repo to ?repo= when present, else let the user pick one.
  const [projectRepo, setProjectRepo] = useState<string>(() => repoFromQuery());

  const { sessions } = useSessions();
  const repos = useMemo(() => distinctRepos(sessions), [sessions]);

  // Fetch the project scopes alongside the user scope whenever a repo is chosen —
  // not just on a project tab. Each scope needs the others to show inheritance:
  // the User tab flags fields a project (or project·local) overrides; the Project
  // tab shows the user value as its default and flags a project·local override;
  // the Project·local tab inherits project, then user, then the schema default.
  // An empty repo omits the param, so the daemon answers with the user scope alone.
  const repoForFetch = projectRepo !== "" ? projectRepo : undefined;
  const { schema, scopes, loading, error } = useConfig(repoForFetch);

  // The scope file being edited. Project scopes only resolve once an *absolute*
  // repo comes back from the daemon (it omits them otherwise), so a
  // picked-but-unresolvable repo lands here as undefined.
  const target =
    scope === "user" ? scopes?.user : scope === "project" ? scopes?.project : scopes?.["project.local"];

  // The inheritance chain the active scope sits atop, highest-precedence first
  // (mirroring the file overlay defaults ← user ← project ← project.local): the
  // first ancestor that sets a field is its effective default. User has none;
  // Project inherits User; Project·local inherits Project then User.
  const userParent: ParentScope = { from: "user", values: scopes?.user?.values };
  const projectParent: ParentScope = { from: "project", values: scopes?.project?.values };
  const parents: ParentScope[] =
    scope === "user" ? [] : scope === "project" ? [userParent] : [projectParent, userParent];

  // The scopes that shadow the active one's value (those above it in precedence),
  // highest-precedence first, so the active view can flag an overridden field.
  // User is shadowed by project·local then project; Project by project·local;
  // Project·local by nothing (it's the top layer).
  const overriders: OverrideScope[] =
    scope === "user"
      ? [
          { by: "project.local", values: scopes?.["project.local"]?.values },
          { by: "project", values: scopes?.project?.values },
        ]
      : scope === "project"
        ? [{ by: "project.local", values: scopes?.["project.local"]?.values }]
        : [];

  return (
    <div className="page">
      <header className="settings-head">
        <a className="backlink" href="/" onClick={linkClick("/")}>
          ← sessions
        </a>
        <h1 className="settings-title">settings</h1>
      </header>

      <ScopeToggle scope={scope} onScope={setScope} />

      <RepoPicker scope={scope} repos={repos} value={projectRepo} onChange={setProjectRepo} />

      {error ? (
        <p className="settings-error">couldn't load config — is otacond running?</p>
      ) : isProjectScope(scope) && projectRepo === "" ? (
        <p className="settings-inert">Pick a repo to edit project config.</p>
      ) : loading || schema === undefined ? (
        <p className="loading">loading config…</p>
      ) : target === undefined ? (
        <p className="settings-inert">No project config for this repo — it must be an absolute path.</p>
      ) : (
        <ScopeFields
          key={`${scope}:${repoForFetch ?? ""}`}
          schema={schema}
          target={target}
          scope={scope}
          repo={isProjectScope(scope) ? target.repo : undefined}
          parents={parents}
          overriders={overriders}
        />
      )}
    </div>
  );
}

/** The display label for each scope tab — `project.local` reads "project · local". */
const SCOPE_LABEL: Record<Scope, string> = {
  user: "user",
  project: "project",
  "project.local": "project · local",
};

/**
 * The User | Project | Project · local segmented control — drives which scope
 * file is edited, in file-overlay precedence (user lowest, project·local highest).
 */
function ScopeToggle({ scope, onScope }: { scope: Scope; onScope: (s: Scope) => void }) {
  return (
    <div className="scope-toggle" role="tablist" aria-label="config scope">
      {(["user", "project", "project.local"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={scope === value}
          className={scope === value ? "scope-tab active" : "scope-tab"}
          onClick={() => onScope(value)}
        >
          {SCOPE_LABEL[value]}
        </button>
      ))}
    </div>
  );
}

/**
 * The repo `<select>`, populated from the open sessions' repos. On a Project
 * scope (committed or ·local) it names the scope file being edited (required).
 * On the User tab the user file is global, so the repo only picks which project
 * to compare against — its overrides surface as "overridden by project" hints —
 * and is optional.
 */
function RepoPicker({
  scope,
  repos,
  value,
  onChange,
}: {
  scope: Scope;
  repos: string[];
  value: string;
  onChange: (repo: string) => void;
}) {
  const forProject = isProjectScope(scope);
  const label = forProject ? "repo" : "compare repo";
  return (
    <label className="repo-picker">
      <span className="repo-picker-label">{label}</span>
      <span className="repo-picker-select">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{forProject ? "— select a repo —" : "— none —"}</option>
          {/* A ?repo= not in the open-session list still needs to be selectable. */}
          {value !== "" && !repos.includes(value) && <option value={value}>{value}</option>}
          {repos.map((repo) => (
            <option key={repo} value={repo}>
              {repo}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

/** The save lifecycle the footer renders from. `saved` is the transient "✓" tick. */
type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * The prominent target-file banner + the editable schema fields for the active
 * scope. Owns the form state (settings-form): `baseline` is what's persisted (it
 * drives the "modified" markers), `form` is the live edit state. Edits auto-save:
 * `commit` (a text/number blur) persists only when something changed; `editAndSave`
 * (a checkbox toggle or a reset) persists immediately. Each save posts the
 * buildPayload sparse body and, on success, advances `baseline` to it rather than
 * re-fetching, since a refetch+reseed would clobber an edit in flight elsewhere.
 * Saves are single-flighted (a save fired mid-flight is queued and runs after),
 * so rapid blurs always converge on the last edit; 422 errors render inline.
 */
function ScopeFields({
  schema,
  target,
  scope,
  repo,
  parents,
  overriders,
}: {
  schema: ConfigField[];
  target: ConfigScope;
  scope: Scope;
  repo: string | undefined;
  parents: ParentScope[];
  overriders: OverrideScope[];
}) {
  const seeded = useMemo(() => initFormState(schema, target.values), [schema, target.values]);
  const [form, setForm] = useState<FormState>(seeded);
  const [baseline, setBaseline] = useState<FormState>(seeded);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());

  // A save's await resolves on the next tick; if the user switched scope/repo
  // meanwhile the parent re-keys (remounts) this component, so guard the
  // post-await setState against the dead instance.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Single-flight guard: `saving` is the in-flight latch, `pending` holds the most
  // recent form that arrived while a save was running (only the latest is kept,
  // since each payload is the complete desired set, so the last one supersedes).
  const saving = useRef(false);
  const pending = useRef<FormState | null>(null);

  // A fresh fetch (a scope/repo switch remounts via key, so this is rare) reseeds
  // both the live form and the persisted baseline, clearing in-flight 422 errors.
  useEffect(() => {
    setForm(seeded);
    setBaseline(seeded);
    setErrors(new Map());
  }, [seeded]);

  const persist = async (next: FormState): Promise<void> => {
    if (saving.current) {
      pending.current = next; // coalesce: the latest desired state wins
      return;
    }
    saving.current = true;
    setStatus({ kind: "saving" });
    const result = await saveConfig(scope, repo, buildPayload(next, schema));
    saving.current = false;
    if (!mounted.current) return;
    if (result.ok) {
      setBaseline(next); // the saved state is now the persisted baseline
      setErrors(new Map());
      setStatus({ kind: "saved" });
    } else if (result.status === 422) {
      setErrors(errorsByField(result.fieldErrors ?? []));
      setStatus({ kind: "error", message: "some fields are invalid — see below" });
    } else {
      setStatus({ kind: "error", message: result.error?.message ?? "save failed" });
    }
    // Flush an edit that arrived mid-flight, so the last change always lands.
    if (pending.current !== null) {
      const queued = pending.current;
      pending.current = null;
      void persist(queued);
    }
  };

  // Clear the transient "saved ✓" tick after a beat (back to idle).
  useEffect(() => {
    if (status.kind !== "saved") return;
    const t = setTimeout(() => setStatus({ kind: "idle" }), 2400);
    return () => clearTimeout(t);
  }, [status]);

  // Typing only updates the live form (the save waits for blur); it also clears a
  // stale saved tick / error banner so the footer reflects the in-progress edit.
  const editField = (next: FormState): void => {
    setForm(next);
    setStatus((s) => (s.kind === "idle" || s.kind === "saving" ? s : { kind: "idle" }));
  };

  // A toggle or a reset is its own commit, so update and persist in one step.
  const editAndSave = (next: FormState): void => {
    setForm(next);
    void persist(next);
  };

  // A text/number field lost focus: persist iff the form differs from what's saved
  // (focus-through with no change must not fire a redundant write).
  const commit = (): void => {
    if (schema.some((field) => isModified(form, baseline, field))) void persist(form);
  };

  return (
    <>
      <div className="path-banner">
        <span className="path-banner-label">writes to</span>
        <code className="path-banner-path">{target.path}</code>
      </div>
      <p className="settings-autosave-note">changes save automatically</p>
      {fieldsBySection(schema).map(({ section, fields }) => (
        <section key={section} className="settings-section">
          <h2 className="settings-section-title">{section}</h2>
          {fields.map((field) => (
            <FieldRow
              key={fieldId(field)}
              field={field}
              state={fieldState(form, field)}
              modified={isModified(form, baseline, field)}
              inherited={inheritedValue(field, parents)}
              overriddenBy={overriddenBy(field, overriders)}
              error={errors.get(fieldId(field))}
              onText={(text) => editField(setFieldText(form, field, text))}
              onCommit={commit}
              onBool={(value) => editAndSave(setFieldBool(form, field, value))}
              onClear={() => editAndSave(clearField(form, field))}
            />
          ))}
        </section>
      ))}
      <SaveToast status={status} />
    </>
  );
}

/**
 * The save lifecycle as a floating toast pinned to the viewport, so the "saving…"
 * / "saved ✓" / error feedback is seen the instant it fires no matter how far the
 * form is scrolled — a field can be edited well above the fold and still confirm.
 * The ambient "changes save automatically" documentation lives inline up top
 * instead; this stays out of the layout at rest. The wrapper is a persistent
 * `aria-live` region (it just toggles visibility) so each state change announces.
 */
function SaveToast({ status }: { status: SaveStatus }) {
  const shown = status.kind !== "idle";
  return (
    <div
      className={`save-toast${shown ? " save-toast-shown" : ""}`}
      role="status"
      aria-live="polite"
    >
      {status.kind === "saving" && <span className="settings-saving">saving…</span>}
      {status.kind === "saved" && <span className="settings-saved">saved ✓</span>}
      {status.kind === "error" && (
        <span className="settings-save-error" role="alert">
          {status.message}
        </span>
      )}
    </div>
  );
}

/** Where a field's inherited default comes from, in human words for the hint. */
const INHERIT_LABEL: Record<"user" | "project", string> = {
  user: "default from user profile",
  project: "default from project",
};

/** Which higher-precedence scope shadows the field, in human words for the hint. */
const OVERRIDE_LABEL: Record<"project" | "project.local", string> = {
  project: "overridden by project",
  "project.local": "overridden by project · local",
};

/**
 * The inherit/override hint under a field's description, at most one at a time.
 * An override wins the slot (a shadowed value matters more than its source):
 * the User view flags a field a project / project·local overrides; the Project
 * view flags a project·local override. Otherwise the inherit hint names the
 * scope the active one's default falls through to — the project for a
 * project·local field, else the user profile (the schema default shows no hint).
 */
function FieldHint({
  inherited,
  overriddenBy,
}: {
  inherited: InheritedValue;
  overriddenBy: "project" | "project.local" | null;
}) {
  if (overriddenBy) {
    return <span className="field-override">{OVERRIDE_LABEL[overriddenBy]}</span>;
  }
  if (inherited.from !== "default") {
    return <span className="field-inherit">{INHERIT_LABEL[inherited.from]}</span>;
  }
  return null;
}

/**
 * One config field: label + description, a type-driven input, an inline error
 * slot, and a reset-to-inherit control (hidden when the field is already
 * inheriting). The input is controlled by the lifted form state. When unset, the
 * field shows its *inherited* value as the placeholder / unchecked fallback —
 * the user profile's override on the Project view, else the schema default.
 */
function FieldRow({
  field,
  state,
  modified,
  inherited,
  overriddenBy,
  error,
  onText,
  onCommit,
  onBool,
  onClear,
}: {
  field: ConfigField;
  state: ReturnType<typeof fieldState>;
  modified: boolean;
  inherited: InheritedValue;
  overriddenBy: "project" | "project.local" | null;
  error: string | undefined;
  onText: (text: string) => void;
  onCommit: () => void;
  onBool: (value: boolean) => void;
  onClear: () => void;
}) {
  const reset = state.set ? (
    <button type="button" className="field-reset" onClick={onClear} title="reset to inherited default">
      reset
    </button>
  ) : null;
  const hint = <FieldHint inherited={inherited} overriddenBy={overriddenBy} />;

  if (field.type === "bool") {
    return (
      <div className={`field-row field-row-bool${modified ? " field-modified" : ""}`}>
        <span className="field-text">
          <span className="field-name">
            {field.label}
            {modified && <span className="field-dot" aria-hidden="true" />}
          </span>
          {field.description && <span className="field-desc">{field.description}</span>}
          {hint}
          {error && <span className="field-error">{error}</span>}
        </span>
        <span className="field-control">
          {reset}
          <input
            className="field-checkbox"
            type="checkbox"
            checked={state.set ? state.bool : Boolean(inherited.value)}
            aria-label={field.label}
            onChange={(e) => onBool(e.target.checked)}
          />
        </span>
      </div>
    );
  }

  const onChange = (e: ChangeEvent<HTMLInputElement>) => onText(e.target.value);
  return (
    <div className={`field-row${modified ? " field-modified" : ""}`}>
      <span className="field-text">
        <span className="field-name">
          {field.label}
          {modified && <span className="field-dot" aria-hidden="true" />}
        </span>
        {field.description && <span className="field-desc">{field.description}</span>}
        {hint}
        {error && <span className="field-error">{error}</span>}
      </span>
      <span className="field-control">
        {reset}
        <input
          className={`field-input${error ? " field-input-invalid" : ""}`}
          type={field.type === "int" ? "number" : "text"}
          inputMode={field.type === "int" ? "numeric" : undefined}
          min={field.type === "int" ? field.min : undefined}
          value={state.set ? state.text : ""}
          placeholder={`default: ${inherited.value}`}
          aria-label={field.label}
          aria-invalid={error ? true : undefined}
          onChange={onChange}
          onBlur={onCommit}
        />
      </span>
    </div>
  );
}
