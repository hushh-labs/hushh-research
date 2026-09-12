"use client";

/**
 * Browsing what can be asked of you, the way you browse what you know.
 *
 * The Memory route settled this interaction a while ago: one screen per level,
 * a single back control named after the parent, an ancestors-only breadcrumb,
 * and rows that are either somewhere to go or something to read. Every consent
 * surface then went and rendered a flat list instead, so the same information
 * looked like two different products depending on which side of the request you
 * were standing on.
 *
 * This is that interaction, pointed at a scope catalogue. It is deliberately a
 * near-copy of `PkmMemoryLevel` rather than a new idea: the whole complaint was
 * that these two screens diverged, and a third design would not fix that.
 *
 * Selection is the one thing Memory has no equivalent for. Memory is a place
 * you read; a catalogue is a place you choose. So a group row carries BOTH a
 * way in and a way to take the whole branch at once, because "share my
 * financial information" is a sentence people mean, and making them open four
 * folders to say it would be its own kind of dark pattern.
 */

import { useMemo, useState } from "react";
import { ChevronLeft, Search } from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Input } from "@/components/ui/input";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import {
  SCOPE_SEARCH_THRESHOLD,
  filterScopeItems,
  type ConsentScopeItem,
} from "@/lib/consent/consent-scope-items";
import {
  consentScopeItemsUnder,
  resolveConsentScopeLevel,
} from "@/lib/consent/consent-scope-level";
import { cn } from "@/lib/utils";

export type ConsentScopeNestedListProps = {
  items: readonly ConsentScopeItem[];
  /** What the back control says at the top, e.g. "All" or a person's name. */
  rootLabel?: string;
  /** Selection is owned by the caller, so the request payload stays its business. */
  selection?: {
    selectedIds: ReadonlySet<string>;
    /** Called with a whole branch at once, so a group row can be taken in one tap. */
    onToggleMany: (ids: readonly string[], select: boolean) => void;
  };
  /** A surface's own trailing control on a leaf row, when selection is not it. */
  renderTrailing?: (item: ConsentScopeItem) => React.ReactNode;
  onOpenItem?: (item: ConsentScopeItem) => void;
  searchThreshold?: number;
  emptyText?: string;
  /** Kept so an adopting surface does not lose the test ids it already had. */
  testIdPrefix?: string;
  className?: string;
};

