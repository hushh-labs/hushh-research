"use client";

/**
 * "Around you" — public-association records near a place the advisor chose.
 *
 * The central job of this component is to be honest about coverage. Only one
 * market is approved today, so most locations on earth return a normal success
 * with an empty list. That is a correct answer, and each of its three shapes
 * gets its own explanation and its own next move. "No results found" would read
 * as failure and teach an advisor to distrust the surface.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapPinOff, Search, Star, UserRound } from "lucide-react";

import { InlineLoadingState } from "@/components/app-ui/inline-loading-state";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { NearbyFilterBar } from "@/components/ria/nearby/nearby-filters";
import { NearbyLocationInput } from "@/components/ria/nearby/nearby-location-input";
import { NearbyRecordSheet } from "@/components/ria/nearby/nearby-record-sheet";
import { useAuth } from "@/hooks/use-auth";
import { useCurrentLocation } from "@/lib/one-location/use-current-location";
import { Button } from "@/lib/morphy-ux/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import { MUTED_TEXT, SUBCARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import {
  DEFAULT_NEARBY_FILTERS,
  NwsNearbyService,
  availableTags,
  formatScore,
  laneCounts as computeLaneCounts,
  type NearbyAnchor,
  type NearbyDiscoverResult,
  type NearbyFilters,
  type NearbyRecord,
} from "@/lib/services/nws-nearby-service";
import { cn } from "@/lib/utils";

/**
 * Each coverage state says what is true and what to do next.
 *
 * The upstream ships its own `message` for every one of these. It is accurate
 * but written for an integrator, not an advisor, so it is replaced here rather
 * than echoed — while the reason code it is keyed on is carried through
 * untouched.
 */
const COVERAGE_COPY: Record<string, { title: string; body: string }> = {
  NO_APPROVED_MARKET_DATA: {
    title: "We understand this location.",
    body: "We don't have reviewed records here yet. Nothing is hidden — there is nothing to show.",
  },
  COUNTRY_CONTEXT_DOES_NOT_MATCH_APPROVED_MARKET: {
    title: "That country doesn't match this area.",
    body: "Search by coordinates instead, or correct the country.",
  },
  POSTAL_CODE_NOT_IN_GEOGRAPHY_INDEX: {
    title: "We don't have postal maps for this country yet.",
    body: "Try coordinates instead.",
  },
};

const FALLBACK_COVERAGE_COPY = {
  title: "Nothing to show here yet.",
  body: "This location is understood, but no reviewed records cover it.",
};

