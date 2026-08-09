"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { AdvisorDetailSurface } from "@/components/connect/advisor-detail-surface";
import {
  DirectoryAttributionFooter,
  DirectoryLoadingRows,
  LocationPrompt,
  PostalCodeForm,
  QuietBlock,
} from "@/components/connect/nearby-directory-ui";
import { OfficeDetailSurface } from "@/components/connect/office-detail-surface";
import { Button } from "@/lib/morphy-ux/button";
import { SegmentedTabs } from "@/lib/morphy-ux/ui";
import { useCurrentLocation } from "@/lib/one-location/use-current-location";
import {
  ADVISOR_PAGE_SIZE,
  ADVISOR_RADIUS_OPTIONS_MI,
  AdvisorDirectoryService,
  formatAdvisorSubtitle,
  formatDistance,
  type AdvisorAttribution,
  type AdvisorCard,
  type AdvisorSearchMeta,
} from "@/lib/services/advisor-directory-service";

type Anchor =
  | { kind: "coords"; latitude: number; longitude: number }
  | { kind: "postal"; postalCode: string };

const RADIUS_OPTIONS = ADVISOR_RADIUS_OPTIONS_MI.map((miles) => ({
  value: String(miles),
  label: `${miles} mi`,
}));

/**
 * "Around you" — advisers near the account's current position.
 *
 * Position comes from the shared location bus, so opening this tab never
 * re-prompts a user who already granted location elsewhere in the app, and the
 * fix it resolves is immediately available to every other surface.
 */
