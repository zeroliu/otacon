import { useEffect, useState } from "react";
import type { KnowledgeDocument } from "../api";
import { saveKnowledge, useKnowledge } from "../api";
import type { KnowledgeScope } from "./model";

export type KnowledgeEditorState = "saved" | "dirty" | "conflict";

export interface KnowledgeDocumentFixture {
  markdown: string;
  baselineMarkdown?: string;
  diskMarkdown?: string;
  state?: KnowledgeEditorState;
}

interface EditableKnowledgeDocument {
  baseline: string;
  value: string;
  diskMarkdown?: string;
  hash?: string;
  path?: string;
  status: KnowledgeEditorState;
}

interface KnowledgeScreenProps {
  initialScope?: KnowledgeScope;
  /** Storybook/test fixtures. Omit in the app to use the daemon-backed editor. */
  documents?: Record<KnowledgeScope, KnowledgeDocumentFixture>;
  repo?: string;
  onBack?: () => void;
  backLabel?: string;
}

function makeEditableDocument(document: KnowledgeDocumentFixture): EditableKnowledgeDocument {
  return {
    baseline: document.baselineMarkdown ?? document.markdown,
    value: document.markdown,
    diskMarkdown: document.diskMarkdown,
    status: document.state ?? "saved",
  };
}

function fromDaemon(document: KnowledgeDocument): EditableKnowledgeDocument {
  return {
    baseline: document.markdown,
    value: document.markdown,
    hash: document.hash,
    path: document.path,
    status: "saved",
  };
}

function repoFromQuery(): string {
  return new URLSearchParams(window.location.search).get("repo") ?? "";
}

/**
 * The production Knowledge route and the Phase 1 stories share this component.
 * Passing `documents` selects deterministic fixture mode; the persistent app
 * omits it and loads/saves the same editor through the daemon's CAS API.
 */
export function KnowledgeScreen(props: KnowledgeScreenProps) {
  if (props.documents !== undefined) return <FixtureKnowledgeScreen {...props} documents={props.documents} />;
  return <DaemonKnowledgeScreen {...props} />;
}

function FixtureKnowledgeScreen({
  initialScope = "project",
  documents,
  repo = "zeroliu/otacon",
  onBack,
  backLabel,
}: KnowledgeScreenProps & { documents: Record<KnowledgeScope, KnowledgeDocumentFixture> }) {
  const [scope, setScope] = useState<KnowledgeScope>(initialScope);
  const [editable, setEditable] = useState<Record<KnowledgeScope, EditableKnowledgeDocument>>(() => ({
    user: makeEditableDocument(documents.user),
    project: makeEditableDocument(documents.project),
  }));

  return (
    <KnowledgeEditor
      scope={scope}
      onScope={setScope}
      editable={editable}
      repo={repo}
      onBack={onBack}
      backLabel={backLabel}
      onUpdate={(target, update) => setEditable((current) => ({
        ...current,
        [target]: update(current[target]),
      }))}
      onSave={async (target) => {
        setEditable((current) => ({
          ...current,
          [target]: { ...current[target], baseline: current[target].value, status: "saved" },
        }));
      }}
    />
  );
}

