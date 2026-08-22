"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2 } from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { InsuranceAgentDetailSurface } from "@/components/connect/insurance-agent-detail-surface";
import {
  DirectoryAttributionFooter,
  DirectoryLoadingRows,
  ExpandRadiusButton,
  LocationPrompt,
  NearbyDirectorySearch,
  NearbyDistanceBadge,
  NearbyTagBadge,
  PostalCodeForm,
  QuietBlock,
} from "@/components/connect/nearby-directory-ui";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { Button } from "@/lib/morphy-ux/button";
import { SegmentedTabs } from "@/lib/morphy-ux/ui";
import { useCurrentLocation } from "@/lib/one-location/use-current-location";
import {
  INSURANCE_AGENT_PAGE_SIZE,
  INSURANCE_AGENT_RADIUS_OPTIONS_MI,
  InsuranceAgentDirectoryService,
  agencyStatusLabel,
  formatAgentDistance,
  formatAgentSubtitle,
  type InsuranceAgentAttribution,
  type InsuranceAgentCard,
  type InsuranceAgentSearchMeta,
} from "@/lib/services/insurance-agent-directory-service";

type Anchor =
  | { kind: "coords"; latitude: number; longitude: number }
  | { kind: "postal"; postalCode: string };

const RADIUS_OPTIONS = INSURANCE_AGENT_RADIUS_OPTIONS_MI.map((miles) => ({
  value: String(miles),
  label: `${miles} mi`,
}));

/**
 * Insurance agencies near the account's current position.
 *
 * The sibling of `AdvisorsNearby`, and deliberately the same shape: position
 * comes from the shared location bus, so opening this never re-prompts a user
 * who already granted location elsewhere — including on the advisers view right
 * next to it.
 *
 * One upstream behaviour drives the empty state: the locator answers HTTP 200
 * with zero rows both for a place it does not cover and for a ZIP it cannot
 * parse. Neither is an error, so neither is shown as one — both land on the
 * same quiet block offering the one input that can help.
 */
export function InsuranceAgentsNearby({
  getIdToken,
}: {
  getIdToken: () => Promise<string | null>;
}) {
  const location = useCurrentLocation();

  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [radiusMi, setRadiusMi] = useState<number>(10);
  const [cards, setCards] = useState<InsuranceAgentCard[]>([]);
  const [meta, setMeta] = useState<InsuranceAgentSearchMeta | null>(null);
  const [attribution, setAttribution] =
    useState<InsuranceAgentAttribution | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A failed extra page. Kept apart from `error` so it never hides the list. */
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<InsuranceAgentCard | null>(null);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 200);

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
        if (!idToken) throw new Error("Sign in to see agents.");
        const result = await InsuranceAgentDirectoryService.searchNearby({
          idToken,
          ...(target.kind === "coords"
            ? { latitude: target.latitude, longitude: target.longitude }
            : { postalCode: target.postalCode }),
          radiusMi: miles,
          limit: INSURANCE_AGENT_PAGE_SIZE,
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
            : "Agents are unavailable right now.";
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

  const filteredCards = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    if (!needle) return cards;
    return cards.filter((card) =>
      [card.name, card.agencyType, card.tier, card.city, card.state]
        .filter((field): field is string => Boolean(field))
        .some((field) => field.toLowerCase().includes(needle)),
    );
  }, [cards, debouncedQuery]);

  const nextRadiusMi = INSURANCE_AGENT_RADIUS_OPTIONS_MI.find(
    (mi) => mi > radiusMi,
  );

  if (!anchor) {
    return (
      <LocationPrompt
        denied={
          location.status === "denied" || location.status === "unavailable"
        }
        busy={location.status === "locating"}
        heading="Agents near you"
        onUseLocation={handleUseLocation}
        onSearchPostalCode={handlePostalCode}
        testId="insurance-agents-location-prompt"
        useLocationTestId="insurance-agents-use-location"
        postalInputTestId="insurance-agents-postal-input"
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="insurance-agents-nearby">
      <SegmentedTabs
        value={String(radiusMi)}
        onValueChange={(value) => setRadiusMi(Number(value))}
        options={RADIUS_OPTIONS}
        disabled={loading}
      />

      {!error && !loading && cards.length > 0 ? (
        <NearbyDirectorySearch
          value={query}
          onChange={setQuery}
          placeholder="Search agencies"
          testId="insurance-agents-search"
        />
      ) : null}

      {error && !loading ? (
        // Same reasoning as the advisers directory: keep the ZIP box reachable
        // on a failure, or a bad ZIP is a dead end until the tab is remounted.
        <QuietBlock
          title={error}
          subtitle="Try again, or search a different ZIP."
          testId="insurance-agents-error"
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
              testId="insurance-agents-postal-input"
            />
          </div>
        </QuietBlock>
      ) : null}

      {!error && !loading && cards.length === 0 ? (
        // Coordinates can be perfectly good and still match nobody — the
        // locator covers US Nationwide agencies only. Offer the one input that
        // can actually help rather than a dead end.
        <QuietBlock
          title="Nothing nearby"
          subtitle="Try a US ZIP, or search a wider radius."
          testId="insurance-agents-empty"
        >
          <div className="flex w-full flex-col items-center gap-4">
            <PostalCodeForm
              busy={loading}
              initialValue={anchor.kind === "postal" ? anchor.postalCode : ""}
              onSearch={handlePostalCode}
              testId="insurance-agents-postal-input"
            />
            <ExpandRadiusButton
              nextRadiusMi={nextRadiusMi}
              onExpand={setRadiusMi}
            />
          </div>
        </QuietBlock>
      ) : null}

      {!error && !loading && cards.length > 0 && filteredCards.length === 0 ? (
        <QuietBlock
          title="No matches"
          subtitle="Try a different name."
          testId="insurance-agents-search-empty"
        >
          <Button
            type="button"
            variant="none"
            effect="fill"
            size="sm"
            onClick={() => setQuery("")}
          >
            Clear search
          </Button>
        </QuietBlock>
      ) : null}

      {error ||
      (!loading && cards.length === 0) ||
      (!loading && filteredCards.length === 0) ? null : (
        <SettingsGroup title="Agencies" separatorInset>
          {loading ? (
            <DirectoryLoadingRows testId="insurance-agents-loading" />
          ) : (
            filteredCards.map((card) => {
              const distance = formatAgentDistance(card.distanceMiles);
              // Roughly one agency in fifty carries a standing status; the rest
              // share one default that is dropped rather than repeated on every
              // row. Same weight as the advisers' disclosure marker beside it.
              const status = agencyStatusLabel(card);
              return (
                <SettingsRow
                  key={card.id}
                  icon={Building2}
                  iconTone="blue"
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{card.name ?? "Agency"}</span>
                      <NearbyTagBadge>Agency</NearbyTagBadge>
                      {status ? (
                        <span className="type-caption shrink-0 rounded-full bg-[color:var(--app-accent)]/10 px-1.5 py-0.5 text-[color:var(--app-accent)]">
                          {status}
                        </span>
                      ) : null}
                    </span>
                  }
                  description={formatAgentSubtitle(card) ?? undefined}
                  density="compact"
                  chevron
                  onClick={() => setSelected(card)}
                  trailing={<NearbyDistanceBadge distance={distance} />}
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
          testId="insurance-agents-attribution"
        />
      ) : null}

      <InsuranceAgentDetailSurface
        card={selected}
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </div>
  );
}
