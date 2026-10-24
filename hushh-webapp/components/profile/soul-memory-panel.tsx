"use client";

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
        className="min-w-0 space-y-[var(--app-form-section-gap)] pb-6"
      >
        <div className="flex flex-col items-start gap-2 px-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <p className="ui-text-row-description min-w-0 flex-1">
            The memory One uses in every conversation.
          </p>
          {editing ? (
            <div className="flex flex-wrap gap-2">
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
              Edit memory.md
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
          <div className="space-y-[var(--app-form-field-gap)]">
            <fieldset
              className="space-y-[var(--app-form-field-gap)]"
              disabled={saving}
            >
              <legend data-pkm-form-label="true" className="text-sm font-medium">Identity details</legend>
              <p data-pkm-helper="true" className="text-xs text-muted-foreground">
                Optional. Edit or clear a field to remove it. Your account name
                and photo already work for approved questions; no KYC is needed.
              </p>
              {[
                { label: "Legal name", key: "legal name", type: "text" },
                { label: "Date of birth", key: "date of birth", type: "date" },
                { label: "Sex", key: "sex", type: "text" },
              ].map((field) => (
                <label key={field.key} data-pkm-form-label="true" className="block space-y-2 text-sm">
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
              <p data-pkm-helper="true" className="text-xs text-muted-foreground">
                Age is calculated from your birth date. Sharing age does not
                share that date. Sex is used only when you provide it.
              </p>
            </fieldset>
            <Textarea
              aria-label="memory.md Markdown"
              value={current.draft}
              disabled={saving}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              rows={18}
              className="soul-memory-editor min-h-80"
              onChange={(event) => model.changeDraft(event.target.value)}
            />
            <div data-pkm-helper="true" className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                Use Markdown headings, lists, and links. Passwords are omitted
                when saving.
              </span>
              <span>
                {current.draft.length.toLocaleString()} /{" "}
                {MAX_MARKDOWN_MEMORY_CHARS.toLocaleString()}
              </span>
            </div>
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
        <SoulMemoryDocument
          markdown={editing ? current.draft : current.document.markdown}
          preview={editing}
        />
      </section>
    </div>
  );
}