function DaemonKnowledgeScreen({
  initialScope = repoFromQuery() === "" ? "user" : "project",
  repo: initialRepo,
  onBack,
  backLabel,
}: KnowledgeScreenProps) {
  const queryRepo = repoFromQuery();
  const [scope, setScope] = useState<KnowledgeScope>(initialScope);
  const [repo, setRepo] = useState(initialRepo ?? queryRepo);
  const [repoDraft, setRepoDraft] = useState(initialRepo ?? queryRepo);
  const [editable, setEditable] = useState<Partial<Record<KnowledgeScope, EditableKnowledgeDocument>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const user = useKnowledge("user");
  const project = useKnowledge("project", repo || undefined);

  useEffect(() => {
    const document = user.document;
    if (document === undefined) return;
    setEditable((current) => {
      const previous = current.user;
      if (previous !== undefined && previous.status !== "saved") return current;
      if (previous?.hash === document.hash) return current;
      return { ...current, user: fromDaemon(document) };
    });
  }, [user.document]);

  useEffect(() => {
    const document = project.document;
    if (document === undefined) return;
    setEditable((current) => {
      const previous = current.project;
      if (previous !== undefined && previous.status !== "saved") return current;
      if (previous?.hash === document.hash) return current;
      return { ...current, project: fromDaemon(document) };
    });
  }, [project.document]);

  const update = (
    target: KnowledgeScope,
    change: (document: EditableKnowledgeDocument) => EditableKnowledgeDocument,
  ): void => {
    setEditable((current) => {
      const document = current[target];
      return document === undefined ? current : { ...current, [target]: change(document) };
    });
  };

  const save = async (target: KnowledgeScope, conflictRetry = false): Promise<void> => {
    const document = editable[target];
    if (document?.hash === undefined || saving) return;
    setSaving(true);
    setSaveError(undefined);
    const result = await saveKnowledge(
      target,
      target === "project" ? repo : undefined,
      document.value,
      document.hash,
    );
    setSaving(false);
    if (result.ok) {
      // The textarea remains editable while the request is in flight. Treat
      // the submitted value as the saved baseline, but never replace newer
      // keystrokes that landed before the response came back.
      setEditable((current) => {
        const latest = current[target];
        const persisted = fromDaemon(result.document);
        if (latest === undefined || latest.value === document.value) {
          return { ...current, [target]: persisted };
        }
        return {
          ...current,
          [target]: { ...persisted, value: latest.value, status: "dirty" },
        };
      });
      return;
    }
    if (result.status === 409 && result.document !== undefined) {
      const disk = result.document;
      setEditable((current) => {
        const draft = current[target];
        if (draft === undefined) return current;
        return {
          ...current,
          [target]: {
            ...draft,
            baseline: disk.markdown,
            diskMarkdown: disk.markdown,
            hash: disk.hash,
            path: disk.path,
            status: "conflict",
          },
        };
      });
      return;
    }
    setSaveError(result.error.message);
    if (conflictRetry) update(target, (current) => ({ ...current, status: "conflict" }));
  };

  const activeRequest = scope === "user" ? user : project;

  return (
    <KnowledgeEditor
      scope={scope}
      onScope={(next) => {
        setScope(next);
        setSaveError(undefined);
      }}
      editable={editable}
      repo={repo}
      repoDraft={repoDraft}
      onRepoDraft={setRepoDraft}
      onOpenRepo={() => {
        if (saving) return;
        const next = repoDraft.trim();
        if (next === "" || next === repo) return;
        const projectDraft = editable.project;
        if (projectDraft !== undefined && projectDraft.status !== "saved") {
          setSaveError("Save or resolve the current Project draft before opening another project.");
          return;
        }
        setEditable((current) => ({ ...current, project: undefined }));
        setSaveError(undefined);
        setRepo(next);
        const url = new URL(window.location.href);
        url.searchParams.set("repo", next);
        window.history.replaceState(null, "", url);
      }}
      loading={activeRequest.loading}
      loadError={activeRequest.error}
      onReload={activeRequest.reload}
      saving={saving}
      saveError={saveError}
      onBack={onBack}
      backLabel={backLabel}
      onUpdate={update}
      onSave={save}
      onKeepMine={(target) => void save(target, true)}
    />
  );
}

