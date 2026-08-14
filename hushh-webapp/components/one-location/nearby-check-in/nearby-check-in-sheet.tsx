"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  Clock3,
  Compass,
  Loader2,
  LocateFixed,
  MapPin,
  Search,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { relationshipCta } from "@/lib/connections/relationship-label";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import {
  readLastKnownFix,
  rememberLastKnownFix,
  rememberLocationGrant,
} from "@/lib/one-location/location-grant-memory";
import { locationBlockReason } from "@/lib/one-location/location-readiness";
import { OneLocationService } from "@/lib/one-location/service";
import {
  ONE_LOCATION_NEARBY_COARSE_ACCURACY_METERS,
  ONE_LOCATION_NEARBY_MAX_ACCURACY_METERS,
} from "@/lib/one-location/nearby-check-in-availability";
import type {
  OneLocationNearbyAttendee,
  OneLocationNearbyPlaceCategory,
  OneLocationNearbyPlaceSuggestion,
  OneLocationNearbyPresenceState,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { isNative } from "@/lib/capacitor/platform";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

const DURATIONS = [
  { value: 30 as const, label: "30 min" },
  { value: 60 as const, label: "1 hour" },
  { value: 120 as const, label: "2 hours" },
];

const PLACE_CATEGORIES: Array<{
  value: OneLocationNearbyPlaceCategory;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "food_drink", label: "Food & drink" },
  { value: "health", label: "Health" },
  { value: "shopping_services", label: "Shops & services" },
  { value: "hotels_stays", label: "Hotels" },
  { value: "education", label: "Education" },
  { value: "outdoors_landmarks", label: "Outdoors" },
  { value: "transit", label: "Transit" },
];

const NEARBY_RADIUS_METERS = 500;

/**
 * Past this distance from the anchored place, "you're checked in here" stops
 * being a fair description of where the owner is, so the card says so plainly
 * instead of quietly leaving them visible somewhere they have left.
 */
const NEARBY_DRIFT_NUDGE_METERS = 250;

const EMPTY_NEARBY_STATE: OneLocationNearbyPresenceState = {
  presence: null,
  attendees: [],
};

type LocationRecovery = "app-settings" | "location-settings" | null;
type PresenceLoadResult = OneLocationNearbyPresenceState | "error" | null;

/**
 * How the point driving the place list was obtained. A degraded fix still
 * produces a usable picker, so this drives an explanatory chip rather than an
 * error: the owner is the authority on which venue they are standing in, and
 * the backend still runs the authoritative plausibility check at check-in.
 */
type PointOrigin = "fresh" | "last-known";

/**
 * A fix reused after a failed refresh is only honest for as long as the owner
 * plausibly has not moved. Past this we stop offering it as "where you are".
 */
const LAST_KNOWN_POINT_MAX_AGE_MS = 10 * 60 * 1_000;

/**
 * The same idea, for a fix restored from a previous session rather than taken
 * during this one.
 *
 * Deliberately longer. The in-session budget above governs a silent swap — the
 * drawer keeps working and says little — so it has to be tight. A restored fix
 * is always announced, always dated, and always requires the owner to choose a
 * specific place, which the backend then plausibility-checks at check-in. The
 * honest comparison is not "an hour-old fix versus a current one", it is "an
 * hour-old fix, labelled, versus a dead end" — which is what a cold start with
 * no GPS answer used to be.
 */
const RESTORED_POINT_MAX_AGE_MS = 60 * 60 * 1_000;

/** "just now" / "about 20 minutes ago" — how old a restored fix is. */
function restoredPointAgeLabel(capturedAt: string | null | undefined): string {
  const capturedMs = Date.parse(capturedAt ?? "");
  if (!Number.isFinite(capturedMs)) return "";
  const ageMinutes = Math.round((Date.now() - capturedMs) / 60_000);
  if (ageMinutes <= 1) return " from just now";
  if (ageMinutes < 60) return ` from about ${ageMinutes} minutes ago`;
  return " from about an hour ago";
}

export type NearbyCheckInPlaceFocus = {
  placeId: string;
  label: string;
  latitude: number;
  longitude: number;
  /** Straight-line metres from the owner's current point, when both are known. */
  distanceMeters: number | null;
  /** True once the check-in is live, false while the owner is still choosing. */
  active: boolean;
};

function distanceLabel(distanceMeters?: number | null): string {
  if (
    typeof distanceMeters !== "number" ||
    !Number.isFinite(distanceMeters) ||
    distanceMeters < 0
  ) {
    return "Nearby";
  }
  if (distanceMeters < 1_000) {
    return `${Math.max(1, Math.round(distanceMeters))} m away`;
  }
  return `${(distanceMeters / 1_000).toFixed(1)} km`;
}

function normalizeAutomaticPlaces(
  suggestions: OneLocationNearbyPlaceSuggestion[],
): OneLocationNearbyPlaceSuggestion[] {
  const seen = new Set<string>();
  return suggestions
    .filter((place) => {
      if (!place.placeId || seen.has(place.placeId)) return false;
      if (
        typeof place.distanceMeters !== "number" ||
        !Number.isFinite(place.distanceMeters) ||
        place.distanceMeters < 0 ||
        place.distanceMeters > NEARBY_RADIUS_METERS
      ) {
        return false;
      }
      seen.add(place.placeId);
      return true;
    })
    .sort((left, right) => {
      const distance = Number(left.distanceMeters) - Number(right.distanceMeters);
      if (distance !== 0) return distance;
      return (left.name || left.text).localeCompare(right.name || right.text);
    });
}

/**
 * Narrow the merged sweep to one chip locally.
 *
 * The backend returns every category in one pass, so filtering here keeps the
 * full set intact. Re-querying per chip used to re-apply the provider's
 * 20-result cap, which is how a second hotel behind the first could vanish when
 * the owner tapped "Hotels".
 */
function placesInCategory(
  places: OneLocationNearbyPlaceSuggestion[],
  category: OneLocationNearbyPlaceCategory,
): OneLocationNearbyPlaceSuggestion[] {
  if (category === "all") return places;
  return places.filter((place) => place.categories?.includes(category));
}

function placePoint(
  place: OneLocationNearbyPlaceSuggestion | null,
): { latitude: number; longitude: number } | null {
  if (
    !place ||
    typeof place.latitude !== "number" ||
    typeof place.longitude !== "number" ||
    !Number.isFinite(place.latitude) ||
    !Number.isFinite(place.longitude)
  ) {
    return null;
  }
  return { latitude: place.latitude, longitude: place.longitude };
}

/** Straight-line metres between two points. */
function metresBetween(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const earthRadius = 6_371_000;
  const fromLat = (from.latitude * Math.PI) / 180;
  const toLat = (to.latitude * Math.PI) / 180;
  const deltaLat = ((to.latitude - from.latitude) * Math.PI) / 180;
  const deltaLng = ((to.longitude - from.longitude) * Math.PI) / 180;
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, a));
  return (
    earthRadius * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped))
  );
}

/**
 * Metres from the owner to the place they picked. Prefers the provider's own
 * measurement and falls back to a local computation for searched places.
 */
