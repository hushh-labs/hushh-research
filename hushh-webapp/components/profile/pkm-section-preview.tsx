"use client";

import { ChevronDown, Loader2, PenLine, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type {
  PkmSectionPreviewEntity,
  PkmSectionPreviewEntitySection,
  PkmSectionPreviewField,
  PkmSectionPreviewPresentation,
} from "@/lib/profile/pkm-section-preview";
import { cn } from "@/lib/utils";

function PreviewFieldList({
  fields,
}: {
  fields: PkmSectionPreviewField[];
}) {
  return (
    <dl className="divide-y divide-[color:var(--app-card-border-standard)]">
      {fields.map((field) => (
        <div
          key={`${field.label}:${field.value}`}
          className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"
        >
          <dt className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {field.label}
          </dt>
          <dd
            className={cn(
              "min-w-0 break-words text-sm leading-6 text-foreground",
              field.tone === "muted" ? "text-muted-foreground" : null
            )}
          >
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PreviewSectionItems({
  section,
}: {
  section: PkmSectionPreviewEntitySection;
}) {
  if (!section.items.length) {
    return null;
  }

  if (section.display === "chips") {
    return (
      <div className="flex flex-wrap gap-2">
        {section.items.map((item) => (
          <Badge key={item} variant="secondary">
            {item}
          </Badge>
        ))}
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {section.items.map((item) => (
        <li key={item} className="text-sm leading-6 text-foreground/90">
          {item}
        </li>
      ))}
    </ul>
  );
}

function PreviewEntityRow({
  entity,
  deletingEntityKey,
  onEditEntity,
  onDeleteEntity,
}: {
  entity: PkmSectionPreviewEntity;
  deletingEntityKey?: string | null;
  onEditEntity?: (entity: PkmSectionPreviewEntity) => void;
  onDeleteEntity?: (entity: PkmSectionPreviewEntity) => void;
}) {
  const deleting = deletingEntityKey === entity.key;
  const canEdit = entity.editable === true && Boolean(onEditEntity);
  const canDelete = entity.deletable === true && Boolean(onDeleteEntity);

  function handleDelete() {
    if (!onDeleteEntity) return;
    const confirmed = window.confirm(`Remove "${entity.title}" from your saved details?`);
    if (!confirmed) return;
    onDeleteEntity(entity);
  }

  const quickFacts = (entity.sections || []).filter(
    (section) => section.display === "chips",
  );
  const detailSections = (entity.sections || []).filter(
    (section) => section.display !== "chips",
  );
  const hasDetails = entity.fields.length > 0 || detailSections.length > 0;

  return (
    <article className="space-y-3 px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="break-words text-[15px] font-semibold leading-5 tracking-tight text-foreground">
            {entity.title}
          </p>
          {entity.subtitle ? (
            <p className="text-xs font-medium text-muted-foreground">{entity.subtitle}</p>
          ) : null}
        </div>
        {canEdit || canDelete ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {canEdit ? (
              <button
                type="button"
                onClick={() => onEditEntity?.(entity)}
                disabled={deleting}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-3 text-xs font-medium text-foreground transition-colors hover:bg-[color:var(--app-card-surface-default-solid)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <PenLine className="h-3.5 w-3.5" />
                Edit
              </button>
            ) : null}
            {canDelete ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-red-500/20 bg-red-500/10 px-3 text-xs font-medium text-red-700 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:text-red-300"
              >
                {deleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Delete
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {quickFacts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {quickFacts.flatMap((section) =>
            section.items.map((item) => (
              <Badge key={`${entity.key}:${section.label}:${item}`} variant="secondary">
                {item}
              </Badge>
            )),
          )}
        </div>
      ) : null}
      {hasDetails ? (
        <details className="group border-t border-[color:var(--app-card-border-standard)] pt-2">
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDown
              className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
              aria-hidden
            />
            View details
          </summary>
          <div className="space-y-3 pb-1 pt-2">
            {entity.fields.length > 0 ? <PreviewFieldList fields={entity.fields} /> : null}
            {detailSections.map((section) => (
              <div key={`${entity.key}:${section.label}`} className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {section.label}
                </p>
                <PreviewSectionItems section={section} />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

export function PkmSectionPreview({
  presentation,
  deletingEntityKey,
  onEditEntity,
  onDeleteEntity,
}: {
  presentation: PkmSectionPreviewPresentation;
  deletingEntityKey?: string | null;
  onEditEntity?: (entity: PkmSectionPreviewEntity) => void;
  onDeleteEntity?: (entity: PkmSectionPreviewEntity) => void;
}) {
  return (
    <div className="space-y-4">
      {presentation.summary ? (
        <p className="text-sm leading-6 text-foreground/90">{presentation.summary}</p>
      ) : null}

      {presentation.stats.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {presentation.stats.map((stat) => (
            <Badge key={stat.label} variant="secondary">
              {stat.value} {stat.label.toLowerCase()}
            </Badge>
          ))}
        </div>
      ) : null}

      {presentation.groups.map((group, index) => (
        <section key={`${group.kind}:${group.title || index}`} className="space-y-3">
          {group.title || group.description ? (
            <div className="space-y-1">
              {group.title ? (
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  {group.title}
                </h3>
              ) : null}
              {group.description ? (
                <p className="text-sm text-muted-foreground">{group.description}</p>
              ) : null}
            </div>
          ) : null}

          {group.kind === "fields" ? (
            <div className="overflow-hidden rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]">
              <PreviewFieldList fields={group.fields} />
            </div>
          ) : null}

          {group.kind === "chips" ? (
            <div className="flex flex-wrap gap-2">
              {group.items.map((item) => (
                <Badge key={item} variant="secondary">
                  {item}
                </Badge>
              ))}
            </div>
          ) : null}

          {group.kind === "list" ? (
            <div className="overflow-hidden rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] px-4 py-3">
              <ul className="space-y-2">
                {group.items.map((item) => (
                  <li key={item} className="text-sm leading-6 text-foreground/90">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {group.kind === "entities" ? (
            <div className="overflow-hidden rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] divide-y divide-[color:var(--app-card-border-standard)]">
              {group.items.map((entity) => (
                <PreviewEntityRow
                  key={entity.key}
                  entity={entity}
                  deletingEntityKey={deletingEntityKey}
                  onEditEntity={onEditEntity}
                  onDeleteEntity={onDeleteEntity}
                />
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
