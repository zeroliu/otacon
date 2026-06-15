// The /settings screen (DESIGN.md §6 config surface): toggle User | Project
// scope, pick the Project repo, surface the exact target file the scope writes,
// and render every config field with its current value (schema default shown as
// the placeholder when unset). Phase 3 is render + navigation only — inputs hold
// local state but there is no Save/validation/reset/POST yet (Phase 4).

import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { ConfigField, ConfigScope } from "./api";
import { useConfig, useSessions } from "./api";
import { linkClick } from "./router";
import { currentValue, distinctRepos, fieldsBySection, isSet } from "./settings";

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
  const { schema, scopes, loading, error } = useConfig(repoForFetch);

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
        <ScopeFields schema={schema} target={target} />
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

/** The prominent target-file banner + the schema fields for the active scope. */
function ScopeFields({ schema, target }: { schema: ConfigField[]; target: ConfigScope }) {
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
            <FieldRow key={`${field.section}.${field.key}`} field={field} target={target} />
          ))}
        </section>
      ))}
    </>
  );
}

/**
 * One config field: label + description and a type-driven input, seeded from the
 * scope's current value (the schema default shown as the placeholder when
 * unset). Local state only — no save/validation/reset in Phase 3.
 */
function FieldRow({ field, target }: { field: ConfigField; target: ConfigScope }) {
  const set = isSet(target.values, field);
  const value = currentValue(target.values, field);

  if (field.type === "bool") {
    return (
      <label className="field-row field-row-bool">
        <span className="field-text">
          <span className="field-name">{field.label}</span>
          {field.description && <span className="field-desc">{field.description}</span>}
        </span>
        <BoolInput field={field} initial={set ? Boolean(value) : Boolean(field.default)} />
      </label>
    );
  }

  return (
    <label className="field-row">
      <span className="field-text">
        <span className="field-name">{field.label}</span>
        {field.description && <span className="field-desc">{field.description}</span>}
      </span>
      <TextLikeInput field={field} initial={set ? String(value) : ""} />
    </label>
  );
}

/** int → number input, path → text input. Placeholder carries the default. */
function TextLikeInput({ field, initial }: { field: ConfigField; initial: string }) {
  const [draft, setDraft] = useState(initial);
  // Reseed when the scope/repo changes underneath (a new `initial` arrives).
  useEffect(() => setDraft(initial), [initial]);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value);
  return (
    <input
      className="field-input"
      type={field.type === "int" ? "number" : "text"}
      inputMode={field.type === "int" ? "numeric" : undefined}
      min={field.type === "int" ? field.min : undefined}
      value={draft}
      placeholder={`default: ${field.default}`}
      onChange={onChange}
    />
  );
}

/** bool → checkbox. Seeded from the scope value, falling back to the default. */
function BoolInput({ field, initial }: { field: ConfigField; initial: boolean }) {
  const [checked, setChecked] = useState(initial);
  useEffect(() => setChecked(initial), [initial]);
  return (
    <input
      className="field-checkbox"
      type="checkbox"
      checked={checked}
      onChange={(e) => setChecked(e.target.checked)}
    />
  );
}