function offsetFromPoint(
  place: OneLocationNearbyPlaceSuggestion | null,
  point: PlainLocationPoint | null,
): number | null {
  if (!place) return null;
  if (
    typeof place.distanceMeters === "number" &&
    Number.isFinite(place.distanceMeters) &&
    place.distanceMeters >= 0
  ) {
    return place.distanceMeters;
  }
  const target = placePoint(place);
  if (!target || !point) return null;
  return metresBetween(point, target);
}

/**
 * Under this, the owner is plausibly inside the building: the gap is receiver
 * noise and a footprint, not a different place, and saying so would be nagging.
 */
const OFFSET_WORTH_MENTIONING_METERS = 75;

function offsetNotice(distanceMeters: number | null): string | null {
  if (distanceMeters === null) return null;
  if (distanceMeters < OFFSET_WORTH_MENTIONING_METERS) return null;
  return `You're about ${distanceLabel(distanceMeters).replace(
    " away",
    "",
  )} from here right now.`;
}

function hasCheckInAccuracy(point: PlainLocationPoint): boolean {
  return (
    typeof point.accuracyM === "number" &&
    Number.isFinite(point.accuracyM) &&
    point.accuracyM >= 0 &&
    point.accuracyM <= ONE_LOCATION_NEARBY_MAX_ACCURACY_METERS
  );
}

/**
 * A usable-but-broad fix. Worth surfacing so a rejected place choice is not a
 * surprise, but never a reason to withhold the place list: browser geolocation
 * lands here routinely and the owner can still pick the venue they are standing
 * in.
 */
function isCoarseAccuracy(point: PlainLocationPoint): boolean {
  return (
    typeof point.accuracyM === "number" &&
    Number.isFinite(point.accuracyM) &&
    point.accuracyM > ONE_LOCATION_NEARBY_COARSE_ACCURACY_METERS
  );
}

function coarseAccuracyNotice(point: PlainLocationPoint): string {
  const reading = Math.round(Number(point.accuracyM));
  const distance =
    reading >= 1_000 ? `${(reading / 1_000).toFixed(1)} km` : `${reading} m`;
  return `Your location is accurate to about ${distance}. Pick the place you're actually at — if it's rejected, move to an open area or turn on precise location.`;
}

function timeLeftLabel(expiresAt: string): string {
  const remainingMs = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "Ending now";
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m left` : `${hours}h left`;
}

function initials(label: string): string {
  return (
    label
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0] || "")
      .join("")
      .toUpperCase() || "?"
  );
}

function NearbyPersonRow({
  attendee,
  busy,
  interactionDisabled,
  onConnect,
  onRespond,
}: {
  attendee: OneLocationNearbyAttendee;
  busy: boolean;
  interactionDisabled: boolean;
  onConnect: () => void;
  onRespond: () => void;
}) {
  const cta = relationshipCta(attendee.relationship);
  const connectionUnavailable =
    cta.action === "connect" && !attendee.canConnect;
  const buttonLabel = connectionUnavailable
    ? "Not accepting requests"
    : cta.label;
  const accessibleLabel =
    connectionUnavailable
      ? `${attendee.displayName} is not accepting connection requests`
      : cta.action === "respond"
      ? `Respond to ${attendee.displayName}'s connection request`
      : `${cta.label} with ${attendee.displayName}`;
  return (
    <li className="flex min-h-14 items-center gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--app-accent-surface-strong)] text-xs font-semibold text-[var(--app-accent-deep)] dark:text-[var(--app-accent-bright)]"
        aria-hidden="true"
      >
        {initials(attendee.displayName)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">
          {attendee.displayName}
        </span>
        <span className="block text-xs text-muted-foreground">
          Checked in nearby
        </span>
      </span>
      <Button
        type="button"
        size="sm"
        className="shrink-0"
        variant={cta.action === "connect" ? "default" : "secondary"}
        aria-label={accessibleLabel}
        disabled={
          interactionDisabled ||
          cta.disabled ||
          connectionUnavailable
        }
        onClick={cta.action === "respond" ? onRespond : onConnect}
      >
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="sr-only">{cta.label}</span>
          </>
        ) : (
          buttonLabel
        )}
      </Button>
    </li>
  );
}

