"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { SearchClearButton } from "@/components/app-ui/search-clear-button";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Button } from "@/lib/morphy-ux/morphy";
import type { LocationMemoryField, LocationMemoryPresentation } from "@/lib/profile/location-memory-presentation";

export function LocationMemoryView({ presentation, loading, error, onRetry, onOpen }: {
  presentation: LocationMemoryPresentation;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onOpen: (field: LocationMemoryField) => void;
}) {
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const sections = presentation.sections.filter((section) => !search || `${section.title} ${section.fields.map((field) => `${field.label} ${field.value}`).join(" ")}`.toLocaleLowerCase().includes(search));
  return (
    <div className="space-y-5" data-pkm-location-view="true" data-pkm-detail-panel="true">
      <div className="relative">
        <Input type="search" aria-label="Search Location memory" placeholder="Search Location memory" value={query} onChange={(event) => setQuery(event.target.value)} className="h-11 pr-11" autoComplete="off" />
        <SearchClearButton visible={query.length > 0} label="Clear Location memory search" onClear={() => setQuery("")} />
      </div>
      {loading ? <SurfaceInset className="p-4 text-sm text-muted-foreground" role="status">Opening Location memory…</SurfaceInset>
        : error ? <SurfaceInset className="space-y-3 p-4"><p>Location memory couldn’t be opened.</p><Button variant="muted" size="sm" onClick={onRetry}>Try again</Button></SurfaceInset>
        : sections.length === 0 ? <p className="px-1 text-sm text-muted-foreground">{search ? "No location details match your search." : "No location details saved yet."}</p>
        : sections.map((section) => (
          <SettingsGroup key={section.key} title={section.title} separatorInset testId={`location-memory-${section.key}`}>
            {section.fields.map((field) => <SettingsRow
              key={JSON.stringify(field.card.pathSegments)}
              title={field.label}
              description={field.value}
              onClick={field.selector ? () => onOpen(field) : undefined}
              ariaLabel={field.selector ? `${section.title}: ${field.label}, ${field.value}. Open options` : undefined}
              chevron={Boolean(field.selector)}
            />)}
          </SettingsGroup>
        ))}
      {presentation.incomplete ? <p className="px-1 text-sm text-muted-foreground">Some details couldn’t be displayed. Your saved memory is unchanged.</p> : null}
    </div>
  );
}
