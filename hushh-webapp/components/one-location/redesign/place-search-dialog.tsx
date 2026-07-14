"use client";

/**
 * One Location redesign — reusable place search dialog.
 *
 * A shadcn Command (cmdk) full-screen combobox for picking a place: debounced
 * Google Places autocomplete (server-side, so cmdk filtering is disabled), a
 * loading state, an empty state, an optional "Recent" group, and full-width
 * result rows (no truncation) with keyboard navigation. Selecting a result
 * resolves place details and hands back a `DriveDestination`.
 *
 * Used by Drive To (destination) and Pick Me Up (Adjust pickup spot).
 */

import { useEffect, useState } from "react";
import { Loader2, MapPin, Navigation } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { OneLocationService } from "@/lib/one-location/service";
import { cn } from "@/lib/utils";
import type { DriveDestination } from "@/lib/one-location/types";

export interface PlaceSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultOwnerToken: string | null;
  recents?: DriveDestination[];
  onSelect: (destination: DriveDestination) => void;
  title?: string;
  placeholder?: string;
}

export function PlaceSearchDialog({
  open,
  onOpenChange,
  vaultOwnerToken,
  recents = [],
  onSelect,
  title = "Search a place",
  placeholder = "Search a place…",
}: PlaceSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<{ placeId: string; text: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state whenever the dialog closes.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setSuggestions([]);
      setSearching(false);
      setResolving(false);
      setError(null);
    }
  }, [open]);

  // Debounced Places autocomplete via the backend proxy.
  useEffect(() => {
    const token = vaultOwnerToken;
    const q = query.trim();
    if (!token || q.length < 2) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setError(null);
    const handle = setTimeout(async () => {
      try {
        const results = await OneLocationService.placesAutocomplete({
          vaultOwnerToken: token,
          input: q,
        });
        if (!cancelled) setSuggestions(results);
      } catch {
        if (!cancelled) {
          setSuggestions([]);
          setError("Couldn't search places. Check your connection.");
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, vaultOwnerToken]);

  const choose = async (placeId: string) => {
    const token = vaultOwnerToken;
    if (!token) return;
    setResolving(true);
    try {
      const details = await OneLocationService.placeDetails({
        vaultOwnerToken: token,
        placeId,
      });
      onSelect(details);
      onOpenChange(false);
    } catch {
      setError("Couldn't load that place. Try another.");
    } finally {
      setResolving(false);
    }
  };

  const chooseRecent = (recent: DriveDestination) => {
    onSelect(recent);
    onOpenChange(false);
  };

  const q = query.trim();
  const showRecents = q.length < 2 && recents.length > 0;
  const showEmptyPrompt = q.length < 2 && recents.length === 0 && !searching;
  const showNoResults =
    q.length >= 2 && !searching && !error && suggestions.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0" showCloseButton>
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Search for a place</DialogDescription>
        </DialogHeader>
        <Command
          shouldFilter={false}
          className={cn(
            "[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3",
            // Blue active/highlighted row (scoped to this dialog; overrides the
            // shared CommandItem's neutral `bg-accent`).
            "[&_[data-slot=command-item][data-selected=true]]:bg-[color:var(--app-accent-tint)] [&_[data-slot=command-item][data-selected=true]]:text-[color:var(--app-accent)]",
          )}
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={placeholder}
          />
          <CommandList>
            {error ? (
              <div className="px-3 py-3 text-sm font-medium text-red-600 dark:text-red-300">
                {error}
              </div>
            ) : null}
            {searching ? (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching…
              </div>
            ) : null}
            {showEmptyPrompt ? (
              <CommandEmpty>Type to search a place.</CommandEmpty>
            ) : null}
            {showNoResults ? <CommandEmpty>No places found.</CommandEmpty> : null}

            {showRecents ? (
              <CommandGroup heading="Recent">
                {recents.map((recent) => (
                  <CommandItem
                    key={recent.placeId ?? recent.label}
                    value={`recent:${recent.placeId ?? recent.label}`}
                    onSelect={() => chooseRecent(recent)}
                  >
                    <MapPin className="text-[color:var(--app-accent)]" />
                    <span className="min-w-0 flex-1">{recent.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            {suggestions.length > 0 ? (
              <CommandGroup heading="Results">
                {suggestions.map((suggestion) => (
                  <CommandItem
                    key={suggestion.placeId}
                    value={suggestion.placeId}
                    disabled={resolving}
                    onSelect={() => void choose(suggestion.placeId)}
                  >
                    <Navigation className="rotate-90 text-[color:var(--app-accent)]" />
                    <span className="min-w-0 flex-1">{suggestion.text}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
