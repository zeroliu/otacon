// The /settings screen (DESIGN.md §6 config surface): toggle User | Project
// scope, pick the Project repo, surface the exact target file the scope writes,
// and render every config field with its current value (schema default shown as
// the placeholder when unset). Phase 4 makes the fields editable and saveable:
// a Save posts a *sparse* payload (settings-form.buildPayload) that REPLACES the
// scope file, so the form models the complete desired override set. 422 errors
// render inline; each field can be reset to inherit (cleared from the payload).

import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConfigField, ConfigScope } from "./api";
import { saveConfig, useConfig, useSessions } from "./api";
import { linkClick } from "./router";
import { distinctRepos, fieldsBySection } from "./settings";
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

type Scope = "user" | "project";

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

  // Only project scope needs a repo; the GET omits the param (so no project
  // scope comes back) until one is chosen.
  const repoForFetch = scope === "project" && projectRepo !== "" ? projectRepo : undefined;
  const { schema, scopes, loading, error, reload } = useConfig(repoForFetch);

  // The scope file to edit. Project scope only resolves once an *absolute* repo
  // comes back from the daemon (it omits the project scope otherwise), so a
  // picked-but-unresolvable repo lands here as undefined.
  const target = scope === "user" ? scopes?.user : scopes?.project;

  return (
    <div className="page">
      <header className="settings-head">
        <a className="backlink" href="/" onClick={linkClick("/")}>
          ← sessions
        </a>
        <h1 className="settings-title">settings</h1>
      </header>

      <ScopeToggle scope={scope} onScope={setScope} />

      {scope === "project" && (
        <RepoPicker repos={repos} value={projectRepo} onChange={setProjectRepo} />
      )}

      {error ? (
        <p className="settings-error">couldn't load config — is otacond running?</p>
      ) : scope === "project" && projectRepo === "" ? (
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
          repo={scope === "project" ? target.repo : undefined}
          onSaved={reload}
        />
      )}
    </div>
  );
}

