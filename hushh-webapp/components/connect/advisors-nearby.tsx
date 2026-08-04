"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { AdvisorDetailSurface } from "@/components/connect/advisor-detail-surface";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/lib/morphy-ux/button";
import { SegmentedTabs } from "@/lib/morphy-ux/ui";
import { useCurrentLocation } from "@/lib/one-location/use-current-location";
import {
  ADVISOR_PAGE_SIZE,
  ADVISOR_RADIUS_OPTIONS_MI,
  AdvisorDirectoryService,
  formatAdvisorSubtitle,
  formatDistance,
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

function LoadingRows() {
  return (
    <div className="space-y-3 px-1 py-2" data-testid="advisors-loading">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-11 w-full rounded-xl" />
      ))}
    </div>
  );
}

/**
 * The one way in when coordinates cannot answer the question — location was
 * refused, or the coordinates are real but the directory covers nobody there.
 * FINRA is a US register, so anyone outside the US has working GPS and an
 * empty list; a ZIP is the only thing that helps them.
 */
function PostalCodeForm({
  busy,
  initialValue = "",
  onSearch,
}: {
  busy: boolean;
  initialValue?: string;
  onSearch: (postalCode: string) => void;
}) {
  const [postalCode, setPostalCode] = useState(initialValue);

  return (
    <form
      className="flex w-full gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = postalCode.trim();
        if (trimmed) onSearch(trimmed);
      }}
    >
      <Input
        value={postalCode}
        onChange={(event) => setPostalCode(event.target.value)}
        placeholder="ZIP"
        inputMode="numeric"
        aria-label="ZIP code"
        className="h-11"
        data-testid="advisors-postal-input"
      />
      <Button
        type="submit"
        variant="none"
        effect="fill"
        size="lg"
        disabled={busy || !postalCode.trim()}
      >
        Search
      </Button>
    </form>
  );
}

/** A centred non-result: one line, and the single thing worth doing next. */
function QuietBlock({
  title,
  subtitle,
  testId,
  children,
}: {
  title: string;
  subtitle?: string;
  testId: string;
  children?: React.ReactNode;
}) {
  return (
    <section
      className="mx-auto flex w-full max-w-[26rem] flex-col items-center py-12 text-center"
      data-testid={testId}
    >
      <h2 className="type-title3 text-foreground">{title}</h2>
      {subtitle ? (
        <p className="mt-2 type-callout text-muted-foreground">{subtitle}</p>
      ) : null}
      {children ? <div className="mt-6 w-full">{children}</div> : null}
    </section>
  );
}

/** One calm block: why we need location, and the single tap that grants it. */
function LocationPrompt({
  denied,
  busy,
  onUseLocation,
  onSearchPostalCode,
}: {
  denied: boolean;
  busy: boolean;
  onUseLocation: () => void;
  onSearchPostalCode: (postalCode: string) => void;
}) {
  const [showPostal, setShowPostal] = useState(denied);

  useEffect(() => {
    if (denied) setShowPostal(true);
  }, [denied]);

  return (
    <section
      className="mx-auto flex w-full max-w-[26rem] flex-col items-center py-14 text-center"
      data-testid="advisors-location-prompt"
    >
      <h2 className="type-title2 text-foreground">
        {denied ? "Location is off" : "Advisors near you"}
      </h2>
      <p className="mt-2 type-callout text-muted-foreground">
        {denied ? "Search by ZIP instead." : "See who's close by."}
      </p>

      {denied ? null : (
        <Button
          type="button"
          variant="blue-gradient"
          effect="fill"
          size="lg"
          fullWidth
          className="mt-8"
          disabled={busy}
          onClick={onUseLocation}
          data-testid="advisors-use-location"
        >
          {busy ? "Locating…" : "Use location"}
        </Button>
      )}

      {showPostal ? (
        <div className="mt-6 w-full">
          <PostalCodeForm busy={busy} onSearch={onSearchPostalCode} />
        </div>
      ) : (
        <Button
          type="button"
          variant="none"
          effect="fade"
          size="sm"
          className="mt-3 text-muted-foreground"
          onClick={() => setShowPostal(true)}
        >
          Use a ZIP
        </Button>
      )}
    </section>
  );
}

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
        onUseLocation={handleUseLocation}
        onSearchPostalCode={handlePostalCode}
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
        <QuietBlock title={error} testId="advisors-error">
          <Button
            type="button"
            variant="none"
            effect="fill"
            size="lg"
            onClick={() => void runSearch(anchor, radiusMi, 0)}
          >
            Try again
          </Button>
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
          />
        </QuietBlock>
      ) : null}

      {error || (!loading && cards.length === 0) ? null : (
        <SettingsGroup
          title={meta?.grouped ? "Offices" : "Advisors"}
          separatorInset
        >
          {loading ? (
            <LoadingRows />
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
                  chevron={card.kind === "advisor"}
                  onClick={
                    card.kind === "advisor"
                      ? () => setSelected(card)
                      : undefined
                  }
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
        <p className="type-caption text-center text-muted-foreground">
          FINRA BrokerCheck
        </p>
      ) : null}

      <AdvisorDetailSurface
        card={selected}
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        getIdToken={getIdToken}
      />
    </div>
  );
}
