"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  DirectoryAttributionFooter,
  DirectoryLoadingRows,
  LocationPrompt,
  PostalCodeForm,
  QuietBlock,
} from "@/components/connect/nearby-directory-ui";
import { PlaceDetailSurface } from "@/components/connect/place-detail-surface";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/morphy-ux/cn";
import { SegmentedTabs } from "@/lib/morphy-ux/ui";
import { useCurrentLocation } from "@/lib/one-location/use-current-location";
import {
  PLACES_CATEGORIES,
  PLACES_RADIUS_OPTIONS_MI,
  PlacesDirectoryService,
  formatPlaceDistance,
  formatPlaceSubtitle,
  placesCategoryLabel,
  type PlaceCard,
  type PlacesAttribution,
} from "@/lib/services/places-directory-service";

type Anchor =
  | { kind: "coords"; latitude: number; longitude: number }
  | { kind: "postal"; postalCode: string };

const RADIUS_OPTIONS = PLACES_RADIUS_OPTIONS_MI.map((miles) => ({
  value: String(miles),
  label: `${miles} mi`,
}));

const ALL_CHIP = "all";

/** Enough of each bucket to be useful in the merged view without being a list. */
const OVERVIEW_LIMIT = 8;

const CATEGORY_SLUGS = PLACES_CATEGORIES.map((entry) => entry.slug);

/**
 * "Places near you" — the ten business categories around the account's position.
 *
 * Position comes from the shared location bus, exactly as the adviser and
 * insurance directories do, so opening this never re-prompts a reader who
 * already granted location on either of them.
 *
 * One sweep populates every category and the chips filter what already arrived,
 * so moving along the rail costs nothing. That is the same bargain the check-in
 * picker strikes, and for the same reason: a per-chip fetch would re-spend a
 * provider call to show rows we already hold.
 *
 * The sweep is streamed. Ten categories are ten provider calls on the backend,
 * and it emits each as it returns rather than gathering them, so the first rows
 * land roughly a round trip after the tap instead of after the slowest call. If
 * the stream cannot run — a buffering intermediary, a runtime with no
 * `ReadableStream` — the same render path is fed by one ordinary response.
 */