export function NearbyCheckInSheet({
  open,
  ownerId,
  vaultOwnerToken,
  captureCurrentPosition,
  onOpenChange,
  onStateChange,
  onSearchAreaChange,
  onPlaceFocusChange,
}: {
  open: boolean;
  ownerId: string | null;
  vaultOwnerToken: string | null;
  captureCurrentPosition: (options?: {
    maxAgeMs?: number;
    fresh?: boolean;
  }) => Promise<PlainLocationPoint>;
  onOpenChange: (open: boolean) => void;
  onStateChange?: (state: OneLocationNearbyPresenceState) => void;
  /** Transient renderer hint; never persisted or published. */
  onSearchAreaChange?: (point: PlainLocationPoint | null) => void;
  /**
   * The place the map should pin — the one being chosen, or the live check-in
   * anchor. Separate from `onSearchAreaChange` because the owner's position and
   * the venue they check in to are genuinely two different points.
   */
  onPlaceFocusChange?: (focus: NearbyCheckInPlaceFocus | null) => void;
}) {
  const router = useRouter();
  const ownerEpochRef = useRef(0);
  const requestGenerationRef = useRef(0);
  const presenceReadGenerationRef = useRef(0);
  const presenceMutationGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  const searchGenerationRef = useRef(0);
  const placeFocusGenerationRef = useRef(0);
  /**
   * Best fix seen this session. Reused when a refresh fails so a transient
   * geolocation hiccup degrades the drawer instead of emptying it.
   */
  const lastKnownPointRef = useRef<PlainLocationPoint | null>(null);
  const [point, setPoint] = useState<PlainLocationPoint | null>(null);
  const [pointOrigin, setPointOrigin] = useState<PointOrigin>("fresh");
  const [automaticPlaces, setAutomaticPlaces] = useState<
    OneLocationNearbyPlaceSuggestion[]
  >([]);
  const [searchResults, setSearchResults] = useState<
    OneLocationNearbyPlaceSuggestion[]
  >([]);
  const [resolvedPlacePoints, setResolvedPlacePoints] = useState<
    Record<string, { latitude: number; longitude: number }>
  >({});
  const [selectedPlaceId, setSelectedPlaceId] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] =
    useState<OneLocationNearbyPlaceCategory>("all");
  const [searching, setSearching] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [loadingPresence, setLoadingPresence] = useState(false);
  const [state, setState] =
    useState<OneLocationNearbyPresenceState>(EMPTY_NEARBY_STATE);
  const [durationMinutes, setDurationMinutes] = useState<30 | 60 | 120>(60);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [allowConnectionRequests, setAllowConnectionRequests] = useState(false);
  const [busy, setBusy] = useState<"check-in" | "checkout" | string | null>(
    null,
  );
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationRecovery, setLocationRecovery] =
    useState<LocationRecovery>(null);
  const [presenceLoadError, setPresenceLoadError] = useState<string | null>(
    null,
  );
  const [placesError, setPlacesError] = useState<string | null>(null);
  const [accuracyNotice, setAccuracyNotice] = useState<string | null>(null);
  const [visiblePlacesCount, setVisiblePlacesCount] = useState(3);

  const typedSearchActive = search.trim().length >= 2;

  /**
   * The rows on screen. Derived rather than stored: the merged nearby sweep is
   * the single source of truth and a chip only narrows the view of it, so
   * switching chips can neither drop places nor cost a provider call.
   */
  const places = useMemo(() => {
    const visible = typedSearchActive
      ? searchResults
      : placesInCategory(automaticPlaces, category);
    // Coordinates resolved on demand for searched places, which arrive without
    // them, so the map can pin whatever the owner is looking at.
    return visible.map((place) => {
      if (placePoint(place)) return place;
      const resolved = resolvedPlacePoints[place.placeId];
      return resolved ? { ...place, ...resolved } : place;
    });
  }, [
    automaticPlaces,
    category,
    resolvedPlacePoints,
    searchResults,
    typedSearchActive,
  ]);

  const publishState = useCallback(
    (next: OneLocationNearbyPresenceState) => {
      setState(next);
      onStateChange?.(next);
    },
    [onStateChange],
  );

  const loadPresence = useCallback(
    async (
      background = false,
      expectedOwnerEpoch = ownerEpochRef.current,
    ): Promise<PresenceLoadResult> => {
      if (!ownerId || !vaultOwnerToken || mutationInFlightRef.current) {
        return null;
      }
      const ownerToken = vaultOwnerToken;
      const generation = ++presenceReadGenerationRef.current;
      if (!background) {
        setLoadingPresence(true);
        setPresenceLoadError(null);
      }
      try {
        const next = await OneLocationService.getNearbyPresence({
          vaultOwnerToken: ownerToken,
        });
        if (
          ownerEpochRef.current !== expectedOwnerEpoch ||
          presenceReadGenerationRef.current !== generation
        ) {
          return null;
        }
        publishState(next);
        return next;
      } catch {
        if (
          !background &&
          ownerEpochRef.current === expectedOwnerEpoch &&
          presenceReadGenerationRef.current === generation
        ) {
          const message =
            "Nearby check-in could not be loaded. Check your connection and retry.";
          setPresenceLoadError(message);
          toast.error(message);
        }
        return "error";
      } finally {
        if (
          !background &&
          ownerEpochRef.current === expectedOwnerEpoch &&
          presenceReadGenerationRef.current === generation
        ) {
          setLoadingPresence(false);
        }
      }
    },
    [ownerId, publishState, vaultOwnerToken],
  );

  /**
   * Load every check-in-able place around a point in one pass.
   *
   * Always requests the merged "all" sweep, never the active chip: the backend
   * sweeps each category with its own result budget, so one fetch is both more
   * complete than a per-chip query and enough to serve every chip locally.
   */
  const loadPlaces = useCallback(
    async (
      nextPoint: PlainLocationPoint,
      generation: number,
      expectedOwnerEpoch: number,
    ) => {
      if (!ownerId || !vaultOwnerToken) return;
      const ownerToken = vaultOwnerToken;
      setPlacesError(null);
      try {
        const suggestions = await OneLocationService.nearbyPlaces({
          vaultOwnerToken: ownerToken,
          lat: nextPoint.latitude,
          lng: nextPoint.longitude,
          category: "all",
        });
        if (
          ownerEpochRef.current !== expectedOwnerEpoch ||
          requestGenerationRef.current !== generation
        ) {
          return;
        }
        const boundedSuggestions = normalizeAutomaticPlaces(suggestions);
        setAutomaticPlaces(boundedSuggestions);
        if (boundedSuggestions.length === 0) {
          setPlacesError("No places found within 500 m.");
        }
      } catch (error) {
        if (
          ownerEpochRef.current !== expectedOwnerEpoch ||
          requestGenerationRef.current !== generation
        ) {
          return;
        }
        setAutomaticPlaces([]);
        setPlacesError(OneLocationService.placesSearchErrorMessage(error));
      }
    },
    [ownerId, vaultOwnerToken],
  );

  /**
   * Fall back to the last good fix instead of emptying the drawer.
   *
   * A stale-but-recent position still lists the right venues, and the owner --
   * who can see which building they are in -- is a better judge of that than a
   * receiver having a bad second. The backend still verifies plausibility at
   * check-in.
   *
   * Two sources, in order of confidence: a fix taken during this session, then
   * the sealed one carried over from the last. The second is why a cold start
   * no longer dead-ends. Before it existed the fallback lived only in a ref, so
   * the very first capture after a reload had nothing behind it -- and on any
   * machine without a GPS radio that first capture routinely fails with
   * `kCLErrorLocationUnknown`. A device that knew exactly where it was ten
   * minutes ago showed "we couldn't get a location reading".
   *
   * Returns true when the caller must NOT write a location error -- either a
   * point was adopted, or the request was superseded while reading storage and
   * no longer owns the screen.
   */
  const adoptLastKnownPoint = useCallback(
    async (generation: number, expectedOwnerEpoch: number): Promise<boolean> => {
      const superseded = () =>
        ownerEpochRef.current !== expectedOwnerEpoch ||
        requestGenerationRef.current !== generation;

      const sessionFix = lastKnownPointRef.current;
      const sessionFixAt = Date.parse(sessionFix?.capturedAt ?? "");
      if (
        sessionFix &&
        Number.isFinite(sessionFixAt) &&
        Date.now() - sessionFixAt <= LAST_KNOWN_POINT_MAX_AGE_MS
      ) {
        setPoint(sessionFix);
        setPointOrigin("last-known");
        setLocationError(null);
        setAccuracyNotice(null);
        void loadPlaces(sessionFix, generation, expectedOwnerEpoch);
        return true;
      }

      const restored = await readLastKnownFix({
        userId: ownerId,
        maxAgeMs: RESTORED_POINT_MAX_AGE_MS,
      }).catch(() => null);
      if (superseded()) return true;
      if (!restored) return false;

      setPoint(restored);
      setPointOrigin("last-known");
      setLocationError(null);
      setAccuracyNotice(null);
      void loadPlaces(restored, generation, expectedOwnerEpoch);
      return true;
    },
    [loadPlaces, ownerId],
  );

  const captureAndLoadPlaces = useCallback(
    async (nextCategory: OneLocationNearbyPlaceCategory = "all") => {
      if (!ownerId || !vaultOwnerToken) return;
      const expectedOwnerEpoch = ownerEpochRef.current;
      const generation = ++requestGenerationRef.current;
      searchGenerationRef.current += 1;
      setCapturing(true);
      setCategory(nextCategory);
      setSearch("");
      setSearchResults([]);
      setSearching(false);
      setLocationError(null);
      setLocationRecovery(null);
      setPresenceLoadError(null);
      setPlacesError(null);
      setAccuracyNotice(null);
      try {
        let permission: Awaited<
          ReturnType<typeof OneLocationService.getPermissionState>
        > | null = null;
        try {
          permission = await OneLocationService.getPermissionState();
        } catch {
          // The actual one-shot capture remains authoritative if a platform
          // cannot report permission state separately.
        }
        if (
          ownerEpochRef.current !== expectedOwnerEpoch ||
          requestGenerationRef.current !== generation
        ) {
          return;
        }
        if (permission?.state === "granted" && permission.precise === false) {
          setLocationRecovery(isNative() ? "app-settings" : null);
          if (!(await adoptLastKnownPoint(generation, expectedOwnerEpoch))) {
            setPoint(null);
            setLocationError(
              "Precise location is off, so we can't see what's around you yet. Turn it on and we'll pick this up automatically.",
            );
          }
          return;
        }
        // Only refuse what asking cannot fix. A read-back `denied` is not
        // proof — Safari cannot report the value at all, and both browsers and
        // Android re-prompt — so it falls through to the capture below, which
        // is what actually surfaces the permission prompt. This comment's own
        // promise, that "the one-shot capture remains authoritative", was not
        // being kept: the check-in sheet refused here before ever attempting.
        if (locationBlockReason(permission ?? null)) {
          setLocationRecovery(isNative() ? "app-settings" : null);
          if (!(await adoptLastKnownPoint(generation, expectedOwnerEpoch))) {
            setPoint(null);
            setLocationError(
              isNative()
                ? "Location access is off, so we can't list what's around you. Allow it in app settings."
                : "Location access is off, so we can't list what's around you. Allow it in your browser's site settings.",
            );
          }
          return;
        }
        if (
          permission?.state === "unavailable" &&
          permission.locationServicesEnabled === false
        ) {
          setLocationRecovery(isNative() ? "location-settings" : null);
          if (!(await adoptLastKnownPoint(generation, expectedOwnerEpoch))) {
            setPoint(null);
            setLocationError(
              isNative()
                ? "Location services are off, so we can't list what's around you. Turn them on to continue."
                : "Location isn't available in this browser, so we can't list what's around you.",
            );
          }
          return;
        }

        const nextPoint = await captureCurrentPosition();
        if (
          ownerEpochRef.current !== expectedOwnerEpoch ||
          requestGenerationRef.current !== generation
        ) {
          return;
        }
        try {
          const settledPermission =
            await OneLocationService.getPermissionState();
          if (
            ownerEpochRef.current !== expectedOwnerEpoch ||
            requestGenerationRef.current !== generation
          ) {
            return;
          }
          if (
            settledPermission.state === "granted" &&
            settledPermission.precise === false
          ) {
            setLocationRecovery(isNative() ? "app-settings" : null);
            if (!(await adoptLastKnownPoint(generation, expectedOwnerEpoch))) {
              setPoint(null);
              setLocationError(
                "Precise location is off, so we can't see what's around you yet. Turn it on and we'll pick this up automatically.",
              );
            }
            return;
          }
        } catch {
          // Accuracy below remains the fail-closed quality gate when permission
          // precision cannot be queried separately.
        }
        if (!hasCheckInAccuracy(nextPoint)) {
          setLocationRecovery(isNative() ? "app-settings" : null);
          if (!(await adoptLastKnownPoint(generation, expectedOwnerEpoch))) {
            setPoint(null);
            setLocationError(
              "We can't pin down where you are just yet. Stepping outside or near a window usually fixes it.",
            );
          }
          return;
        }
        // A broad-but-usable fix must never withhold the place list. Blocking
        // here was why a browser (wifi/IP trilateration, routinely >100 m) saw
        // an error and zero places instead of the venues it is standing in --
        // the owner still needs to pick where they are, and the backend does the
        // authoritative plausibility check at check-in.
        setAccuracyNotice(
          isCoarseAccuracy(nextPoint) ? coarseAccuracyNotice(nextPoint) : null,
        );
        lastKnownPointRef.current = nextPoint;
        // Carry it past this page. The next cold start reads this instead of
        // starting from nothing, which is what turns a failed first GPS read
        // from a dead end into a labelled fallback.
        void rememberLastKnownFix({ userId: ownerId, point: nextPoint });
        // The grant belongs next to the fix, not to whichever surface happens
        // to run key bootstrap. This drawer reaches the device directly and is
        // routinely the FIRST place an account ever produces a coordinate, so
        // omitting it here left the account's own record of "location works for
        // me" empty on the surface most likely to prove it. Verified against
        // live UAT: the sealed fix was written and the grant was not.
        rememberLocationGrant(ownerId);
        setPointOrigin("fresh");
        setPoint(nextPoint);
        await loadPlaces(nextPoint, generation, expectedOwnerEpoch);
      } catch {
        if (
          ownerEpochRef.current !== expectedOwnerEpoch ||
          requestGenerationRef.current !== generation
        ) {
          return;
        }
        setLocationRecovery(isNative() ? "app-settings" : null);
        if (await adoptLastKnownPoint(generation, expectedOwnerEpoch)) return;
        setPoint(null);
        setAutomaticPlaces([]);
        setSearchResults([]);
        setSelectedPlaceId("");
        setLocationError(
          "We couldn't get a location reading just now. This is usually momentary — try again in a second.",
        );
      } finally {
        if (
          ownerEpochRef.current === expectedOwnerEpoch &&
          requestGenerationRef.current === generation
        ) {
          setCapturing(false);
        }
      }
    },
    [
      adoptLastKnownPoint,
      captureCurrentPosition,
      loadPlaces,
      ownerId,
      vaultOwnerToken,
    ],
  );

  /**
   * Chips narrow the already-loaded sweep. No request, no re-truncation, no
   * spinner -- and nothing the sweep found can disappear behind a chip.
   */
  const selectCategory = useCallback(
    (nextCategory: OneLocationNearbyPlaceCategory) => {
      setCategory(nextCategory);
      setSearch("");
      setSearchResults([]);
      setSearching(false);
      setPlacesError(null);
      setVisiblePlacesCount(5);
      searchGenerationRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    ownerEpochRef.current += 1;
    requestGenerationRef.current += 1;
    presenceReadGenerationRef.current += 1;
    presenceMutationGenerationRef.current += 1;
    mutationInFlightRef.current = false;
    searchGenerationRef.current += 1;
    placeFocusGenerationRef.current += 1;
    lastKnownPointRef.current = null;
    setPoint(null);
    setPointOrigin("fresh");
    setAutomaticPlaces([]);
    setSearchResults([]);
    setResolvedPlacePoints({});
    setSelectedPlaceId("");
    setSearch("");
    setCategory("all");
    setSearching(false);
    setCapturing(false);
    setLoadingPresence(false);
    setConsentAccepted(false);
    setAllowConnectionRequests(false);
    setDurationMinutes(60);
    setVisiblePlacesCount(3);
    setBusy(null);
    setLocationError(null);
    setLocationRecovery(null);
    setPresenceLoadError(null);
    setPlacesError(null);
    setAccuracyNotice(null);
    publishState(EMPTY_NEARBY_STATE);
    return () => {
      requestGenerationRef.current += 1;
      presenceReadGenerationRef.current += 1;
      presenceMutationGenerationRef.current += 1;
      mutationInFlightRef.current = false;
      searchGenerationRef.current += 1;
    };
  }, [ownerId, publishState, vaultOwnerToken]);

  useEffect(() => {
    if (!ownerId || !vaultOwnerToken) return;
    const expectedOwnerEpoch = ownerEpochRef.current;
    requestGenerationRef.current += 1;
    searchGenerationRef.current += 1;
    setPoint(null);
    setPointOrigin("fresh");
    setAutomaticPlaces([]);
    setSearchResults([]);
    setResolvedPlacePoints({});
    setSelectedPlaceId("");
    setSearch("");
    setCategory("all");
    setSearching(false);
    setConsentAccepted(false);
    setAllowConnectionRequests(false);
    setDurationMinutes(60);
    setVisiblePlacesCount(3);
    setLocationError(null);
    setLocationRecovery(null);
    setPresenceLoadError(null);
    setPlacesError(null);
    void loadPresence(!open, expectedOwnerEpoch).then((next) => {
      if (
        !open ||
        next === "error" ||
        next?.presence ||
        ownerEpochRef.current !== expectedOwnerEpoch
      ) {
        return;
      }
      void captureAndLoadPlaces("all");
    });
    return () => {
      requestGenerationRef.current += 1;
      presenceReadGenerationRef.current += 1;
      searchGenerationRef.current += 1;
    };
  }, [
    captureAndLoadPlaces,
    loadPresence,
    open,
    ownerId,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    onSearchAreaChange?.(open && !state.presence ? point : null);
  }, [onSearchAreaChange, open, point, state.presence]);

  useEffect(() => {
    return () => onSearchAreaChange?.(null);
  }, [onSearchAreaChange]);

  useEffect(() => {
    if (!state.presence || !ownerId || !vaultOwnerToken) return;
    const expectedOwnerEpoch = ownerEpochRef.current;
    let inFlight = false;
    const poll = async () => {
      if (
        document.visibilityState !== "visible" ||
        inFlight ||
        mutationInFlightRef.current
      ) {
        return;
      }
      inFlight = true;
      try {
        const next = await loadPresence(true, expectedOwnerEpoch);
        if (
          open &&
          next !== null &&
          next !== "error" &&
          !next.presence &&
          ownerEpochRef.current === expectedOwnerEpoch
        ) {
          void captureAndLoadPlaces();
        }
      } finally {
        inFlight = false;
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    const removeLifecycleListener =
      appInteractionCoordinator.subscribeLifecycle(() => {
        if (
          appInteractionCoordinator.getLifecycleSnapshot().state === "active"
        ) {
          void poll();
          return;
        }
        presenceReadGenerationRef.current += 1;
        requestGenerationRef.current += 1;
        searchGenerationRef.current += 1;
      });
    const timer = window.setInterval(() => void poll(), 15_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      removeLifecycleListener();
    };
  }, [
    captureAndLoadPlaces,
    loadPresence,
    open,
    ownerId,
    state.presence,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (!open || state.presence || !locationRecovery) return;
    return appInteractionCoordinator.subscribeLifecycle(() => {
      if (
        appInteractionCoordinator.getLifecycleSnapshot().state === "active"
      ) {
        void captureAndLoadPlaces();
      }
    });
  }, [captureAndLoadPlaces, locationRecovery, open, state.presence]);

  useEffect(() => {
    const query = search.trim();
    if (!open || !ownerId || !vaultOwnerToken || !point) return;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const ownerToken = vaultOwnerToken;
    const generation = ++searchGenerationRef.current;
    if (query.length < 2) {
      setSearching(false);
      setPlacesError(null);
      setSearchResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearching(true);
      setPlacesError(null);
      void OneLocationService.placesAutocomplete({
        vaultOwnerToken: ownerToken,
        input: query,
        lat: point.latitude,
        lng: point.longitude,
        nearbyOnly: true,
      })
        .then((suggestions) => {
          if (
            ownerEpochRef.current !== expectedOwnerEpoch ||
            searchGenerationRef.current !== generation
          ) {
            return;
          }
          setSearchResults(suggestions);
          if (suggestions.length === 0) {
            setPlacesError("No matching places found.");
          }
        })
        .catch((error) => {
          if (
            ownerEpochRef.current !== expectedOwnerEpoch ||
            searchGenerationRef.current !== generation
          ) {
            return;
          }
          setSearchResults([]);
          setPlacesError(OneLocationService.placesSearchErrorMessage(error));
        })
        .finally(() => {
          if (
            ownerEpochRef.current === expectedOwnerEpoch &&
            searchGenerationRef.current === generation
          ) {
            setSearching(false);
          }
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [open, ownerId, point, search, vaultOwnerToken]);

  // Keep the selection inside whatever is on screen. Runs after every list
  // change (chip switch, search, reload) so the confirm button never points at
  // a row the owner can no longer see.
  useEffect(() => {
    setSelectedPlaceId((current) =>
      places.some((place) => place.placeId === current)
        ? current
        : (places[0]?.placeId ?? ""),
    );
  }, [places]);

  const selectedPlace = useMemo(
    () => places.find((place) => place.placeId === selectedPlaceId) ?? null,
    [places, selectedPlaceId],
  );
  const selectedPlaceOffsetMeters = useMemo(
    () => offsetFromPoint(selectedPlace, point),
    [point, selectedPlace],
  );

  /** How far the owner has moved from the place they are checked in to. */
  const activeDriftMeters = useMemo(() => {
    const presence = state.presence;
    if (!presence || !point) return null;
    const latitude = presence.placeLat;
    const longitude = presence.placeLng;
    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return null;
    }
    return Math.round(metresBetween(point, { latitude, longitude }));
  }, [point, state.presence]);

  /**
   * Resolve a searched place's coordinates on demand.
   *
   * Autocomplete returns an id and a label but no point, so a place picked from
   * search could not be pinned. One details lookup for the row the owner
   * actually selected is the cheapest way to keep the map honest.
   */
  useEffect(() => {
    if (!open || !vaultOwnerToken || !selectedPlace) return;
    if (placePoint(selectedPlace)) return;
    const placeId = selectedPlace.placeId;
    if (resolvedPlacePoints[placeId]) return;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const generation = ++placeFocusGenerationRef.current;
    // Wrapped so a synchronous throw becomes a rejection: the map pin is an
    // enhancement, and losing it must never take the picker down with it.
    void Promise.resolve()
      .then(() => OneLocationService.placeDetails({ vaultOwnerToken, placeId }))
      .then((details) => {
        if (
          ownerEpochRef.current !== expectedOwnerEpoch ||
          placeFocusGenerationRef.current !== generation ||
          typeof details?.latitude !== "number" ||
          typeof details?.longitude !== "number"
        ) {
          return;
        }
        setResolvedPlacePoints((current) => ({
          ...current,
          [placeId]: {
            latitude: details.latitude,
            longitude: details.longitude,
          },
        }));
      })
      .catch(() => {
        // The row stays selectable and check-in still works; only the map pin
        // is unavailable for this place.
      });
  }, [open, resolvedPlacePoints, selectedPlace, vaultOwnerToken]);

  /**
   * Tell the map which place to pin.
   *
   * While choosing, that is the highlighted row. Once checked in, it is the
   * live anchor from the server, so the pin survives a reload and keeps
   * describing where the owner checked in rather than where they now stand.
   */
  useEffect(() => {
    if (!open) {
      onPlaceFocusChange?.(null);
      return;
    }
    const presence = state.presence;
    if (presence) {
      const latitude = presence.placeLat;
      const longitude = presence.placeLng;
      if (
        typeof latitude !== "number" ||
        typeof longitude !== "number" ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
      ) {
        onPlaceFocusChange?.(null);
        return;
      }
      onPlaceFocusChange?.({
        placeId: "",
        label: presence.placeLabel || "Your check-in place",
        latitude,
        longitude,
        distanceMeters: point
          ? Math.round(metresBetween(point, { latitude, longitude }))
          : null,
        active: true,
      });
      return;
    }
    const target = placePoint(selectedPlace);
    if (!selectedPlace || !target) {
      onPlaceFocusChange?.(null);
      return;
    }
    onPlaceFocusChange?.({
      placeId: selectedPlace.placeId,
      label: selectedPlace.name?.trim() || selectedPlace.text,
      latitude: target.latitude,
      longitude: target.longitude,
      distanceMeters:
        selectedPlaceOffsetMeters === null
          ? null
          : Math.round(selectedPlaceOffsetMeters),
      active: false,
    });
  }, [
    onPlaceFocusChange,
    open,
    point,
    selectedPlace,
    selectedPlaceOffsetMeters,
    state.presence,
  ]);

  useEffect(() => {
    return () => onPlaceFocusChange?.(null);
  }, [onPlaceFocusChange]);

  const retryPresenceLoad = async () => {
    if (!open || !ownerId || !vaultOwnerToken) return;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const next = await loadPresence(false, expectedOwnerEpoch);
    if (
      next === null ||
      next === "error" ||
      next.presence ||
      ownerEpochRef.current !== expectedOwnerEpoch
    ) {
      return;
    }
    void captureAndLoadPlaces();
  };

  const checkIn = async () => {
    if (
      !ownerId ||
      !vaultOwnerToken ||
      !point ||
      !selectedPlace ||
      !consentAccepted
    ) {
      return;
    }
    if (mutationInFlightRef.current) return;
    const ownerToken = vaultOwnerToken;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const generation = ++presenceMutationGenerationRef.current;
    presenceReadGenerationRef.current += 1;
    mutationInFlightRef.current = true;
    setBusy("check-in");
    let confirmationPoint: PlainLocationPoint | null = null;
    try {
      // The persisted radius anchor must describe where the owner confirms the
      // check-in, not the earlier point used to load place suggestions — but a
      // fix from a few seconds ago describes the same spot, so the tight window
      // keeps the anchor honest without paying a full acquisition on the press.
      const freshPoint = await captureCurrentPosition({ fresh: true });
      confirmationPoint = freshPoint;
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        presenceMutationGenerationRef.current !== generation
      ) {
        return;
      }
      if (!hasCheckInAccuracy(freshPoint)) {
        setPoint(null);
        setLocationRecovery(isNative() ? "app-settings" : null);
        setLocationError(
          "We couldn't confirm where you are at the moment you checked in. Nothing was shared — try again in a second.",
        );
        toast.error("A more precise location is needed before check-in.");
        return;
      }
      setAccuracyNotice(
        isCoarseAccuracy(freshPoint) ? coarseAccuracyNotice(freshPoint) : null,
      );
      setPoint(freshPoint);
      const next = await OneLocationService.checkInNearby({
        vaultOwnerToken: ownerToken,
        placeId: selectedPlace.placeId,
        point: freshPoint,
        durationMinutes,
        consentAccepted: true,
        allowConnectionRequests,
      });
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        presenceMutationGenerationRef.current !== generation
      ) {
        return;
      }
      publishState(next);
      // The confirmation point is kept, not cleared: once checked in it is what
      // tells the owner how far they have drifted from the place they anchored
      // to. It is not republished as a search area -- presence suppresses that.
      setAutomaticPlaces([]);
      setSearchResults([]);
      setSelectedPlaceId("");
      setSearch("");
      setAccuracyNotice(null);
      toast.success("You're checked in nearby.");
    } catch (error) {
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        presenceMutationGenerationRef.current !== generation
      ) {
        return;
      }
      const details = OneLocationService.nearbyCheckInErrorDetails(error);
      if (details.retryLocation) {
        setPoint(null);
        setLocationError(details.message);
        setLocationRecovery(
          details.openAppSettings && isNative() ? "app-settings" : null,
        );
      } else if (details.retryPlaces) {
        setAutomaticPlaces([]);
        setSearchResults([]);
        setSelectedPlaceId("");
        if (confirmationPoint && hasCheckInAccuracy(confirmationPoint)) {
          const reloadGeneration = ++requestGenerationRef.current;
          searchGenerationRef.current += 1;
          setPoint(confirmationPoint);
          setSearch("");
          setSearching(false);
          setCapturing(true);
          void loadPlaces(
            confirmationPoint,
            reloadGeneration,
            expectedOwnerEpoch,
          ).finally(() => {
            if (
              ownerEpochRef.current === expectedOwnerEpoch &&
              requestGenerationRef.current === reloadGeneration
            ) {
              setCapturing(false);
            }
          });
        } else {
          void captureAndLoadPlaces(category);
        }
      } else if (
        details.message.toLowerCase().includes("closer place")
      ) {
        setPlacesError(details.message);
      }
      toast.error(details.message);
    } finally {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        mutationInFlightRef.current = false;
        setBusy(null);
      }
    }
  };

  const checkout = async () => {
    if (!ownerId || !vaultOwnerToken || mutationInFlightRef.current) return;
    const ownerToken = vaultOwnerToken;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const generation = ++presenceMutationGenerationRef.current;
    presenceReadGenerationRef.current += 1;
    mutationInFlightRef.current = true;
    setBusy("checkout");
    try {
      const next = await OneLocationService.checkoutNearby({
        vaultOwnerToken: ownerToken,
      });
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        presenceMutationGenerationRef.current !== generation
      ) {
        return;
      }
      publishState(next);
      setConsentAccepted(false);
      setAllowConnectionRequests(false);
      toast.success("You checked out.");
      void captureAndLoadPlaces();
    } catch {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        toast.error(
          "Checkout didn't complete. You may still be visible—please try again.",
        );
      }
    } finally {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        mutationInFlightRef.current = false;
        setBusy(null);
      }
    }
  };

  const connect = async (attendee: OneLocationNearbyAttendee) => {
    if (
      !ownerId ||
      !vaultOwnerToken ||
      busy !== null ||
      mutationInFlightRef.current
    ) {
      return;
    }
    const ownerToken = vaultOwnerToken;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const generation = ++presenceMutationGenerationRef.current;
    presenceReadGenerationRef.current += 1;
    mutationInFlightRef.current = true;
    const key = `connect:${attendee.participantAlias}`;
    setBusy(key);
    try {
      const result = await OneLocationService.requestNearbyConnection({
        vaultOwnerToken: ownerToken,
        participantAlias: attendee.participantAlias,
      });
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        presenceMutationGenerationRef.current !== generation
      ) {
        return;
      }
      setState((current) => {
        const next = {
          ...current,
          attendees: current.attendees.map((item) =>
            item.participantAlias === attendee.participantAlias
              ? { ...item, relationship: result.relationship }
              : item,
          ),
        };
        onStateChange?.(next);
        return next;
      });
      toast.success("Connection request sent.");
    } catch {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        toast.error(
          "That person may no longer be nearby. Refreshing the list.",
        );
        setBusy(null);
        mutationInFlightRef.current = false;
        void loadPresence(true, expectedOwnerEpoch);
      }
    } finally {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        mutationInFlightRef.current = false;
        setBusy(null);
      }
    }
  };

  const openRecoverySettings = async () => {
    if (!locationRecovery || busy !== null) return;
    setBusy("settings");
    try {
      if (locationRecovery === "location-settings") {
        await OneLocationService.openLocationSettings();
      } else {
        await OneLocationService.openAppSettings();
      }
    } catch {
      toast.error("Settings could not be opened. Please open them manually.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet modal open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        dragDismiss={false}
        showDragHandle={false}
        className="gap-0 overflow-hidden px-0 pb-[max(1rem,env(safe-area-inset-bottom))] md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none md:w-[26rem] md:rounded-none md:rounded-l-[var(--app-card-radius-feature)] md:border-l md:border-t-0 md:data-[state=closed]:slide-out-to-right md:data-[state=open]:slide-in-from-right"
        data-testid="one-location-nearby-check-in-sheet"
        data-one-location-nearby-check-in-sheet=""
      >
        <SheetHeader className="gap-0 border-b border-border/60 px-5 py-4 text-left">
          <div className="flex min-h-9 items-center gap-2 pr-10">
            <SheetTitle className="text-[17px] leading-6">Check in</SheetTitle>
            <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
              Preview
            </span>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {state.presence
              ? `Nearby check-in active. ${state.attendees.length} ${
                  state.attendees.length === 1 ? "person" : "people"
                } nearby.`
              : "Nearby check-in is not active."}
          </p>
          {loadingPresence && !state.presence ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking your current status…
            </div>
          ) : null}

          {presenceLoadError && !state.presence ? (
            <div
              className="mb-4 rounded-2xl border border-destructive/20 bg-destructive/10 p-3"
              role="alert"
            >
              <p className="text-sm text-destructive">{presenceLoadError}</p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-2"
                disabled={loadingPresence}
                onClick={() => void retryPresenceLoad()}
              >
                {loadingPresence ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Retry status
              </Button>
            </div>
          ) : null}

          {loadingPresence && !state.presence ? null : state.presence ? (
            <div className="space-y-4" data-testid="nearby-presence-active">
              <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">You’re visible nearby</p>
                    <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                      {state.presence.placeLabel || "Your selected place"} ·{" "}
                      {state.presence.radiusMeters} m radius ·{" "}
                      {timeLeftLabel(state.presence.expiresAt)}
                    </p>
                    {activeDriftMeters !== null ? (
                      <p
                        className="mt-2 flex items-start gap-1.5 text-xs leading-4 text-muted-foreground"
                        data-testid="nearby-active-drift"
                      >
                        <LocateFixed
                          className="mt-px h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span>
                          {activeDriftMeters <= NEARBY_DRIFT_NUDGE_METERS
                            ? `You're about ${distanceLabel(
                                activeDriftMeters,
                              ).replace(" away", "")} from it right now.`
                            : `You've moved about ${distanceLabel(
                                activeDriftMeters,
                              ).replace(
                                " away",
                                "",
                              )} away. People here still match against the place, not you — check out if you've left.`}
                        </span>
                      </p>
                    ) : null}
                  </div>
                </div>
              </section>

              <section aria-labelledby="nearby-people-title">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <h2 id="nearby-people-title" className="font-semibold">
                      People nearby
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Nearby check-ins appear in this list, not as map pins. A
                      pin appears only after that person explicitly shares
                      their location with you.
                    </p>
                  </div>
                  <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">
                    {state.attendees.length}
                  </span>
                </div>
                {state.attendees.length ? (
                  <ul className="mt-2" data-testid="nearby-attendee-roster">
                    {state.attendees.map((attendee) => (
                      <NearbyPersonRow
                        key={attendee.participantAlias}
                        attendee={attendee}
                        busy={busy === `connect:${attendee.participantAlias}`}
                        interactionDisabled={busy !== null}
                        onConnect={() => void connect(attendee)}
                        onRespond={() =>
                          router.push(
                            buildConsentCenterHref("pending", {
                              from: `${ROUTES.ONE_LOCATION_MAP}?action=check-in`,
                            }),
                          )
                        }
                      />
                    ))}
                  </ul>
                ) : (
                  <div className="mt-3 rounded-2xl bg-muted/70 px-4 py-5 text-center">
                    <UsersRound className="mx-auto h-5 w-5 text-muted-foreground" />
                    <p className="mt-2 text-sm font-medium">
                      No one else is checked in nearby yet
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      We’ll refresh automatically while your check-in is active.
                    </p>
                  </div>
                )}
              </section>

              <Button
                type="button"
                variant="destructive"
                className="w-full"
                disabled={busy !== null}
                onClick={() => void checkout()}
              >
                {busy === "checkout" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Check out now
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Nearby people appear as a list. Their precise locations are
                never pinned on your map.
              </p>
            </div>
          ) : (
            <div className="space-y-5" data-testid="nearby-presence-setup">
              <section>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">Places within 500 m</h2>
                    <p className="text-sm text-muted-foreground">
                      {typedSearchActive
                        ? "Search results stay inside the same 500 m area."
                        : "Every place we can find around you. The closest is selected."}
                    </p>
                  </div>
                  {capturing ? (
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  ) : null}
                </div>

                {/*
                  A location problem is a state to work through, not a failure
                  to alarm about: the owner has done nothing wrong and can
                  usually resolve it in one tap. It is therefore rendered in the
                  neutral surface style with the recovery actions attached,
                  never as a destructive alert.
                */}
                {locationError ? (
                  <div
                    className="mt-3 rounded-2xl border border-border/60 bg-muted/50 p-4"
                    role="status"
                    data-testid="nearby-location-fallback"
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-background text-muted-foreground"
                        aria-hidden="true"
                      >
                        <Compass className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold">
                          Still finding you
                        </p>
                        <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                          {locationError}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={capturing || busy === "settings"}
                        onClick={() => void captureAndLoadPlaces(category)}
                      >
                        {capturing ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : null}
                        Try again
                      </Button>
                      {locationRecovery && isNative() ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={busy === "settings"}
                          onClick={() => void openRecoverySettings()}
                        >
                          {busy === "settings" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : null}
                          Open settings
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <>
                    {pointOrigin === "last-known" && point ? (
                      <p
                        className="mt-3 flex items-start gap-2 rounded-2xl border border-border/60 bg-muted/40 p-3 text-xs leading-4 text-muted-foreground"
                        role="status"
                        data-testid="nearby-last-known-notice"
                      >
                        <LocateFixed
                          className="mt-px h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span>
                          Showing places around your last known position
                          {restoredPointAgeLabel(point.capturedAt)} — we
                          couldn’t refresh it just now. Pick where you actually
                          are, or{" "}
                          <button
                            type="button"
                            className="font-semibold underline underline-offset-2"
                            disabled={capturing}
                            onClick={() => void captureAndLoadPlaces(category)}
                          >
                            update your location
                          </button>
                          .
                        </span>
                      </p>
                    ) : null}
                    {accuracyNotice ? (
                      <p
                        className="mt-3 rounded-2xl border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground"
                        role="status"
                      >
                        {accuracyNotice}
                      </p>
                    ) : null}
                    <label className="relative mt-3 block">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <span className="sr-only">Search for another place</span>
                      <Input
                        value={search}
                        onChange={(event) => {
                          const nextSearch = event.target.value;
                          searchGenerationRef.current += 1;
                          setSearch(nextSearch);
                          setPlacesError(null);
                          if (nextSearch.trim().length >= 2) {
                            setSearching(true);
                            setSearchResults([]);
                          } else {
                            setSearching(false);
                          }
                        }}
                        disabled={!point || capturing}
                        placeholder="Search for another place"
                        className="h-11 rounded-full pl-9"
                      />
                      {searching ? (
                        <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                      ) : null}
                    </label>

                    <div
                      className={cn(
                        "mt-3 flex gap-2 overflow-x-auto pb-1",
                        "[scrollbar-width:none] hover:[scrollbar-width:thin]",
                        "[&::-webkit-scrollbar]:hidden hover:[&::-webkit-scrollbar]:block",
                        "[&::-webkit-scrollbar]:h-1.5",
                        "[&::-webkit-scrollbar-track]:bg-transparent",
                        "[&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/30"
                      )}
                      aria-label="Nearby place categories"
                    >
                      {typedSearchActive ? (
                        <span className="inline-flex h-9 shrink-0 items-center rounded-full bg-primary px-3 text-sm font-medium text-primary-foreground">
                          Search results
                        </span>
                      ) : null}
                      {PLACE_CATEGORIES.map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          size="sm"
                          variant={
                            !typedSearchActive && category === option.value
                              ? "default"
                              : "secondary"
                          }
                          className="shrink-0 rounded-full"
                          aria-pressed={
                            !typedSearchActive && category === option.value
                          }
                          disabled={!point || capturing || typedSearchActive}
                          onClick={() => selectCategory(option.value)}
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>

                    <div
                      className={cn(
                        "mt-3 space-y-2",
                        visiblePlacesCount > 3 && "max-h-[35vh] overflow-y-auto pr-2"
                      )}
                      role="radiogroup"
                      aria-label="Nearby places"
                    >
                      {places.slice(0, visiblePlacesCount).map((place) => {
                        const selected = place.placeId === selectedPlaceId;
                        const name = place.name?.trim() || place.text;
                        const metadata = Array.from(
                          new Set(
                            [place.category?.trim(), place.address?.trim()].filter(
                              (value): value is string => Boolean(value),
                            ),
                          ),
                        );
                        const metadataLabel = metadata.join(" · ");
                        return (
                          <button
                            key={place.placeId}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors",
                              selected
                                ? "border-[var(--app-accent)] bg-[var(--app-accent-surface)]"
                                : "border-border/60 bg-muted/50 hover:bg-muted",
                            )}
                            onClick={() => setSelectedPlaceId(place.placeId)}
                          >
                            <MapPin className="h-4 w-4 shrink-0 text-[var(--app-accent-deep)] dark:text-[var(--app-accent-bright)]" />
                            <span className="min-w-0 flex-1">
                              <span
                                title={name}
                                className="block truncate text-sm font-semibold leading-5"
                              >
                                {name}
                              </span>
                              {metadata.length ? (
                                <span
                                  title={metadataLabel}
                                  className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground"
                                >
                                  {metadataLabel}
                                </span>
                              ) : null}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {distanceLabel(place.distanceMeters)}
                            </span>
                            {selected ? (
                              <Check className="h-4 w-4 shrink-0 text-[var(--app-accent-deep)] dark:text-[var(--app-accent-bright)]" />
                            ) : null}
                          </button>
                        );
                      })}
                      {places.length > visiblePlacesCount ? (
                        <div className="pt-1 pb-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="w-full text-muted-foreground"
                            onClick={() => setVisiblePlacesCount(places.length)}
                          >
                            Show all {places.length} places
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    {/*
                      The owner's point and their venue are two different places
                      and can be a street apart. Naming the gap is what lets
                      them tell the hotel they are in from the one behind it.
                    */}
                    {selectedPlace && offsetNotice(selectedPlaceOffsetMeters) ? (
                      <p
                        className="mt-2 flex items-start gap-1.5 text-xs leading-4 text-muted-foreground"
                        data-testid="nearby-selected-place-offset"
                      >
                        <LocateFixed
                          className="mt-px h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span>{offsetNotice(selectedPlaceOffsetMeters)}</span>
                      </p>
                    ) : null}
                    {!places.length &&
                    !capturing &&
                    !searching &&
                    !typedSearchActive &&
                    automaticPlaces.length ? (
                      <div
                        className="mt-3 rounded-2xl bg-muted/60 px-4 py-5 text-center"
                        data-testid="nearby-category-empty"
                      >
                        <p className="text-sm font-medium">
                          Nothing in this category within 500 m
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {automaticPlaces.length} other places are nearby.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="mt-3"
                          onClick={() => selectCategory("all")}
                        >
                          Show all {automaticPlaces.length} places
                        </Button>
                      </div>
                    ) : null}
                    {places.length ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {typedSearchActive
                          ? null
                          : `${places.length} ${
                              places.length === 1 ? "place" : "places"
                            } · `}
                        <span translate="no" className="whitespace-nowrap font-normal">
                          Google Maps
                        </span>
                      </p>
                    ) : null}
                    {placesError ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {placesError}
                      </p>
                    ) : null}
                  </>
                )}
              </section>

              <section>
                <div className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4 text-muted-foreground" />
                  <h2 className="font-semibold">Stay visible for</h2>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {DURATIONS.map((duration) => (
                    <Button
                      key={duration.value}
                      type="button"
                      variant={
                        durationMinutes === duration.value
                          ? "default"
                          : "secondary"
                      }
                      aria-pressed={durationMinutes === duration.value}
                      onClick={() => setDurationMinutes(duration.value)}
                    >
                      {duration.label}
                    </Button>
                  ))}
                </div>
              </section>

              <section className="space-y-3 rounded-2xl border border-border/60 p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <Checkbox
                    className="mt-0.5"
                    checked={consentAccepted}
                    onCheckedChange={(checked) =>
                      setConsentAccepted(checked === true)
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">
                      Appear nearby
                    </span>
                    <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                      People see your name only.
                    </span>
                  </span>
                </label>

                <details className="group rounded-xl bg-muted/45 px-3 py-2 text-xs leading-4 text-muted-foreground">
                  <summary className="cursor-pointer list-none font-medium text-foreground/80">
                    How sharing works
                  </summary>
                  <p className="mt-2">
                    Your current point is sent to Google to suggest nearby
                    places; searching may send it again to improve results. At
                    confirmation, Hussh stores your check-in point only as
                    short-lived encrypted data to match opted-in people within
                    500 metres. They see your display name in their list, never
                    your point or exact distance. It is cleared on checkout or
                    expiry. Closing the app does not check you out.
                  </p>
                </details>

                <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-3">
                  <div>
                    <p className="text-sm font-semibold">
                      Connection requests
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Off by default.
                    </p>
                  </div>
                  <Switch
                    checked={allowConnectionRequests}
                    onCheckedChange={setAllowConnectionRequests}
                    aria-label="Allow nearby connection requests"
                  />
                </div>
              </section>

              <Button
                type="button"
                className="h-12 w-full"
                disabled={
                  busy !== null ||
                  capturing ||
                  searching ||
                  !point ||
                  !selectedPlace ||
                  !consentAccepted
                }
                onClick={() => void checkIn()}
              >
                {busy === "check-in" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <UsersRound className="h-4 w-4" />
                )}
                Check in
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