export function NearbyAroundYou() {
  const { user } = useAuth();
  const location = useCurrentLocation();

  const [anchor, setAnchor] = useState<NearbyAnchor | null>(null);
  const [filters, setFilters] = useState<NearbyFilters>(DEFAULT_NEARBY_FILTERS);
  const [result, setResult] = useState<NearbyDiscoverResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<NearbyRecord | null>(null);
  const [shortlisted, setShortlisted] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Filters are session-only by design, so nothing here is persisted. The ref
  // exists purely to drop a response whose request has been superseded.
  const requestSeq = useRef(0);

  // A granted position becomes the anchor, but never overrides a place the
  // advisor typed: they chose that on purpose, and a late GPS fix arriving
  // afterwards would silently move them somewhere else.
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
    async (nextAnchor: NearbyAnchor, nextFilters: NearbyFilters) => {
      const idToken = await user?.getIdToken();
      if (!idToken) return;

      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const response = await NwsNearbyService.discover({
          idToken,
          anchor: nextAnchor,
          filters: nextFilters,
        });
        if (seq !== requestSeq.current) return;
        setResult(response);
      } catch (caught) {
        if (seq !== requestSeq.current) return;
        setError(
          caught instanceof Error ? caught.message : "Nearby is unavailable right now.",
        );
        setResult(null);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [user],
  );

  useEffect(() => {
    if (!anchor) return;
    void runSearch(anchor, filters);
  }, [anchor, filters, runSearch]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const idToken = await user?.getIdToken();
      if (!idToken) return;
      try {
        const entries = await NwsNearbyService.listShortlist({ idToken });
        if (cancelled) return;
        setShortlisted(
          new Set(
            entries
              .filter((entry) => entry.status === "shortlisted")
              .map((entry) => entry.target_key.replace(/^nws:/, "")),
          ),
        );
      } catch {
        // A shortlist that will not load must not block discovery; the star
        // simply starts empty and the next save reconciles it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Memoised so the fallback empty array is not a new identity every render,
  // which would recompute the lane counts and sector list on each pass.
  const records = useMemo(() => result?.results ?? [], [result?.results]);
  const laneCounts = useMemo(() => computeLaneCounts(records), [records]);
  const tags = useMemo(() => availableTags(records), [records]);

  const handleShortlist = useCallback(
    async (record: NearbyRecord) => {
      const idToken = await user?.getIdToken();
      if (!idToken) return;
      const already = shortlisted.has(record.personId);
      setSaving(true);
      // Optimistic: the star is the whole feedback signal, and a round trip
      // before it moves reads as a dead control.
      setShortlisted((current) => {
        const next = new Set(current);
        if (already) next.delete(record.personId);
        else next.add(record.personId);
        return next;
      });
      try {
        await NwsNearbyService.shortlist({
          idToken,
          record,
          action: already ? "pass" : "shortlist",
        });
      } catch {
        setShortlisted((current) => {
          const next = new Set(current);
          if (already) next.add(record.personId);
          else next.delete(record.personId);
          return next;
        });
      } finally {
        setSaving(false);
      }
    },
    [shortlisted, user],
  );

  if (!anchor) {
    return (
      <SettingsGroup
        eyebrow="Around you"
        description="Public professionals associated with a place. Choose where to look."
      >
        <div className="p-4">
          <NearbyLocationInput
            onAnchor={setAnchor}
            locationStatus={location.status}
            onUseLocation={() => void location.request()}
            busy={location.status === "locating"}
          />
        </div>
      </SettingsGroup>
    );
  }

  const coverage = result?.coverage;
  const covered = coverage?.status === "COVERED";

  return (
    <div className="flex flex-col gap-4">
      <SettingsGroup eyebrow="Around you">
        <div className="flex flex-col gap-4 p-4">
          <NearbyLocationInput
            onAnchor={setAnchor}
            locationStatus={location.status}
            onUseLocation={() => void location.request()}
            busy={loading || location.status === "locating"}
          />
          {coverage ? (
            <div className="flex flex-wrap items-center gap-2">
              {covered ? (
                <StatusPill tone="ready">
                  {coverage.marketLabel ?? "Covered"}
                </StatusPill>
              ) : (
                <StatusPill tone="neutral">Not covered</StatusPill>
              )}
              {covered ? (
                <span className={MUTED_TEXT}>
                  {result?.summary.returnedCount ?? 0} public records
                </span>
              ) : null}
              {result?.snapshot.complete === false ? (
                <StatusPill tone="pending">Provisional · early dataset</StatusPill>
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsGroup>

      {covered ? (
        <SettingsGroup eyebrow="Filters">
          <div className="p-4">
            <NearbyFilterBar
              filters={filters}
              onChange={setFilters}
              laneCounts={laneCounts}
              tags={tags}
              disabled={loading}
            />
          </div>
        </SettingsGroup>
      ) : null}

      {loading ? (
        <SettingsGroup>
          <div className="flex flex-col gap-2 p-4" aria-busy role="status">
            <InlineLoadingState label="Looking around" />
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        </SettingsGroup>
      ) : error ? (
        <SettingsGroup>
          <EmptyState
            icon={<MapPinOff className="h-5 w-5" aria-hidden />}
            title={error}
            action={
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                onClick={() => void runSearch(anchor, filters)}
              >
                Try again
              </Button>
            }
          />
        </SettingsGroup>
      ) : !covered && coverage ? (
        <SettingsGroup>
          <CoverageNotice reasonCode={coverage.reasonCode} />
        </SettingsGroup>
      ) : records.length === 0 ? (
        <SettingsGroup>
          <EmptyState
            icon={<Search className="h-5 w-5" aria-hidden />}
            title="No records match these filters."
            description="Widen the focus or lower the confidence floor."
            action={
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                onClick={() => setFilters(DEFAULT_NEARBY_FILTERS)}
              >
                Reset filters
              </Button>
            }
          />
        </SettingsGroup>
      ) : (
        <SettingsGroup
          eyebrow="Public records"
          description="NWS is public professional network strength. Not net worth."
          separatorInset
        >
          {records.map((record) => (
            <SettingsRow
              key={record.personId}
              icon={UserRound}
              iconTone="blue"
              density="compact"
              chevron
              title={record.displayName ?? "Public record"}
              description={[record.headline, record.organization]
                .filter(Boolean)
                .join(" · ")}
              onClick={() => setSelected(record)}
              trailing={
                <span className="flex items-center gap-2">
                  {shortlisted.has(record.personId) ? (
                    <Star
                      className="h-3.5 w-3.5 fill-current text-[color:var(--app-accent-fg)]"
                      aria-label="Shortlisted"
                    />
                  ) : null}
                  <span className={cn(MUTED_TEXT, "tabular-nums")}>
                    {record.publicLocation.distanceBand}
                  </span>
                  {/* The list ranks by nearbyRankScore, so that is the number
                      shown. Displaying globalNws here would look mis-sorted. */}
                  <span className="type-footnote tabular-nums">
                    {formatScore(record.nearbyRankScore)}
                  </span>
                </span>
              }
            />
          ))}
        </SettingsGroup>
      )}

      <NearbyRecordSheet
        record={selected}
        open={Boolean(selected)}
        onOpenChange={(next) => {
          if (!next) setSelected(null);
        }}
        onShortlist={handleShortlist}
        shortlisted={selected ? shortlisted.has(selected.personId) : false}
        saving={saving}
      />
    </div>
  );
}

function CoverageNotice({ reasonCode }: { reasonCode: string | null }) {
  const copy =
    (reasonCode ? COVERAGE_COPY[reasonCode] : undefined) ?? FALLBACK_COVERAGE_COPY;

  return (
    <div className={cn(SUBCARD_SURFACE, "flex flex-col gap-1.5 p-6 text-center")}>
      <p className="type-headline">{copy.title}</p>
      <p className={MUTED_TEXT}>{copy.body}</p>
    </div>
  );
}
