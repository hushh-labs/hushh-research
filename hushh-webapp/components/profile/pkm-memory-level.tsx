"use client";

import { useMemo } from "react";
import { ChevronLeft, Loader2 } from "lucide-react";

import { PkmMemoryRow } from "@/components/profile/pkm-memory-row";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import type { PkmMemoryCard, PkmPathSegment } from "@/lib/pkm/pkm-memory-cards";
import { resolvePkmMemoryLevel } from "@/lib/pkm/pkm-memory-level";

/**
 * One generic level of nested Memory browsing, iOS Settings-style. The same
 * component renders every depth; position is driven entirely by `pathStack`, so
 * there is no Level 1 / Level 2 / Level 3 special-casing.
 *
 * Only the current level's immediate children are shown: groups as navigation
 * rows with a child count and a chevron, leaves as title + value. Back moves
 * exactly one segment up (the parent decides what "up" means at the root).
 */
export function PkmMemoryLevel({
  domainKey,
  domainTitle,
  data,
  pathStack,
  loading,
  error,
  sharingImpactError,
  sourceLabel,
  updatedAt,
  onDrill,
  onBack,
  onOpenLeaf,
}: {
  domainKey: string;
  domainTitle: string;
  data: Record<string, unknown> | null;
  pathStack: PkmPathSegment[];
  loading: boolean;
  error: boolean;
  sharingImpactError: string | null;
  sourceLabel?: string;
  updatedAt?: string | null;
  onDrill: (segment: PkmPathSegment) => void;
  onBack: () => void;
  onOpenLeaf: (card: PkmMemoryCard) => void;
}) {
  const level = useMemo(
    () =>
      resolvePkmMemoryLevel({
        domainKey,
        domainTitle,
        data,
        pathStack,
        sourceLabel,
        updatedAt,
      }),
    [domainKey, domainTitle, data, pathStack, sourceLabel, updatedAt],
  );

  const atRoot = pathStack.length === 0;
  const isEmpty = level.entries.length === 0;

  return (
    <div className="space-y-7" data-pkm-detail-panel="true" data-pkm-memory-level="true">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 inline-flex min-h-11 items-center gap-1 text-[15px] font-normal text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {level.parentLabel}
      </button>

      <div className="space-y-1">
        {!atRoot ? (
          <p
            className="text-[13px] font-medium uppercase tracking-wide text-muted-foreground"
            data-pkm-level-breadcrumb="true"
          >
            {level.crumbs.slice(0, -1).join(" › ")}
          </p>
        ) : null}
        <h2 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">
          {level.title}
        </h2>
      </div>

      {sharingImpactError ? (
        <p className="px-1 text-sm text-destructive">{sharingImpactError}</p>
      ) : null}

      {level.notFound ? (
        <SurfaceInset className="space-y-1 p-4 text-sm text-muted-foreground">
          <p className="font-semibold text-foreground">This memory moved</p>
          <p>Go back and open it again.</p>
        </SurfaceInset>
      ) : !isEmpty ? (
        <SettingsGroup separatorInset testId={`memory-level-list-${domainKey}`}>
          {level.entries.map((entry) =>
            entry.kind === "group" ? (
              <SettingsRow
                key={entry.key}
                title={entry.label}
                onClick={() => onDrill(entry.segment)}
                chevron
                ariaLabel={`Open ${entry.label}`}
                testId={`memory-group-${entry.key}`}
                trailing={
                  <span className="text-[15px] tabular-nums text-muted-foreground">
                    {entry.childCount}
                  </span>
                }
              />
            ) : (
              <PkmMemoryRow key={entry.key} card={entry.card} onOpen={onOpenLeaf} />
            ),
          )}
        </SettingsGroup>
      ) : loading ? (
        <SurfaceInset className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Opening {level.title}…
        </SurfaceInset>
      ) : error ? (
        <SurfaceInset className="space-y-1 p-4 text-sm text-muted-foreground">
          <p className="font-semibold text-foreground">This couldn’t be opened</p>
          <p>Go back and try again.</p>
        </SurfaceInset>
      ) : (
        <SurfaceInset className="p-4 text-sm text-muted-foreground">
          Nothing is saved in {level.title} yet.
        </SurfaceInset>
      )}
    </div>
  );
}