export function ConsentScopeNestedList({
  items,
  rootLabel = "All",
  selection,
  renderTrailing,
  onOpenItem,
  searchThreshold = SCOPE_SEARCH_THRESHOLD,
  emptyText = "Nothing here yet.",
  testIdPrefix = "consent-scope",
  className,
}: ConsentScopeNestedListProps) {
  const [pathStack, setPathStack] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  const searching = query.trim().length > 0;

  /**
   * Search deliberately flattens.
   *
   * Someone typing has already told you they do not know where the thing lives,
   * so making them navigate to it is answering a question they did not ask. The
   * Memory route reached the same conclusion: it searches a flat card list and
   * orients the person with a breadcrumb on the row instead.
   */
  const matches = useMemo(
    () => (searching ? filterScopeItems(items, query) : []),
    [items, query, searching],
  );

  const level = useMemo(
    () => resolveConsentScopeLevel({ items, pathStack, rootLabel }),
    [items, pathStack, rootLabel],
  );

  const atRoot = pathStack.length === 0;
  const showSearch = items.length > searchThreshold;

  const branchIds = (segment: string) =>
    consentScopeItemsUnder(items, [...pathStack, segment]).map((item) => item.id);

  const allSelected = (ids: readonly string[]) =>
    ids.length > 0 && ids.every((id) => selection?.selectedIds.has(id));

  const selectedCountIn = (ids: readonly string[]) =>
    ids.filter((id) => selection?.selectedIds.has(id)).length;

  const renderLeafRow = (item: ConsentScopeItem, key: string) => {
    const selected = Boolean(selection?.selectedIds.has(item.id));
    return (
      <SettingsRow
        key={key}
        title={item.label}
        description={item.description || undefined}
        disabled={item.disabled}
        stackTrailingOnMobile
        chevron={Boolean(onOpenItem)}
        onClick={
          onOpenItem
            ? () => onOpenItem(item)
            : selection
              ? () => selection.onToggleMany([item.id], !selected)
              : undefined
        }
        ariaLabel={item.label}
        trailing={
          renderTrailing ? (
            renderTrailing(item)
          ) : selection ? (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => selection.onToggleMany([item.id], !selected)}
              disabled={item.disabled}
              aria-label={item.label}
              className="h-5 w-5 rounded border-[color:var(--app-separator)] accent-[color:var(--app-accent)]"
              data-testid={`${testIdPrefix}-toggle-${item.id}`}
            />
          ) : item.badge ? (
            <span className="text-xs text-muted-foreground">{item.badge}</span>
          ) : undefined
        }
        testId={`${testIdPrefix}-row-${item.id}`}
      />
    );
  };

  return (
    <div
      className={cn("space-y-5", className)}
      data-testid={testIdPrefix}
      data-consent-scope-level="true"
    >
      {!atRoot ? (
        <button
          type="button"
          onClick={() => setPathStack((stack) => stack.slice(0, -1))}
          className="-ml-1 inline-flex min-h-11 items-center gap-1 text-[15px] font-normal text-muted-foreground transition-colors hover:text-foreground"
          data-testid={`${testIdPrefix}-back`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {level.parentLabel}
        </button>
      ) : null}

      {!atRoot ? (
        <div className="space-y-1">
          <p
            className="text-[13px] font-medium uppercase tracking-wide text-muted-foreground"
            data-consent-scope-breadcrumb="true"
          >
            {level.crumbs.slice(0, -1).join(" › ")}
          </p>
          <h2 className="text-[22px] font-semibold leading-tight tracking-tight text-foreground">
            {level.title}
          </h2>
        </div>
      ) : null}

      {showSearch ? (
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search this list"
            className="pl-9"
            data-testid={`${testIdPrefix}-search`}
          />
        </div>
      ) : null}

      {searching ? (
        matches.length ? (
          <SettingsGroup separatorInset testId={`${testIdPrefix}-results`}>
            {matches.map((item) => renderLeafRow(item, `match-${item.id}`))}
          </SettingsGroup>
        ) : (
          <p
            className="px-1 py-3 text-sm text-muted-foreground"
            data-testid={`${testIdPrefix}-no-match`}
          >
            Nothing matches that.
          </p>
        )
      ) : level.notFound ? (
        <SurfaceInset className="space-y-1 p-4 text-sm text-muted-foreground">
          <p className="font-semibold text-foreground">This is no longer here</p>
          <p>Go back and open it again.</p>
        </SurfaceInset>
      ) : level.entries.length ? (
        <SettingsGroup separatorInset testId={`${testIdPrefix}-level`}>
          {level.entries.map((entry) => {
            if (entry.kind === "leaf") return renderLeafRow(entry.item, entry.key);

            const ids = branchIds(entry.segment);
            const everything = allSelected(ids);
            const chosen = selectedCountIn(ids);

            return (
              <SettingsRow
                key={entry.key}
                title={entry.label}
                onClick={() => setPathStack((stack) => [...stack, entry.segment])}
                chevron
                ariaLabel={`Open ${entry.label}`}
                testId={`${testIdPrefix}-group-${entry.key}`}
                trailing={
                  <span className="flex items-center gap-3">
                    <span className="text-[15px] tabular-nums text-muted-foreground">
                      {selection && chosen ? `${chosen}/${entry.childCount}` : entry.childCount}
                    </span>
                    {selection ? (
                      <input
                        type="checkbox"
                        checked={everything}
                        // A partly-chosen branch is neither on nor off, and
                        // showing it as off would quietly misreport what the
                        // person has already agreed to.
                        ref={(node) => {
                          if (node) node.indeterminate = chosen > 0 && !everything;
                        }}
                        onChange={() => selection.onToggleMany(ids, !everything)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Everything in ${entry.label}`}
                        className="h-5 w-5 rounded border-[color:var(--app-separator)] accent-[color:var(--app-accent)]"
                        data-testid={`${testIdPrefix}-group-toggle-${entry.key}`}
                      />
                    ) : null}
                  </span>
                }
              />
            );
          })}
        </SettingsGroup>
      ) : (
        <p className="px-1 py-3 text-sm text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>
          {emptyText}
        </p>
      )}
    </div>
  );
}