function KnowledgeEditor({
  scope,
  onScope,
  editable,
  repo,
  repoDraft,
  onRepoDraft,
  onOpenRepo,
  loading = false,
  loadError,
  onReload,
  saving = false,
  saveError,
  onBack,
  backLabel = "← Back to review",
  onUpdate,
  onSave,
  onKeepMine,
}: {
  scope: KnowledgeScope;
  onScope: (scope: KnowledgeScope) => void;
  editable: Partial<Record<KnowledgeScope, EditableKnowledgeDocument>>;
  repo: string;
  repoDraft?: string;
  onRepoDraft?: (repo: string) => void;
  onOpenRepo?: () => void;
  loading?: boolean;
  loadError?: string;
  onReload?: () => void;
  saving?: boolean;
  saveError?: string;
  onBack?: () => void;
  backLabel?: string;
  onUpdate: (
    scope: KnowledgeScope,
    update: (document: EditableKnowledgeDocument) => EditableKnowledgeDocument,
  ) => void;
  onSave: (scope: KnowledgeScope) => Promise<void>;
  onKeepMine?: (scope: KnowledgeScope) => void;
}) {
  const active = editable[scope];
  const updateActive = (update: (document: EditableKnowledgeDocument) => EditableKnowledgeDocument): void => {
    onUpdate(scope, update);
  };

  return (
    <main className="pr-knowledge-screen" id="knowledge-preview">
      {onBack !== undefined && (
        <button type="button" className="pr-knowledge-back" onClick={onBack}>
          {backLabel}
        </button>
      )}
      <header className="pr-knowledge-head">
        <div><span>OTACON / PROFILE</span><h1>Knowledge</h1><p>Edit what future PR reviews assume you know.</p></div>
        {active !== undefined && (
          <span className={`pr-save-state is-${active.status}`} aria-live="polite">
            {saving ? "saving…" : active.status === "saved" ? "✓ saved" : active.status === "dirty" ? "● unsaved" : "! conflict"}
          </span>
        )}
      </header>
      <div className="pr-knowledge-tabs" role="tablist" aria-label="knowledge scope">
        {(["user", "project"] as const).map((value) => (
          <button
            id={`knowledge-tab-${value}`}
            key={value}
            type="button"
            role="tab"
            aria-controls={`knowledge-panel-${value}`}
            aria-selected={scope === value}
            onClick={() => onScope(value)}
          >
            {value === "user" ? "User" : "Project"}
          </button>
        ))}
      </div>
      <section
        id={`knowledge-panel-${scope}`}
        role="tabpanel"
        aria-labelledby={`knowledge-tab-${scope}`}
      >
        {scope === "project" && onOpenRepo !== undefined && (
          <form
            className="pr-knowledge-repo"
            onSubmit={(event) => {
              event.preventDefault();
              onOpenRepo();
            }}
          >
            <label htmlFor="knowledge-project-repo">GitHub project</label>
            <input
              id="knowledge-project-repo"
              value={repoDraft}
              disabled={saving}
              placeholder="owner/repo"
              onInput={(event) => onRepoDraft?.(event.currentTarget.value)}
            />
            <button type="submit" className="btn btn-ghost" disabled={saving}>Open</button>
          </form>
        )}

        {scope === "project" && repo === "" ? (
          <p className="pr-knowledge-inert">Enter an owner/repo to edit its shared project knowledge.</p>
        ) : loading || active === undefined ? (
          loadError === undefined
            ? <p className="loading">loading knowledge…</p>
            : (
              <div className="pr-knowledge-load-error" role="alert">
                <p>{loadError}</p>
                <button type="button" className="btn btn-ghost" onClick={onReload}>Try again</button>
              </div>
            )
        ) : (
          <>
            <div className="pr-knowledge-target">
              <span>{scope === "user" ? "global profile" : repo}</span>
              <code>{active.path ?? (scope === "user" ? "~/.otacon/knowledge/user.md" : `~/.otacon/knowledge/projects/github.com/${repo}/knowledge.md`)}</code>
            </div>
            {active.status === "conflict" && (
              <div className="pr-knowledge-conflict" role="alert">
                <strong>Knowledge changed on disk while you were editing.</strong>
                <p>Your text is preserved below. Compare it with the newer disk version before choosing which one to keep.</p>
                <details><summary>Show newer disk version</summary><pre>{active.diskMarkdown ?? "# Newer disk version\n\nNo content supplied."}</pre></details>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => updateActive((document) => {
                    const diskValue = document.diskMarkdown ?? document.baseline;
                    return { ...document, value: diskValue, baseline: diskValue, diskMarkdown: undefined, status: "saved" };
                  })}
                >
                  Use disk version
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving}
                  onClick={() => {
                    if (onKeepMine === undefined) {
                      updateActive((document) => ({ ...document, baseline: document.value, status: "saved" }));
                    } else {
                      onKeepMine(scope);
                    }
                  }}
                >
                  Keep my version
                </button>
              </div>
            )}
            {saveError !== undefined && <p className="pr-knowledge-save-error" role="alert">{saveError}</p>}
            <label className="pr-markdown-editor">
              <span>Markdown summary <small>Agents read this before authoring a new report.</small></span>
              <textarea
                value={active.value}
                spellCheck={false}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  updateActive((document) => ({
                    ...document,
                    value,
                    status: value === document.baseline ? "saved" : "dirty",
                  }));
                }}
              />
            </label>
            <footer className="pr-knowledge-foot">
              <span>Quiz evidence updates this summary; raw attempts stay in the review session.</span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={active.status !== "dirty" || saving}
                onClick={() => void onSave(scope)}
              >
                {saving ? "Saving…" : "Save Markdown"}
              </button>
            </footer>
          </>
        )}
      </section>
    </main>
  );
}
