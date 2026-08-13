"use client";

/**
 * "Around you" — public-association records near a place the advisor chose.
 *
 * Two things this screen has to get right.
 *
 * Coverage honesty: only one market is approved, so most locations return a
 * normal success with an empty list. That is an answer, not a failure, and each
 * shape of it offers the one move that helps — pick a different place.
 *
 * Restraint: the location form used to sit at the top of every visit, and the
 * filters offered four facets where the data supports one. Both are summoned
 * now, not presented.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapPin, Star, UserRound } from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { NearbyFilterBar } from "@/components/ria/nearby/nearby-filters";
import { NearbyLocationDialog } from "@/components/ria/nearby/nearby-location-dialog";
import { NearbyRecordSheet } from "@/components/ria/nearby/nearby-record-sheet";
import { useAuth } from "@/hooks/use-auth";
import { useCurrentLocation } from "@/lib/one-location/use-current-location";
import { Button } from "@/lib/morphy-ux/button";
import { Skeleton } from "@/components/ui/skeleton";
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

/** Enough to judge a place at a glance; the ranking decides which five. */
const VISIBLE_RECORDS = 5;

/** One line per state. The reason code decides which; the advisor reads six words. */
const COVERAGE_COPY: Record<string, string> = {
  NO_APPROVED_MARKET_DATA: "No records here yet.",
  COUNTRY_CONTEXT_DOES_NOT_MATCH_APPROVED_MARKET: "That country doesn't match this area.",
  POSTAL_CODE_NOT_IN_GEOGRAPHY_INDEX: "No postal map for this country yet.",
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const requestSeq = useRef(0);
  // Read at fetch time rather than depended on, so a lane change — which must
  // not refetch — cannot drag stale filters into the request either.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // A granted position becomes the anchor, but never overrides a place the
  // advisor typed — a late GPS fix would otherwise move them somewhere else.
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

  // Lane is deliberately NOT sent upstream. Every record carries its lane, so
  // filtering client-side is exactly equivalent to the server's own lane filter
  // — and it keeps one unfiltered response to count lanes from. Sector stays
  // server-side, where its subset semantics live.
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
          filters: { ...nextFilters, lanes: [] },
        });
        if (seq !== requestSeq.current) return;
        setResult(response);
      } catch (caught) {
        if (seq !== requestSeq.current) return;
        setError(caught instanceof Error ? caught.message : "Nearby is unavailable.");
        setResult(null);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [user],
  );

  // Held in a ref so a re-render cannot retrigger the fetch. runSearch closes
  // over `user`, and an auth object whose identity changes each render would
  // otherwise put this effect in a request loop.
  const runSearchRef = useRef(runSearch);
  useEffect(() => {
    runSearchRef.current = runSearch;
  }, [runSearch]);

  useEffect(() => {
    if (!anchor) return;
    void runSearchRef.current(anchor, filtersRef.current);
    // Lane changes never refetch — they filter what is already on screen.
  }, [anchor, filters.tag, filters.radiusKm, filters.minimumConfidenceGrade]);

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
              .filter((e) => e.status === "shortlisted")
              .map((e) => e.target_key.replace(/^nws:/, "")),
          ),
        );
      } catch {
        // A shortlist that will not load must not block discovery.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const all = useMemo(() => result?.results ?? [], [result?.results]);
  const laneCounts = useMemo(() => computeLaneCounts(all), [all]);
  const tags = useMemo(() => availableTags(all), [all]);
  const records = useMemo(() => {
    const lane = filters.lanes[0];
    return lane ? all.filter((r) => r.lane === lane) : all;
  }, [all, filters.lanes]);

  // The service answers with everything it has. Rendering all of it turns a
  // ranked shortlist into a scroll, and the ranking is the product — the top
  // few are the ones worth an advisor's attention. The rest stay one tap away.
  const visible = useMemo(
    () => (expanded ? records : records.slice(0, VISIBLE_RECORDS)),
    [records, expanded],
  );
  const hidden = records.length - visible.length;

  // Collapse again whenever the result set changes underneath, so a filter
  // change never lands the advisor halfway down an expanded list.
  useEffect(() => {
    setExpanded(false);
  }, [anchor, filters.lanes, filters.tag]);

  const handleShortlist = useCallback(
    async (record: NearbyRecord) => {
      const idToken = await user?.getIdToken();
      if (!idToken) return;
      const already = shortlisted.has(record.personId);
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
      }
    },
    [shortlisted, user],
  );

  const picker = (
    <NearbyLocationDialog
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      onAnchor={(next) => {
        setFilters(DEFAULT_NEARBY_FILTERS);
        setAnchor(next);
      }}
    />
  );

  // Nothing chosen yet: one action, one quiet alternative.
  if (!anchor) {
    return (
      <SettingsGroup>
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <MapPin className="h-5 w-5 text-muted-foreground" aria-hidden />
          <p className="type-headline">Look around a place</p>
          <Button
            type="button"
            variant="blue-gradient"
            effect="fill"
            size="lg"
            disabled={location.status === "locating"}
            onClick={() => void location.request()}
          >
            Use my location
          </Button>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className={cn(MUTED_TEXT, "underline-offset-4 hover:underline")}
          >
            Enter a place
          </button>
        </div>
        {picker}
      </SettingsGroup>
    );
  }

  const coverage = result?.coverage;
  const covered = coverage?.status === "COVERED";
  const place = covered
    ? (coverage?.marketLabel ?? "Covered")
    : anchor.kind === "postal"
      ? `${anchor.postalCode} ${anchor.countryCode}`
      : `${anchor.latitude.toFixed(2)}, ${anchor.longitude.toFixed(2)}`;

  return (
    <div className="flex flex-col gap-4">
      <SettingsGroup>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate type-headline">{place}</p>
            {covered ? (
              <p className={MUTED_TEXT}>
                {hidden > 0
                  ? `Top ${visible.length} of ${records.length}`
                  : `${records.length} public ${records.length === 1 ? "record" : "records"}`}
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="none"
            effect="fade"
            size="sm"
            onClick={() => setPickerOpen(true)}
          >
            Change
          </Button>
        </div>

        {covered ? (
          <div className="px-4 pb-4">
            <NearbyFilterBar
              filters={filters}
              onChange={setFilters}
              laneCounts={laneCounts}
              tags={tags}
              disabled={loading}
            />
          </div>
        ) : null}
      </SettingsGroup>

      {loading ? (
        <SettingsGroup>
          <div className="flex flex-col gap-2 p-4" aria-busy role="status">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        </SettingsGroup>
      ) : error ? (
        <Quiet title={error} actionLabel="Try again" onAction={() => void runSearch(anchor, filters)} />
      ) : !covered ? (
        <Quiet
          title={COVERAGE_COPY[coverage?.reasonCode ?? ""] ?? "Nothing here yet."}
          actionLabel="Enter a place"
          onAction={() => setPickerOpen(true)}
        />
      ) : records.length === 0 ? (
        <Quiet
          title="No matches."
          actionLabel="Clear filters"
          onAction={() => setFilters(DEFAULT_NEARBY_FILTERS)}
        />
      ) : (
        <SettingsGroup separatorInset>
          {visible.map((record) => (
            <SettingsRow
              key={record.personId}
              icon={UserRound}
              iconTone="blue"
              density="compact"
              chevron
              title={record.displayName ?? "Public record"}
              description={[record.headline, record.organization].filter(Boolean).join(" · ")}
              onClick={() => setSelected(record)}
              trailing={
                <span className="flex items-center gap-2">
                  {shortlisted.has(record.personId) ? (
                    <Star
                      className="h-3.5 w-3.5 fill-current text-[color:var(--app-accent-fg)]"
                      aria-label="Shortlisted"
                    />
                  ) : null}
                  {/* Ranked by nearbyRankScore, so that is the number shown. */}
                  <span className="type-footnote tabular-nums">
                    {formatScore(record.nearbyRankScore)}
                  </span>
                </span>
              }
            />
          ))}
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full px-4 py-3 text-left type-footnote text-[color:var(--app-accent-fg)]"
            >
              Show {hidden} more
            </button>
          ) : null}
        </SettingsGroup>
      )}

      {covered && records.length > 0 ? (
        <p className={cn(MUTED_TEXT, "px-1")}>
          Public work associations. Not homes, not net worth.
        </p>
      ) : null}

      <NearbyRecordSheet
        record={selected}
        open={Boolean(selected)}
        onOpenChange={(next) => !next && setSelected(null)}
        onShortlist={handleShortlist}
        shortlisted={selected ? shortlisted.has(selected.personId) : false}
      />
      {picker}
    </div>
  );
}

function Quiet({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <SettingsGroup>
      <div className={cn(SUBCARD_SURFACE, "flex flex-col items-center gap-3 p-8 text-center")}>
        <p className="type-headline">{title}</p>
        <Button type="button" variant="none" effect="fill" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
    </SettingsGroup>
  );
}