/** The User | Project segmented control — drives which scope file is edited. */
function ScopeToggle({ scope, onScope }: { scope: Scope; onScope: (s: Scope) => void }) {
  return (
    <div className="scope-toggle" role="tablist" aria-label="config scope">
      {(["user", "project"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={scope === value}
          className={scope === value ? "scope-tab active" : "scope-tab"}
          onClick={() => onScope(value)}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

/** The Project repo `<select>`, populated from the open sessions' repos. */
function RepoPicker({
  repos,
  value,
  onChange,
}: {
  repos: string[];
  value: string;
  onChange: (repo: string) => void;
}) {
  return (
    <label className="repo-picker">
      <span className="repo-picker-label">repo</span>
      <span className="repo-picker-select">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— select a repo —</option>
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
 * scope, plus the Save action. Owns the form state (settings-form): seeded from
 * the scope's sparse `values`, re-seeded whenever the fetched values change
 * (a save's reload, or a scope/repo switch — the parent also re-keys this
 * component so a switch is a clean remount). Save posts the buildPayload sparse
 * body; 422 errors render inline; each field resets to inherit independently.
 */
function ScopeFields({
  schema,
  target,
  scope,
  repo,
  onSaved,
}: {
  schema: ConfigField[];
  target: ConfigScope;
  scope: Scope;
  repo: string | undefined;
  onSaved: () => void;
}) {
  // The seeded baseline (what's persisted) drives the "modified" markers; `form`
  // is the live edit state. Reseed both when the fetched values change.
  const seeded = useMemo(() => initFormState(schema, target.values), [schema, target.values]);
  const [form, setForm] = useState<FormState>(seeded);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());

  // A save's await resolves on the next tick; if the user switched scope/repo
  // meanwhile the parent re-keys (remounts) this component, so guard the
  // post-await setState + reload against the dead instance.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A save's reload (or a same-component values change) re-seeds the form to the
  // freshly persisted state, clearing in-flight 422 errors.
  useEffect(() => {
    setForm(seeded);
    setErrors(new Map());
  }, [seeded]);

  const onSave = async (): Promise<void> => {
    setStatus({ kind: "saving" });
    const values = buildPayload(form, schema);
    const result = await saveConfig(scope, repo, values);
    if (!mounted.current) return;
    if (result.ok) {
      setErrors(new Map());
      setStatus({ kind: "saved" });
      onSaved(); // re-fetch so displayed values reflect the persisted state
    } else if (result.status === 422) {
      setErrors(errorsByField(result.fieldErrors ?? []));
      setStatus({ kind: "error", message: "some fields are invalid — see below" });
    } else {
      setStatus({ kind: "error", message: result.error?.message ?? "save failed" });
    }
  };

  // Clear the transient "Saved ✓" tick after a beat (back to idle).
  useEffect(() => {
    if (status.kind !== "saved") return;
    const t = setTimeout(() => setStatus({ kind: "idle" }), 2400);
    return () => clearTimeout(t);
  }, [status]);

  const editField = (next: FormState): void => {
    setForm(next);
    // A fresh edit invalidates the saved tick / stale error banner.
    setStatus((s) => (s.kind === "idle" || s.kind === "saving" ? s : { kind: "idle" }));
  };

  return (
    <>
      <div className="path-banner">
        <span className="path-banner-label">writes to</span>
        <code className="path-banner-path">{target.path}</code>
      </div>
      {fieldsBySection(schema).map(({ section, fields }) => (
        <section key={section} className="settings-section">
          <h2 className="settings-section-title">{section}</h2>
          {fields.map((field) => (
            <FieldRow
              key={fieldId(field)}
              field={field}
              state={fieldState(form, field)}
              modified={isModified(form, seeded, field)}
              error={errors.get(fieldId(field))}
              onText={(text) => editField(setFieldText(form, field, text))}
              onBool={(value) => editField(setFieldBool(form, field, value))}
              onClear={() => editField(clearField(form, field))}
            />
          ))}
        </section>
      ))}
      <SaveBar status={status} onSave={onSave} />
    </>
  );
}

/** The sticky-feel save footer: the button plus the saved/error affordance. */
function SaveBar({ status, onSave }: { status: SaveStatus; onSave: () => void }) {
  return (
    <div className="settings-save">
      <button
        type="button"
        className="btn btn-primary settings-save-btn"
        disabled={status.kind === "saving"}
        onClick={onSave}
      >
        {status.kind === "saving" ? "saving…" : "save"}
      </button>
      {status.kind === "saved" && (
        <span className="settings-saved" role="status">
          saved ✓
        </span>
      )}
      {status.kind === "error" && (
        <span className="settings-save-error" role="alert">
          {status.message}
        </span>
      )}
    </div>
  );
}

/**
 * One config field: label + description, a type-driven input, an inline error
 * slot, and a reset-to-inherit control (hidden when the field is already
 * inheriting). The input is controlled by the lifted form state; the schema
 * default shows as the placeholder / unchecked fallback when unset.
 */
function FieldRow({
  field,
  state,
  modified,
  error,
  onText,
  onBool,
  onClear,
}: {
  field: ConfigField;
  state: ReturnType<typeof fieldState>;
  modified: boolean;
  error: string | undefined;
  onText: (text: string) => void;
  onBool: (value: boolean) => void;
  onClear: () => void;
}) {
  const reset = state.set ? (
    <button type="button" className="field-reset" onClick={onClear} title="reset to inherited default">
      reset
    </button>
  ) : null;

  if (field.type === "bool") {
    return (
      <div className={`field-row field-row-bool${modified ? " field-modified" : ""}`}>
        <span className="field-text">
          <span className="field-name">
            {field.label}
            {modified && <span className="field-dot" aria-hidden="true" />}
          </span>
          {field.description && <span className="field-desc">{field.description}</span>}
          {error && <span className="field-error">{error}</span>}
        </span>
        <span className="field-control">
          {reset}
          <input
            className="field-checkbox"
            type="checkbox"
            checked={state.set ? state.bool : Boolean(field.default)}
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
          placeholder={`default: ${field.default}`}
          aria-label={field.label}
          aria-invalid={error ? true : undefined}
          onChange={onChange}
        />
      </span>
    </div>
  );
}