export function AdvisorsNearby({
  getIdToken,
}: {
  getIdToken: () => Promise<string | null>;
}) {
  const location = useCurrentLocation();

  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [radiusMi, setRadiusMi] = useState<number>(10);
  const [cards, setCards] = useState<AdvisorCard[]>([]);
  const [meta, setMeta] = useState<AdvisorSearchMeta | null>(null);
  const [attribution, setAttribution] = useState<AdvisorAttribution | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A failed extra page. Kept apart from `error` so it never hides the list. */
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdvisorCard | null>(null);

  const requestRef = useRef(0);

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

  const runSearch = useCallback(
    async (target: Anchor, miles: number, offset: number) => {
      const token = ++requestRef.current;
      if (offset === 0) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }
      setPageError(null);

      try {
        const idToken = await getIdToken();
        if (!idToken) throw new Error("Sign in to see advisors.");
        const result = await AdvisorDirectoryService.searchNearby({
          idToken,
          ...(target.kind === "coords"
            ? { latitude: target.latitude, longitude: target.longitude }
            : { postalCode: target.postalCode }),
          radiusMi: miles,
          limit: ADVISOR_PAGE_SIZE,
          offset,
        });
        // A slower earlier query must never overwrite a newer one.
        if (token !== requestRef.current) return;
        setMeta(result.meta);
        setAttribution(result.attribution ?? null);
        setCards((previous) =>
          offset === 0 ? result.items : [...previous, ...result.items],
        );
      } catch (caught) {
        if (token !== requestRef.current) return;
        const message =
          caught instanceof Error
            ? caught.message
            : "Advisors are unavailable right now.";
        if (offset === 0) {
          // A fresh search that failed has nothing to show, and its old paging
          // cursor now points into a list that no longer exists.
          setError(message);
          setCards([]);
          setMeta(null);
        } else {
          // A failed page must not take the page already on screen with it.
          setPageError(message);
        }
      } finally {
        if (token === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [getIdToken],
  );

  useEffect(() => {
    if (!anchor) return;
    void runSearch(anchor, radiusMi, 0);
  }, [anchor, radiusMi, runSearch]);

  const handleUseLocation = useCallback(() => {
    void location.request();
  }, [location]);

  const handlePostalCode = useCallback((postalCode: string) => {
    setAnchor({ kind: "postal", postalCode });
  }, []);

  if (!anchor) {
    return (
      <LocationPrompt
        denied={
          location.status === "denied" || location.status === "unavailable"
        }
        busy={location.status === "locating"}
        heading="Advisors near you"
        onUseLocation={handleUseLocation}
        onSearchPostalCode={handlePostalCode}
        testId="advisors-location-prompt"
        useLocationTestId="advisors-use-location"
        postalInputTestId="advisors-postal-input"
      />
    );
  }

  const narrowed =
    meta?.radiusAdjusted && meta.radiusMi
      ? `Within ${meta.radiusMi} mi.`
      : null;

  return (
    <div className="space-y-4" data-testid="advisors-nearby">
      <SegmentedTabs
        value={String(radiusMi)}
        onValueChange={(value) => setRadiusMi(Number(value))}
        options={RADIUS_OPTIONS}
        disabled={loading}
      />

      {narrowed ? (
        <p className="type-footnote text-muted-foreground">{narrowed}</p>
      ) : null}

      {error && !loading ? (
        // A failed search must still offer the ZIP box. "Try again" only
        // re-runs the anchor that just failed, so on its own it strands anyone
        // whose ZIP was the problem — the only way out was to leave the tab and
        // come back, which remounts this component and clears the anchor.
        <QuietBlock
          title={error}
          subtitle="Try again, or search a different ZIP."
          testId="advisors-error"
        >
          <div className="flex w-full flex-col items-center gap-4">
            <Button
              type="button"
              variant="none"
              effect="fill"
              size="lg"
              onClick={() => void runSearch(anchor, radiusMi, 0)}
            >
              Try again
            </Button>
            <PostalCodeForm
              busy={loading}
              initialValue={anchor.kind === "postal" ? anchor.postalCode : ""}
              onSearch={handlePostalCode}
              testId="advisors-postal-input"
            />
          </div>
        </QuietBlock>
      ) : null}

      {!error && !loading && cards.length === 0 ? (
        // Coordinates can be perfectly good and still match nobody — FINRA is a
        // US register. Offer the one input that can actually help rather than a
        // dead end.
        <QuietBlock
          title="Nothing nearby"
          subtitle="Try a US ZIP."
          testId="advisors-empty"
        >
          <PostalCodeForm
            busy={loading}
            initialValue={anchor.kind === "postal" ? anchor.postalCode : ""}
            onSearch={handlePostalCode}
            testId="advisors-postal-input"
          />
        </QuietBlock>
      ) : null}

      {error || (!loading && cards.length === 0) ? null : (
        <SettingsGroup
          title={meta?.grouped ? "Offices" : "Advisors"}
          separatorInset
        >
          {loading ? (
            <DirectoryLoadingRows testId="advisors-loading" />
          ) : (
            cards.map((card) => {
              const distance = formatDistance(card.distanceMiles);
              return (
                <SettingsRow
                  key={`${card.kind}-${card.id}`}
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{card.name ?? "Advisor"}</span>
                      {card.hasDisclosures ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-amber-500"
                          role="img"
                          aria-label="Has disclosures"
                        />
                      ) : null}
                    </span>
                  }
                  description={formatAdvisorSubtitle(card) ?? undefined}
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

      {meta?.hasMore && typeof meta.nextOffset === "number" && !loading ? (
        <div className="flex flex-col items-center gap-2">
          {pageError ? (
            <p className="type-footnote text-muted-foreground" role="status">
              {pageError}
            </p>
          ) : null}
          <Button
            type="button"
            variant="none"
            effect="fill"
            size="sm"
            disabled={loadingMore}
            onClick={() => {
              if (anchor && typeof meta.nextOffset === "number") {
                void runSearch(anchor, radiusMi, meta.nextOffset);
              }
            }}
          >
            {loadingMore ? "Loading…" : pageError ? "Try again" : "Show more"}
          </Button>
        </div>
      ) : null}

      {cards.length > 0 ? (
        <DirectoryAttributionFooter
          attribution={attribution}
          stale={meta?.cache === "warm"}
          testId="advisors-attribution"
        />
      ) : null}

      {/* An office and an adviser open different surfaces on purpose: a branch
          row has no CRD, so there is no profile to fetch and nothing that would
          justify showing it as a person. */}
      <AdvisorDetailSurface
        card={selected?.kind === "advisor" ? selected : null}
        open={selected?.kind === "advisor"}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        getIdToken={getIdToken}
      />

      <OfficeDetailSurface
        card={selected?.kind === "branch" ? selected : null}
        open={selected?.kind === "branch"}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </div>
  );
}
