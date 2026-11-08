"use client";

import { useId } from "react";

import { RowDescription, SectionLabel } from "@/components/app-ui/typography";
import { LiveMirrorPreview } from "@/components/profile/live-mirror-preview";
import { SoulMemoryDocument } from "@/components/profile/soul-memory-document";
import { Button } from "@/lib/morphy-ux/morphy";
import { Input } from "@/components/ui/input";
import {
  readLabelledSoulFacts,
  setLabelledSoulFact,
} from "@/lib/pkm/soul-labelled-facts";
import { Textarea } from "@/components/ui/textarea";
import { MAX_MARKDOWN_MEMORY_CHARS } from "@/lib/pkm/markdown-memory";
import {
  useSoulMemoryModel,
  type SoulMemoryModel,
  type SoulMemoryModelOptions,
} from "./use-soul-memory-model";

/** Existing web entrypoint; the shared owner also supports native presentation. */
export function SoulMemoryPanel(options: SoulMemoryModelOptions) {
  const model = useSoulMemoryModel(options);
  return <SoulMemoryPanelBody model={model} />;
}

/** Presentation only. A retained parent can supply its one existing owner. */
export function SoulMemoryPanelBody({ model }: { model: SoulMemoryModel }) {
  const editorId = useId();
  const editorHelpId = useId();
  const {
    active,
    verified,
    current,
    editing,
    loading,
    failed,
    saving,
    conflict,
    sync,
    cancelEdit,
    save,
  } = model;
  if (!verified)
    return (
      <p role="status" className="py-4 text-sm text-muted-foreground">
        Reconnect your account to open memory.md.
      </p>
    );
  // The same shared Live Mirror preview as Profile and One's sheet, above
  // the Soul view. It stays out of the way while memory.md is being edited.
  const livePreview =
    active && !editing ? <LiveMirrorPreview showOpenMemory={false} /> : null;
  if (failed && !editing)
    return (
      <div className="min-w-0 space-y-[var(--app-form-section-gap)]">
        {livePreview}
        <div role="status" className="space-y-3 py-4">
          <p className="text-sm text-muted-foreground">
            memory.md couldn’t be opened.
          </p>
          <Button variant="none" effect="fade" size="compact" data-pkm-action="compact" onClick={model.retryLoad}>
            Try again
          </Button>
        </div>
      </div>
    );
  if (!current)
    return (
      <div className="min-w-0 space-y-[var(--app-form-section-gap)]">
        {livePreview}
        <p role="status" className="py-4 text-sm text-muted-foreground">
          Opening memory.md…
        </p>
      </div>
    );
  return (
    <div className="min-w-0 space-y-[var(--app-form-section-gap)]">
      {livePreview}
      <section
        aria-label="memory.md"
        className="min-w-0 space-y-4 pb-6"
      >
        <div className="flex flex-col items-start gap-3 border-b border-[color:var(--app-separator)] pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <SectionLabel as="h2" data-pkm-section-heading="true">Long-term memory</SectionLabel>
            <RowDescription as="p">
              What One remembers across conversations.
            </RowDescription>
          </div>
          {editing ? (
            <div role="group" aria-label="Memory editing actions" className="flex flex-wrap gap-2">
              <Button variant="none" effect="fade" size="compact" data-pkm-action="utility" disabled={saving} onClick={cancelEdit}>
                Cancel
              </Button>
              <Button
                variant="none"
                effect="fade"
                size="compact"
                data-pkm-action="compact"
                disabled={
                  saving ||
                  current.draft === current.document.markdown ||
                  current.draft.length > MAX_MARKDOWN_MEMORY_CHARS
                }
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          ) : (
            <Button
              variant="none"
              effect="fade"
              size="compact"
              data-pkm-action="compact"
              className="shrink-0"
              disabled={loading}
              onClick={model.beginEdit}
            >
              Edit memory
            </Button>
          )}
        </div>
        {sync === "saving" ? (
          <p role="status" className="text-xs text-muted-foreground">
            Syncing your latest memories…
          </p>
        ) : null}
        {sync === "retryable" ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <p>
              Your latest memories are available here but haven’t synced yet.
            </p>
            <Button variant="none" effect="fade" size="compact" data-pkm-action="compact" onClick={() => void model.retrySync()}>
              Retry sync
            </Button>
          </div>
        ) : null}
        {editing ? (
          <div className="space-y-[var(--app-form-section-gap)]">
            <div className="space-y-[var(--app-form-field-gap)]">
              <label htmlFor={editorId} data-pkm-form-label="true" className="text-sm font-medium">
                Memory document
              </label>
              <Textarea
                id={editorId}
                aria-describedby={editorHelpId}
                value={current.draft}
                disabled={saving}
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                rows={18}
                className="soul-memory-editor min-h-80"
                onChange={(event) => model.changeDraft(event.target.value)}
              />
              <div id={editorHelpId} data-pkm-helper="true" className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  Use headings, lists, and links. Passwords are omitted when saving.
                </span>
                <span>
                  {current.draft.length.toLocaleString()} /{" "}
                  {MAX_MARKDOWN_MEMORY_CHARS.toLocaleString()} characters
                </span>
              </div>
            </div>
            <fieldset
              className="grid min-w-0 gap-[var(--app-form-field-gap)] sm:grid-cols-3"
              disabled={saving}
            >
              <legend data-pkm-form-label="true" className="mb-2 text-sm font-medium">Identity details (optional)</legend>
              <p data-pkm-helper="true" className="text-xs text-muted-foreground sm:col-span-3">
                Edit or clear a field to update these details in your memory.
              </p>
              {[
                { label: "Legal name", key: "legal name", type: "text" },
                { label: "Date of birth", key: "date of birth", type: "date" },
                { label: "Sex", key: "sex", type: "text" },
              ].map((field) => (
                <label key={field.key} data-pkm-form-label="true" className="block min-w-0 space-y-2 text-sm">
                  <span>{field.label}</span>
                  <Input
                    aria-label={field.label}
                    type={field.type}
                    autoComplete="off"
                    value={
                      readLabelledSoulFacts(current.draft).get(field.key)
                        ?.value ?? ""
                    }
                    onChange={(event) =>
                      model.changeDraft(
                        setLabelledSoulFact(
                          current.draft,
                          field.label,
                          event.target.value,
                        ),
                      )
                    }
                  />
                </label>
              ))}
              <p data-pkm-helper="true" className="text-xs text-muted-foreground sm:col-span-3">
                Age is calculated from your birth date. Sharing age does not
                share that date. Sex is used only when you provide it.
              </p>
            </fieldset>
            {conflict ? (
              <Button
                variant="none"
                effect="fade"
                size="compact"
                data-pkm-action="compact"
                disabled={saving}
                onClick={model.reloadLatest}
              >
                Reload latest version
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="min-w-0 space-y-3">
          {editing ? <SectionLabel as="h3" data-pkm-section-heading="true">Preview</SectionLabel> : null}
          <SoulMemoryDocument
            markdown={editing ? current.draft : current.document.markdown}
            preview={editing}
          />
        </div>
      </section>
    </div>
  );
}
