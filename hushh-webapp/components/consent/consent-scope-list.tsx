"use client";

/**
 * One list of things someone can ask you for.
 *
 * Every scope surface used to hand-roll this. The profile rendered a flat
 * `permissions.map` with no grouping, no search and no collapse; the person page
 * had grouping and search but never collapsed; chat printed a raw domain key
 * next to each row. Same information, three answers, and only one of them was
 * usable past a dozen rows.
 *
 * Built entirely from primitives that already exist -- SettingsGroup,
 * SettingsRow, Collapsible, Input, Switch -- so it inherits the app's spacing,
 * density and dark-mode handling rather than restating them. No new tokens, no
 * new CSS.
 *
 * The behaviour worth naming: groups collapse only when the list is long enough
 * to be worth summarising. A two-row list behind a disclosure triangle is worse
 * than a two-row list.
 */

import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SCOPE_COLLAPSE_THRESHOLD,
  SCOPE_SEARCH_THRESHOLD,
  filterScopeItems,
  groupScopeItems,
  type ConsentScopeItem,
} from "@/lib/consent/consent-scope-items";
import { cn } from "@/lib/utils";

export type ConsentScopeListProps = {
  items: readonly ConsentScopeItem[];
  title?: string;
  description?: string;
  /** Off for a single-domain list, where every heading would say the same thing. */
  groupByDomain?: boolean;
  collapsible?: boolean;
  /** Selection mode: a checkbox-like control per row, owned by the caller. */
  selection?: {
    selectedIds: ReadonlySet<string>;
    onToggle: (id: string) => void;
  };
  /** The escape hatch: a surface's own trailing control (a posture switch, a preview). */
  renderTrailing?: (item: ConsentScopeItem) => React.ReactNode;
  onOpenItem?: (item: ConsentScopeItem) => void;
  searchThreshold?: number;
  emptyText?: string;
  /**
   * Prefix for data-testid attributes.
   *
   * Exists so an adopting surface keeps the test ids it already had, which is
   * the cheapest possible proof that extracting this component changed no
   * behaviour.
   */
  testIdPrefix?: string;
  className?: string;
};

export function ConsentScopeList({
  items,
  title,
  description,
  groupByDomain = true,
  collapsible = true,
  selection,
  renderTrailing,
  onOpenItem,
  searchThreshold = SCOPE_SEARCH_THRESHOLD,
  emptyText = "Nothing here yet.",
  testIdPrefix = "consent-scope",
  className,
}: ConsentScopeListProps) {
  const [query, setQuery] = useState("");
  const [collapsedDomains, setCollapsedDomains] = useState<ReadonlySet<string>>(new Set());

  const filtered = useMemo(() => filterScopeItems(items, query), [items, query]);
  const groups = useMemo(
    () =>
      groupByDomain
        ? groupScopeItems(filtered)
        : [{ domainKey: "__all", domainLabel: title || "", items: [...filtered] }],
    [filtered, groupByDomain, title],
  );

  const showSearch = items.length > searchThreshold;
  // Collapse only when there is genuinely a lot to take in. Hiding two rows
  // behind a triangle costs a tap and saves nothing.
  const collapseByDefault =
    collapsible && groupByDomain && groups.length > 1 && items.length > SCOPE_COLLAPSE_THRESHOLD;

  const isCollapsed = (domainKey: string) =>
    collapsedDomains.has(domainKey) ||
    (collapseByDefault && !collapsedDomains.has(`open:${domainKey}`));

  const toggleDomain = (domainKey: string) => {
    setCollapsedDomains((current) => {
      const next = new Set(current);
      if (isCollapsed(domainKey)) {
        next.delete(domainKey);
        next.add(`open:${domainKey}`);
      } else {
        next.delete(`open:${domainKey}`);
        next.add(domainKey);
      }
      return next;
    });
  };

  const searchField = showSearch ? (
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
  ) : undefined;

  const renderRow = (item: ConsentScopeItem) => (
    <SettingsRow
      key={item.id}
      title={item.label}
      description={item.description || undefined}
      disabled={item.disabled}
      stackTrailingOnMobile
      chevron={Boolean(onOpenItem)}
      onClick={onOpenItem ? () => onOpenItem(item) : undefined}
      trailing={
        renderTrailing ? (
          renderTrailing(item)
        ) : selection ? (
          <input
            type="checkbox"
            checked={selection.selectedIds.has(item.id)}
            onChange={() => selection.onToggle(item.id)}
            disabled={item.disabled}
            aria-label={item.label}
            className="h-5 w-5 rounded border-[color:var(--app-separator)] accent-[color:var(--app-accent)]"
            data-testid={`${testIdPrefix}-toggle-${item.id}`}
          />
        ) : item.badge ? (
          <span className="text-xs text-muted-foreground">{item.badge}</span>
        ) : undefined
      }
      data-testid={`${testIdPrefix}-row-${item.id}`}
    />
  );

  if (!filtered.length) {
    return (
      <SettingsGroup title={title} description={description} toolbar={searchField}>
        <p className="px-1 py-3 text-sm text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>
          {query ? "Nothing matches that." : emptyText}
        </p>
      </SettingsGroup>
    );
  }

  return (
    <div className={cn("space-y-4", className)} data-testid={testIdPrefix}>
      {showSearch ? (
        <p className="px-1 text-sm text-muted-foreground" data-testid={`${testIdPrefix}-count`}>
          {filtered.length} of {items.length}
        </p>
      ) : null}

      {groups.map((group) => {
        const body = <>{group.items.map(renderRow)}</>;

        if (!collapsible || !groupByDomain) {
          return (
            <SettingsGroup
              key={group.domainKey}
              title={groupByDomain ? group.domainLabel : title}
              description={description}
              toolbar={searchField}
              separatorInset
              testId={`${testIdPrefix}-group-${group.domainKey}`}
            >
              {body}
            </SettingsGroup>
          );
        }

        const collapsed = isCollapsed(group.domainKey);
        return (
          <Collapsible
            key={group.domainKey}
            open={!collapsed}
            onOpenChange={() => toggleDomain(group.domainKey)}
          >
            <SettingsGroup
              title={
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 text-left"
                    data-testid={`${testIdPrefix}-group-toggle-${group.domainKey}`}
                  >
                    <span>{group.domainLabel}</span>
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      {group.items.length}
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 transition-transform",
                          collapsed ? "" : "rotate-180",
                        )}
                        aria-hidden
                      />
                    </span>
                  </button>
                </CollapsibleTrigger>
              }
              separatorInset
              testId={`${testIdPrefix}-group-${group.domainKey}`}
            >
              <CollapsibleContent>{body}</CollapsibleContent>
            </SettingsGroup>
          </Collapsible>
        );
      })}
    </div>
  );
}
