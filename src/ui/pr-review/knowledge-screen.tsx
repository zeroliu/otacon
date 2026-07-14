import { useState } from "react";
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
  status: KnowledgeEditorState;
}

function makeEditableDocument(document: KnowledgeDocumentFixture): EditableKnowledgeDocument {
  return {
    baseline: document.baselineMarkdown ?? document.markdown,
    value: document.markdown,
    diskMarkdown: document.diskMarkdown,
    status: document.state ?? "saved",
  };
}

export function KnowledgeScreen({
  initialScope = "project",
  documents,
  repo = "zeroliu/otacon",
  onBack,
}: {
  initialScope?: KnowledgeScope;
  documents: Record<KnowledgeScope, KnowledgeDocumentFixture>;
  repo?: string;
  onBack?: () => void;
}) {
  const [scope, setScope] = useState<KnowledgeScope>(initialScope);
  const [editable, setEditable] = useState<Record<KnowledgeScope, EditableKnowledgeDocument>>(() => ({
    user: makeEditableDocument(documents.user),
    project: makeEditableDocument(documents.project),
  }));
  const active = editable[scope];

  const updateActive = (update: (document: EditableKnowledgeDocument) => EditableKnowledgeDocument): void => {
    setEditable((current) => ({ ...current, [scope]: update(current[scope]) }));
  };

  const save = (): void => {
    if (active.status === "conflict") return;
    updateActive((document) => ({ ...document, baseline: document.value, status: "saved" }));
  };

  return (
    <main className="pr-knowledge-screen" id="knowledge-preview">
      {onBack !== undefined && (
        <button type="button" className="pr-knowledge-back" onClick={onBack}>
          ← Back to review
        </button>
      )}
      <header className="pr-knowledge-head">
        <div><span>OTACON / PROFILE</span><h1>Knowledge</h1><p>Edit what future PR reviews assume you know.</p></div>
        <span className={`pr-save-state is-${active.status}`} aria-live="polite">
          {active.status === "saved" ? "✓ saved" : active.status === "dirty" ? "● unsaved" : "! conflict"}
        </span>
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
            onClick={() => setScope(value)}
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
        <div className="pr-knowledge-target">
          <span>{scope === "user" ? "global profile" : repo}</span>
          <code>{scope === "user" ? "~/.otacon/knowledge/user.md" : `~/.otacon/knowledge/projects/github.com/${repo}/knowledge.md`}</code>
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
                return { ...document, value: diskValue, baseline: diskValue, status: "saved" };
              })}
            >
              Use disk version
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => updateActive((document) => ({ ...document, baseline: document.value, status: "saved" }))}
            >
              Keep my version
            </button>
          </div>
        )}
        <label className="pr-markdown-editor">
          <span>Markdown summary <small>Agents read this before authoring a new report.</small></span>
          <textarea
            value={active.value}
            spellCheck={false}
            onChange={(event) => updateActive((document) => ({
              ...document,
              value: event.target.value,
              status: event.target.value === document.baseline ? "saved" : "dirty",
            }))}
          />
        </label>
        <footer className="pr-knowledge-foot">
          <span>Quiz evidence updates this summary; raw attempts stay in the review session.</span>
          <button type="button" className="btn btn-primary" disabled={active.status !== "dirty"} onClick={save}>Save Markdown</button>
        </footer>
      </section>
    </main>
  );
}