export function PlacesNearby({
  getIdToken,
}: {
  getIdToken: () => Promise<string | null>;
}) {
  const location = useCurrentLocation();

  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [radiusMi, setRadiusMi] = useState<number>(5);
  const [byCategory, setByCategory] = useState<Record<string, PlaceCard[]>>({});
  const [attribution, setAttribution] = useState<PlacesAttribution | null>(null);
  const [chip, setChip] = useState<string>(ALL_CHIP);
  /** True from the tap until the last category has answered. */
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PlaceCard | null>(null);

  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!location.snapshot) return;
    setAnchor((current) =>
      current?.kind === "postal"
        ? current
        : {
            kind: "coords",
            latitude: location.snapshot!.latitude,
            longitude: location.snapshot!.longitude,
          },
    );
  }, [location.snapshot]);

  const runSweep = useCallback(
    async (target: Anchor, miles: number) => {
      // A reader who changed radius must not have the previous sweep's rows
      // arrive on top of the new one's.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const token = ++requestRef.current;
      setStreaming(true);
      setError(null);
      setByCategory({});
      setAttribution(null);

      const origin =
        target.kind === "coords"
          ? { latitude: target.latitude, longitude: target.longitude }
          : { postalCode: target.postalCode };

      const accept = (category: string, items: PlaceCard[]) => {
        // A slower earlier sweep must never write into a newer one.
        if (token !== requestRef.current) return;
        setByCategory((current) => ({ ...current, [category]: items }));
      };

      try {
        const idToken = await getIdToken();
        if (!idToken) throw new Error("Sign in to see places nearby.");

        const shared = {
          idToken,
          origin,
          categories: CATEGORY_SLUGS,
          radiusMi: miles,
          limit: OVERVIEW_LIMIT,
          signal: controller.signal,
        };

        try {
          await PlacesDirectoryService.streamNearby({
            ...shared,
            handlers: {
              onMeta: (meta) => {
                if (token !== requestRef.current) return;
                setAttribution(meta.attribution ?? null);
              },
              onCategory: accept,
              // A single category failing is not a failed directory. The others
              // are still a better answer than an error page, so this is
              // swallowed on purpose rather than surfaced as the page's error.
              onCategoryError: () => undefined,
            },
          });
        } catch (streamFailure) {
          if (controller.signal.aborted) return;
          if (
            streamFailure instanceof DOMException &&
            streamFailure.name === "AbortError"
          ) {
            return;
          }
          // The stream could not run here. Ask the same question the ordinary
          // way rather than showing the reader a transport problem.
          const fallback = await PlacesDirectoryService.searchNearby(shared);
          if (token !== requestRef.current) return;
          setAttribution(fallback.meta?.attribution ?? null);
          for (const group of fallback.groups) {
            accept(group.category, group.items);
          }
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (token !== requestRef.current) return;
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Places are unavailable right now.",
        );
      } finally {
        if (token === requestRef.current) setStreaming(false);
      }
    },
    [getIdToken],
  );

  useEffect(() => {
    if (!anchor) return;
    void runSweep(anchor, radiusMi);
  }, [anchor, radiusMi, runSweep]);

  // Abort whatever is in flight if the reader leaves the tab entirely.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleUseLocation = useCallback(() => {
    void location.request();
  }, [location]);

  const handlePostalCode = useCallback((postalCode: string) => {
    setAnchor({ kind: "postal", postalCode });
  }, []);

  const visible = useMemo(() => {
    if (chip !== ALL_CHIP) return byCategory[chip] ?? [];
    // The merged view is nearest-first across every bucket that has answered,
    // de-duplicated: a bank inside a shopping centre can legitimately arrive in
    // two categories and should still be one row.
    const seen = new Set<string>();
    const merged: PlaceCard[] = [];
    for (const slug of CATEGORY_SLUGS) {
      for (const card of byCategory[slug] ?? []) {
        if (seen.has(card.placeId)) continue;
        seen.add(card.placeId);
        merged.push(card);
      }
    }
    return merged.sort((a, b) => a.distanceMeters - b.distanceMeters);
  }, [byCategory, chip]);

  const answered = Object.keys(byCategory).length;

  if (!anchor) {
    return (
      <LocationPrompt
        denied={
          location.status === "denied" || location.status === "unavailable"
        }
        busy={location.status === "locating"}
        heading="Places near you"
        onUseLocation={handleUseLocation}
        onSearchPostalCode={handlePostalCode}
        testId="places-location-prompt"
        useLocationTestId="places-use-location"
        postalInputTestId="places-postal-input"
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="places-nearby">
      <SegmentedTabs
        value={String(radiusMi)}
        onValueChange={(value) => setRadiusMi(Number(value))}
        options={RADIUS_OPTIONS}
        disabled={streaming && answered === 0}
      />

      {/* A rail rather than a segmented control: eleven segments would each be
          too narrow to read, and the rail is the pattern the check-in picker
          already uses for the same set of ideas. */}
      <div
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Place categories"
        data-testid="places-category-rail"
      >
        {[{ slug: ALL_CHIP, label: "All" }, ...PLACES_CATEGORIES].map((entry) => {
          const active = chip === entry.slug;
          const count =
            entry.slug === ALL_CHIP ? undefined : byCategory[entry.slug]?.length;
          return (
            <button
              key={entry.slug}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setChip(entry.slug)}
              data-testid={`places-chip-${entry.slug}`}
              className={cn(
                "type-footnote shrink-0 rounded-full border px-3 py-1.5 transition-colors",
                active
                  ? "border-transparent bg-foreground text-background"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.label}
              {typeof count === "number" && count > 0 ? (
                <span className="ml-1.5 tabular-nums opacity-60">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {error ? (
        <QuietBlock
          title={error}
          subtitle="Try again, or search a different ZIP."
          testId="places-error"
        >
          <div className="flex w-full flex-col items-center gap-4">
            <Button
              type="button"
              variant="none"
              effect="fill"
              size="lg"
              onClick={() => void runSweep(anchor, radiusMi)}
            >
              Try again
            </Button>
            <PostalCodeForm
              busy={streaming}
              initialValue={anchor.kind === "postal" ? anchor.postalCode : ""}
              onSearch={handlePostalCode}
              testId="places-postal-input"
            />
          </div>
        </QuietBlock>
      ) : null}

      {!error && !streaming && visible.length === 0 ? (
        // Coordinates can be perfectly good and still match nothing — a radius
        // of one mile in open country is an honest empty. Offer the two things
        // that help: a wider radius above, and a different place to look.
        <QuietBlock
          title="Nothing nearby"
          subtitle="Try a wider radius, or another ZIP."
          testId="places-empty"
        >
          <PostalCodeForm
            busy={streaming}
            initialValue={anchor.kind === "postal" ? anchor.postalCode : ""}
            onSearch={handlePostalCode}
            testId="places-postal-input"
          />
        </QuietBlock>
      ) : null}

      {error || (!streaming && visible.length === 0) ? null : (
        <SettingsGroup
          title={chip === ALL_CHIP ? "Nearby" : placesCategoryLabel(chip)}
          separatorInset
        >
          {visible.length === 0 ? (
            <DirectoryLoadingRows testId="places-loading" />
          ) : (
            visible.map((card) => {
              const distance = formatPlaceDistance(card.distanceMeters);
              return (
                <SettingsRow
                  key={card.placeId}
                  title={<span className="truncate">{card.name}</span>}
                  description={formatPlaceSubtitle(card) ?? undefined}
                  density="compact"
                  chevron
                  onClick={() => setSelected(card)}
                  trailing={
                    distance ? (
                      <span className="type-footnote shrink-0 tabular-nums text-muted-foreground">
                        {distance}
                      </span>
                    ) : undefined
                  }
                />
              );
            })
          )}
        </SettingsGroup>
      )}

      {/* The visible proof that this is a stream: rows are already readable
          while later categories are still arriving. */}
      {streaming && visible.length > 0 ? (
        <p
          className="type-footnote text-center text-muted-foreground"
          role="status"
          data-testid="places-streaming"
        >
          Finding more nearby…
        </p>
      ) : null}

      {visible.length > 0 ? (
        <DirectoryAttributionFooter
          attribution={attribution}
          stale={false}
          testId="places-attribution"
        />
      ) : null}

      <PlaceDetailSurface
        card={selected}
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        getIdToken={getIdToken}
      />
    </div>
  );
}
