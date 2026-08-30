"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Check,
  ChevronDown,
  Compass,
  Loader2,
  LocateFixed,
  MapPin,
  Search,
  Star,
  UsersRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  DURATION_CELL_CLASS,
  DURATION_CELL_OFF_CLASS,
  DURATION_CELL_ON_CLASS,
} from "@/components/one-location/redesign/duration-presets";
import {
  CHECK_IN_CATEGORY_ROW_CLASSNAME,
  CHECK_IN_PANEL_DESKTOP_WIDTH_REM,
  CHECK_IN_PLACE_DISTANCE_CLASSNAME,
  CHECK_IN_PLACE_META_CLASSNAME,
  CHECK_IN_PLACE_NAME_CLASSNAME,
  CHECK_IN_PLACE_ROW_CLASSNAME,
  CHECK_IN_PLACE_ROW_OFF_CLASSNAME,
  CHECK_IN_PLACE_ROW_ON_CLASSNAME,
  CHECK_OUT_BUTTON_VARIANT,
} from "@/components/one-location/nearby-check-in/check-in-panel-layout";

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
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { relationshipCta } from "@/lib/connections/relationship-label";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import {
  readLastKnownFix,
  rememberLastKnownFix,
  rememberLocationGrant,
} from "@/lib/one-location/location-grant-memory";
import { locationBlockReason } from "@/lib/one-location/location-readiness";
import {
  ambiguousMatchNames,
  resolveSpokenNames,
} from "@/lib/one-location/resolve-spoken-names";
import {
  addSavedLocation,
  DuplicateSavedLocationError,
  findDuplicateSavedLocation,
  loadSavedLocations,
} from "@/lib/one-location/saved-locations";
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
import { SEMANTIC_ROLE_CLASSES } from "@/lib/morphy-ux/tokens/semantic-roles";
import { cn } from "@/lib/utils";

const SUCCESS_ROLE = SEMANTIC_ROLE_CLASSES.success;

/**
 * Three lengths, and they have to fit one row.
 *
 * Reported: "Visible for ke jo times hain inko one row mai dikhao ... looking
 * scattered". They were, and the cause was the shared `DURATION_GRID_CLASS`:
 * two columns on a phone, which lays three cells out as 2 + 1 and leaves a
 * half-empty second row under a heading that reads as a single choice.
 *
 * Abbreviated so the set is consistent rather than to buy width -- "30 min"
 * beside "1 hour" and "2 hours" mixes two registers in one row, and at three
 * across the long forms fit anyway. See CHECK_IN_DURATION_GRID_CLASS for why
 * the grid is local rather than a change to the shared one.
 */
const DURATIONS = [
  { value: 30 as const, label: "30 min" },
  { value: 60 as const, label: "1 hr" },
  { value: 120 as const, label: "2 hr" },
];

/**
 * Three across on a phone, not the shared ladder's two.
 *
 * `DURATION_GRID_CLASS` is two columns because the ladders that use it carry
 * four cells and land as an even 2x2. This control has three, so the same
 * class strands one on a row of its own. Local rather than a fourth variant in
 * `duration-presets`: the cells themselves stay identical, which is the part
 * that has to agree across the product.
 *
 * At 320px this is ~90px a cell against a widest label of ~64px, so nothing
 * truncates on the narrowest phone the app supports.
 */
const CHECK_IN_DURATION_GRID_CLASS = "grid grid-cols-3 gap-2 sm:flex sm:flex-wrap";

/**
 * Chip labels only. The `value` on each row is the backend category and is
 * untouched — a chip narrows the already-loaded sweep locally, so nothing here
 * reaches a server.
 *
 * The two multi-word labels were the only ones that could not fit a chip: at
 * 320px "Food & drink" and "Shops & services" pushed every remaining chip off
 * the scroller, so the row read as three choices instead of eight. One word
 * each keeps all eight reachable by a short swipe.
 */
const PLACE_CATEGORIES: Array<{
  value: OneLocationNearbyPlaceCategory;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "food_drink", label: "Food" },
  { value: "health", label: "Health" },
  { value: "shopping_services", label: "Shops" },
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
type NearbyCheckInViewState = "loading" | "setup" | "active" | "completed";
type CompletedCheckIn = {
  placeLabel: string | null;
  saved: boolean;
  saveError: string | null;
};

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

/**
 * The same distance, for a column rather than a sentence.
 *
 * A place row is already a list of distances in one aligned column, so "away"
 * is the same word repeated on every line to say what the column is. Prose
 * still uses `distanceLabel`, where the word does work.
 */
function compactDistanceLabel(distanceMeters?: number | null): string {
  return distanceLabel(distanceMeters).replace(" away", "");
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
  return `About ${compactDistanceLabel(distanceMeters)} from here.`;
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

/**
 * Maps a spoken duration to the nearest of the three fixed options the sheet
 * itself offers -- never a free-form number, matching how `location.share_selected`
 * only accepts the durations its own screen presents.
 */
export function nearestCheckInDurationMinutes(
  spoken: unknown,
): 30 | 60 | 120 | null {
  const raw = String(spoken ?? "").trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const options: Array<30 | 60 | 120> = [30, 60, 120];
  return options.reduce((closest, option) =>
    Math.abs(option - numeric) < Math.abs(closest - numeric) ? option : closest,
  );
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

function peopleNearbyLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "person" : "people"} nearby`;
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

/** A checked-out venue offered to Saved Places. */
type SavePlaceCandidate = {
  label: string;
  latitude: number;
  longitude: number;
};

/**
 * The venue a check-in was anchored to, as a Saved Places candidate.
 *
 * Must be read from the presence record BEFORE checkout runs, because checkout
 * clears it. `placeLat`/`placeLng` are the public venue the owner picked, never
 * their live position — which is the whole reason this is safe to offer: it
 * saves the bar they chose, not wherever they happened to be standing.
 *
 * Returns null for a check-in with no named anchor. A place with no label is
 * not worth prompting about, since Saved Places would show a blank row.
 */
function savePlaceCandidate(
  presence: OneLocationNearbyPresenceState["presence"],
): SavePlaceCandidate | null {
  if (!presence) return null;
  const label = presence.placeLabel?.trim();
  const { placeLat, placeLng } = presence;
  if (
    !label ||
    typeof placeLat !== "number" ||
    typeof placeLng !== "number" ||
    !Number.isFinite(placeLat) ||
    !Number.isFinite(placeLng)
  ) {
    return null;
  }
  return { label, latitude: placeLat, longitude: placeLng };
}

export function NearbyCheckInSheet({
  open,
  ownerId,
  vaultOwnerToken,
  vaultKey = null,
  captureCurrentPosition,
  onOpenChange,
  onStateChange,
  onSearchAreaChange,
  onPlaceFocusChange,
}: {
  open: boolean;
  ownerId: string | null;
  vaultOwnerToken: string | null;
  /**
   * Passed in rather than read from `useVault()` so this sheet stays free of
   * the vault provider, matching how it already receives `ownerId` and
   * `vaultOwnerToken`. Null simply means Saved Places is unavailable this
   * session, and the post-checkout offer is skipped.
   */
  vaultKey?: string | null;
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
  const [viewState, setViewState] =
    useState<NearbyCheckInViewState>("loading");
  const [state, setState] =
    useState<OneLocationNearbyPresenceState>(EMPTY_NEARBY_STATE);
  const [durationMinutes, setDurationMinutes] = useState<30 | 60 | 120>(60);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [allowConnectionRequests, setAllowConnectionRequests] = useState(false);
  /** Whether the secondary preference row is revealed. Presentation only. */
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [addTimeOpen, setAddTimeOpen] = useState(false);
  const [addTimeBusy, setAddTimeBusy] = useState<30 | 60 | null>(null);
  const [busy, setBusy] = useState<"check-in" | "checkout" | string | null>(
    null,
  );
  const [completedCheckIn, setCompletedCheckIn] =
    useState<CompletedCheckIn | null>(null);
  /**
   * The post-checkout Saved Places offer. Null whenever there is nothing to
   * offer — no anchor, vault locked, or the place is already saved — so the
   * banner's presence alone is the whole condition for showing it.
   */
  const [savePlaceCandidateState, setSavePlaceCandidateState] =
    useState<SavePlaceCandidate | null>(null);
  const [savingPlace, setSavingPlace] = useState(false);
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
  /**
   * Voice handlers below run inside plain async closures, not renders --
   * `automaticPlaces` read directly there would be whatever it was when the
   * handler function was created, not what a `captureAndLoadPlaces()` this
   * same handler just awaited actually produced. Mirrored into a ref so the
   * handler can read the value React has not necessarily re-rendered with yet.
   */
  const automaticPlacesRef = useRef(automaticPlaces);
  useEffect(() => {
    automaticPlacesRef.current = automaticPlaces;
  }, [automaticPlaces]);
  /**
   * Same staleness problem as automaticPlacesRef, for the specific reason
   * zero candidates came back. Collapsing every cause into one generic
   * "nothing plausible nearby" message hid a permission-denied or
   * GPS-accuracy failure behind a sentence that sounds like the person is
   * simply somewhere with no restaurants around them.
   */
  const locationErrorRef = useRef(locationError);
  useEffect(() => {
    locationErrorRef.current = locationError;
  }, [locationError]);
  const placesErrorRef = useRef(placesError);
  useEffect(() => {
    placesErrorRef.current = placesError;
  }, [placesError]);

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
    setViewState("loading");
    setConsentAccepted(false);
    setAllowConnectionRequests(false);
    setOptionsOpen(false);
    setAddTimeOpen(false);
    setAddTimeBusy(null);
    setDurationMinutes(60);
    setVisiblePlacesCount(3);
    setBusy(null);
    setCompletedCheckIn(null);
    setSavePlaceCandidateState(null);
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
    setOptionsOpen(false);
    setAddTimeOpen(false);
    setAddTimeBusy(null);
    setDurationMinutes(60);
    setVisiblePlacesCount(3);
    setCompletedCheckIn(null);
    setSavePlaceCandidateState(null);
    setLocationError(null);
    setLocationRecovery(null);
    setPresenceLoadError(null);
    setPlacesError(null);
    if (open) setViewState("loading");
    void loadPresence(!open, expectedOwnerEpoch).then((next) => {
      if (
        next === "error" ||
        ownerEpochRef.current !== expectedOwnerEpoch
      ) {
        return;
      }
      if (next?.presence) {
        setViewState("active");
        return;
      }
      if (!open) return;
      setViewState("setup");
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
    onSearchAreaChange?.(
      open && viewState === "setup" && !state.presence ? point : null,
    );
  }, [onSearchAreaChange, open, point, state.presence, viewState]);

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
          setViewState((current) =>
            current === "completed" ? current : "setup",
          );
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
    // Poll on a timer ONLY while the drawer is actually on screen.
    //
    // The guard above is `state.presence`, not `open`, so this effect also runs
    // for a checked-in owner who has the sheet mounted but closed — and the
    // sheet is mounted by every map surface. At 15s that is 4 reads a minute
    // each, against a server budget of 8 a minute for this route, keyed per
    // ACCOUNT rather than per tab. Two mounted-but-closed sheets therefore
    // spend the entire allowance on nobody looking at anything, and the hub's
    // own presence read comes back 429. That is what put three
    // "429 (Too Many Requests)" lines on the Location screen.
    //
    // Closed, the sheet still refreshes on the two events that actually matter
    // — the tab becoming visible and the app returning to the foreground —
    // which is where a stale presence would otherwise be noticed. Nothing is
    // lost except requests nobody was waiting for.
    const timer = open
      ? window.setInterval(() => void poll(), 15_000)
      : null;
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      if (timer !== null) window.clearInterval(timer);
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

  // Keep the selection inside whatever is on screen without making a choice for
  // the owner. If a chip switch, search, or reload hides the selected row, the
  // owner must intentionally choose another place before checking in.
  useEffect(() => {
    setSelectedPlaceId((current) =>
      places.some((place) => place.placeId === current)
        ? current
        : "",
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
  /**
   * Retire the Saved Places offer when the sheet closes. It belongs to the
   * checkout that just happened; re-opening the sheet an hour later should not
   * resurface a decision the person already walked away from.
   */
  useEffect(() => {
    if (!open) setSavePlaceCandidateState(null);
  }, [open]);

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
    // A new check-in supersedes any offer left over from the previous one, so
    // the banner never sits above an active check-in naming a different venue.
    setSavePlaceCandidateState(null);
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
      setViewState("active");
      setCompletedCheckIn(null);
      setAddTimeOpen(false);
      setAddTimeBusy(null);
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

  useLocalOnboardingActionHandler("location.nearby_check_in", async (slots) => {
    if (!ownerId || !vaultOwnerToken) {
      return {
        status: "blocked" as const,
        summary: "Unlock One first to check in.",
      };
    }
    const requestedDuration = nearestCheckInDurationMinutes(
      slots?.duration_minutes,
    );
    if (requestedDuration) setDurationMinutes(requestedDuration);

    await captureAndLoadPlaces();
    const candidates = automaticPlacesRef.current;

    const rawPlace = String(slots?.place ?? "").trim();
    if (rawPlace && candidates.length > 0) {
      const { resolved, unresolved } = resolveSpokenNames(
        candidates,
        rawPlace,
        (place) => place.name ?? place.text,
      );
      if (resolved.length === 1) {
        const match = resolved[0]!;
        setSelectedPlaceId(match.placeId);
        const matchName = match.name ?? match.text;
        return {
          status: "succeeded" as const,
          summary: `Matched ${matchName}. Call confirm_nearby_check_in with this place${
            requestedDuration
              ? ` for ${requestedDuration} minutes`
              : " and how long to check in for"
          } to finish.`,
          data: { subject: { name: matchName, detail: null } },
        };
      }
      const ambiguous = unresolved.find((entry) => entry.kind === "ambiguous");
      if (ambiguous && ambiguous.kind === "ambiguous") {
        const names = ambiguousMatchNames(ambiguous.matches, (place) =>
          place.name ?? place.text,
        );
        return {
          status: "blocked" as const,
          summary: names
            ? `${ambiguous.matches.length} nearby places match that: ${names}. Ask which one.`
            : "More than one nearby place matches that name. Ask which one.",
        };
      }
      // Named but not among the candidates -- fall through to listing what's
      // actually nearby rather than guessing.
    }

    if (candidates.length === 0) {
      // The same capture that fills automaticPlaces also sets one of these on
      // failure. Surfacing the real reason (permission denied, GPS too
      // coarse, a search error) instead of a generic "nothing is nearby"
      // matters here specifically -- the person just said where they are.
      const specificReason = locationErrorRef.current ?? placesErrorRef.current;
      return {
        status: "blocked" as const,
        summary: specificReason
          ? `${specificReason} Check-In is open -- search for the place there instead.`
          : "No plausible places nearby right now. Check-In is open -- search for the place there instead.",
      };
    }
    // Five short names comfortably fits the 320-char settlement-summary budget
    // (see adk_live.py's bounded_text) -- this is a hard cap on candidates
    // offered, not merely a display truncation.
    const names = candidates
      .slice(0, 5)
      .map((place) => place.name ?? place.text)
      .filter(Boolean)
      .join(", ");
    return {
      status: "succeeded" as const,
      summary: `Nearby: ${names}. Call confirm_nearby_check_in once they say which one${
        requestedDuration ? "" : " and for how long"
      }.`,
    };
  });

  useLocalOnboardingActionHandler(
    "location.confirm_nearby_check_in",
    async (slots) => {
      if (!ownerId || !vaultOwnerToken) {
        return {
          status: "blocked" as const,
          summary: "Unlock One first to check in.",
        };
      }
      const candidates = automaticPlacesRef.current;
      if (candidates.length === 0) {
        return {
          status: "blocked" as const,
          summary: "Say check in near me first so I know what's nearby.",
        };
      }
      const rawPlace = String(slots?.place ?? "").trim();
      if (!rawPlace) {
        return {
          status: "blocked" as const,
          summary: "Which place from the list?",
        };
      }
      const { resolved, unresolved } = resolveSpokenNames(
        candidates,
        rawPlace,
        (place) => place.name ?? place.text,
      );
      if (resolved.length !== 1) {
        const ambiguous = unresolved.find(
          (entry) => entry.kind === "ambiguous",
        );
        if (ambiguous && ambiguous.kind === "ambiguous") {
          const names = ambiguousMatchNames(ambiguous.matches, (place) =>
            place.name ?? place.text,
          );
          return {
            status: "blocked" as const,
            summary: names
              ? `${ambiguous.matches.length} nearby places match that: ${names}. Ask which one.`
              : "More than one nearby place matches that name. Ask which one.",
          };
        }
        return {
          status: "blocked" as const,
          summary:
            "That doesn't match any of the nearby places. Check-In is open -- search for it there instead.",
        };
      }
      const place = resolved[0]!;
      const resolvedDuration = nearestCheckInDurationMinutes(
        slots?.duration_minutes,
      );
      if (!resolvedDuration) {
        return {
          status: "blocked" as const,
          summary: "For how long -- 30 minutes, 1 hour, or 2 hours?",
        };
      }
      if (mutationInFlightRef.current) {
        return {
          status: "blocked" as const,
          summary: "Already checking in -- one moment.",
        };
      }
      // Read Part 1's standing defaults directly rather than the on-screen
      // consentAccepted/allowConnectionRequests state: those default to
      // false and reset every mount, and calling checkIn() right after a
      // setState here would still see THIS render's stale, pre-update
      // closure -- setState does not retroactively change what an
      // already-created closure reads.
      let visibilityDefault: boolean;
      let allowConnectionRequestsDefault: boolean;
      try {
        const preferences =
          await OneLocationService.getNearbyCheckInPreferences(
            vaultOwnerToken,
          );
        visibilityDefault = preferences.visible;
        allowConnectionRequestsDefault = preferences.allowConnectionRequests;
      } catch {
        return {
          status: "blocked" as const,
          summary:
            "Couldn't read your Nearby Check-In defaults. Try again in a moment, or tap to check in and confirm there.",
        };
      }
      if (!visibilityDefault) {
        return {
          status: "blocked" as const,
          summary:
            "Nearby Check-In visibility is turned off in Voice Settings, so I can't check you in without a tap. Turn it on there, or tap to check in and confirm on screen.",
        };
      }
      setSelectedPlaceId(place.placeId);
      setDurationMinutes(resolvedDuration);
      setConsentAccepted(true);
      setAllowConnectionRequests(allowConnectionRequestsDefault);
      mutationInFlightRef.current = true;
      setBusy("check-in");
      try {
        const freshPoint = await captureCurrentPosition({ fresh: true });
        if (!hasCheckInAccuracy(freshPoint)) {
          setPoint(null);
          setLocationRecovery(isNative() ? "app-settings" : null);
          setLocationError(
            "We couldn't confirm where you are at the moment you checked in. Nothing was shared — try again in a second.",
          );
          return {
            status: "blocked" as const,
            summary:
              "Couldn't confirm your location precisely enough. Nothing was shared — try again in a second.",
          };
        }
        setAccuracyNotice(
          isCoarseAccuracy(freshPoint) ? coarseAccuracyNotice(freshPoint) : null,
        );
        setPoint(freshPoint);
        const next = await OneLocationService.checkInNearby({
          vaultOwnerToken,
          placeId: place.placeId,
          point: freshPoint,
          durationMinutes: resolvedDuration,
          consentAccepted: true,
          allowConnectionRequests: allowConnectionRequestsDefault,
        });
        publishState(next);
        setViewState("active");
        setCompletedCheckIn(null);
        setAddTimeOpen(false);
        setAddTimeBusy(null);
        setAutomaticPlaces([]);
        setSearchResults([]);
        setSelectedPlaceId("");
        setSearch("");
        setAccuracyNotice(null);
        toast.success("You're checked in nearby.");
        const placeName = place.name ?? place.text;
        return {
          status: "succeeded" as const,
          summary: `Checked in at ${placeName} for ${resolvedDuration} minutes.`,
          data: {
            subject: { name: placeName, detail: `${resolvedDuration} min` },
          },
        };
      } catch (error) {
        const details = OneLocationService.nearbyCheckInErrorDetails(error);
        toast.error(details.message);
        return { status: "blocked" as const, summary: details.message };
      } finally {
        mutationInFlightRef.current = false;
        setBusy(null);
      }
    },
  );

  /**
   * Decide whether the checked-out venue is worth offering to Saved Places.
   *
   * Silent on every "no": a locked vault, a read failure, or a place already
   * saved within {@link SAVED_LOCATION_DUPLICATE_RADIUS_METERS} all just skip
   * the banner. This runs after a checkout the person already saw succeed, so
   * a follow-up nicety must never produce an error toast of its own.
   */
  const offerSavePlace = useCallback(
    async (candidate: SavePlaceCandidate | null) => {
      if (!candidate || !ownerId || !vaultKey || !vaultOwnerToken) return;
      try {
        const existing = await loadSavedLocations({
          userId: ownerId,
          vaultKey,
          vaultOwnerToken,
        });
        if (findDuplicateSavedLocation(existing, candidate)) return;
        setSavePlaceCandidateState(candidate);
      } catch {
        // Reading Saved Places is best-effort here. If it fails we simply do
        // not offer, rather than reporting a second failure for something the
        // person never asked for.
      }
    },
    [ownerId, vaultKey, vaultOwnerToken],
  );

  const saveCheckedOutPlace = async () => {
    if (
      !savePlaceCandidateState ||
      !ownerId ||
      !vaultKey ||
      !vaultOwnerToken ||
      savingPlace
    ) {
      return;
    }
    const candidate = savePlaceCandidateState;
    setSavingPlace(true);
    try {
      await addSavedLocation({
        context: { userId: ownerId, vaultKey, vaultOwnerToken },
        input: {
          // Pinned to "other" rather than `defaultSavedLocationCategory`, which
          // returns "home" whenever no home is set yet. A venue you checked out
          // of is not your home, and silently filing the first one as Home
          // would be a wrong answer that is tedious to undo.
          category: "other",
          label: candidate.label,
          latitude: candidate.latitude,
          longitude: candidate.longitude,
        },
      });
      toast.success("Saved.");
      setCompletedCheckIn((current) =>
        current ? { ...current, saved: true, saveError: null } : current,
      );
      setSavePlaceCandidateState(null);
    } catch (error) {
      if (error instanceof DuplicateSavedLocationError) {
        // Saved from somewhere else between the offer and the tap. The intent
        // is satisfied either way, so retire the banner without an error.
        setCompletedCheckIn((current) =>
          current ? { ...current, saved: true, saveError: null } : current,
        );
        setSavePlaceCandidateState(null);
        return;
      }
      setCompletedCheckIn((current) =>
        current
          ? { ...current, saveError: "Couldn't save this place." }
          : current,
      );
      toast.error("Couldn't save this place.");
    } finally {
      setSavingPlace(false);
    }
  };

  const addTime = async (incrementMinutes: 30 | 60) => {
    if (!ownerId || !vaultOwnerToken || mutationInFlightRef.current) return;
    const ownerToken = vaultOwnerToken;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const generation = ++presenceMutationGenerationRef.current;
    presenceReadGenerationRef.current += 1;
    mutationInFlightRef.current = true;
    setAddTimeBusy(incrementMinutes);
    setBusy(`add-time:${incrementMinutes}`);
    try {
      const next = await OneLocationService.extendNearbyPresence({
        vaultOwnerToken: ownerToken,
        incrementMinutes,
      });
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        presenceMutationGenerationRef.current !== generation
      ) {
        return;
      }
      publishState(next);
      setViewState(next.presence ? "active" : "setup");
      setAddTimeOpen(false);
      toast.success(
        incrementMinutes === 60 ? "1 hour added." : "30 minutes added.",
      );
    } catch {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        toast.error("Couldn't add time.");
      }
    } finally {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        mutationInFlightRef.current = false;
        setAddTimeBusy(null);
        setBusy(null);
      }
    }
  };

  const finishCompletedCheckIn = () => {
    setCompletedCheckIn(null);
    setSavePlaceCandidateState(null);
    setViewState("setup");
    onOpenChange(false);
  };

  const checkout = async () => {
    if (!ownerId || !vaultOwnerToken || mutationInFlightRef.current) return;
    const ownerToken = vaultOwnerToken;
    // Snapshot the anchor before checkout clears the presence record.
    const savedPlaceOffer = savePlaceCandidate(state.presence);
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
      setViewState("completed");
      setCompletedCheckIn({
        placeLabel: savedPlaceOffer?.label ?? state.presence?.placeLabel ?? null,
        saved: false,
        saveError: null,
      });
      setConsentAccepted(false);
      setAllowConnectionRequests(false);
      setOptionsOpen(false);
      setAddTimeOpen(false);
      setAddTimeBusy(null);
      toast.success("Check-in ended.");
      void offerSavePlace(savedPlaceOffer);
    } catch {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        toast.error(
          "Couldn't end the check-in. You may still be visible nearby.",
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

  // No voice handler for location.checkout_nearby lives here, deliberately.
  // It is in BACKEND_DIRECT_ACTION_IDS (consent-protocol's action_tools.py),
  // so the backend mutates through the service layer directly and never parks
  // a client directive for a local handler to pick up -- a handler registered
  // here could not fire. One briefly existed on the mistaken reading that a
  // missing local handler meant the action was broken; a backend-direct action
  // needs no frontend registration at all.

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

  // Deliberately NOT modal, and deliberately without a scrim.
  //
  // Check-in is a question about the map -- "which of these nearby places are
  // you at?" -- so the map has to stay readable and pannable to answer it. The
  // map already proves that intent elsewhere: it publishes camera padding from
  // this sheet's own rect so the pins stay framed above it. A modal sheet
  // contradicted that with a `fixed inset-0 z-[711] touch-none` scrim over the
  // whole screen, which blurred the very map it was asking about and left the
  // map's close X, Locate and Check-in controls visible but completely
  // untappable underneath it.
  //
  // Outside interactions are swallowed instead of dismissing, so panning or
  // zooming to find a place cannot close the sheet mid-answer. That makes the
  // close X the dismissal, which is why it needed a real 44px target (see
  // SheetContent).
  return (
    <Sheet modal={false} open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        // Handle-only, not the whole body.
        //
        // This sheet owns an inner scroll container (see below), so its own
        // `scrollTop` never leaves 0 — and the body-drag rule engages on
        // exactly that condition. Enabled for the body, every downward swipe
        // over the place list would have dismissed the sheet instead of
        // scrolling it. `contentDragDismiss={false}` leaves the handle as the
        // only drag surface: the phone gets the native grab-and-pull it
        // expects, the list scrolls, and dismissal still leaves the map
        // standing with its "Check in" pill to re-open.
        //
        // The panel used to pass `dragDismiss={false}`, which switched the
        // gesture off AND took the grab handle with it — a phone bottom sheet
        // with no affordance to put it away.
        contentDragDismiss={false}
        showOverlay={false}
        onInteractOutside={(event) => event.preventDefault()}
        // The map is a native view below the WebView, so a tap that lands on it
        // never reaches Radix as a normal outside-pointer event on some
        // platforms and does on others. Refusing both keeps dismissal identical
        // on web and on device instead of platform-dependent.
        onPointerDownOutside={(event) => event.preventDefault()}
        // Stop short of the map header instead of the default 85dvh. With the
        // scrim gone the controls behind are live again, so the sheet must not
        // be the thing covering them: 8.5rem clears the header's real stack
        // (56px control row + 8px gap + the Sharing row + its 16px padding)
        // plus the top safe area, and leaves a visible strip of map between the
        // two. Phone-only; the md rail is a side sheet and sets max-h-none.
        //
        // The desktop rail width comes from the shared constant so the browser
        // contract that asserts the map keeps the majority of the viewport is
        // measuring the number that actually ships.
        style={
          {
            "--check-in-rail-width": `${CHECK_IN_PANEL_DESKTOP_WIDTH_REM}rem`,
          } as CSSProperties
        }
        className="max-h-[calc(100dvh-env(safe-area-inset-top)-8.5rem-var(--kb-height,0px))] gap-0 overflow-hidden px-0 pb-[max(1rem,env(safe-area-inset-bottom))] md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none md:w-[var(--check-in-rail-width)] md:rounded-none md:rounded-l-[var(--app-card-radius-feature)] md:border-l md:border-t-0 md:data-[state=closed]:slide-out-to-right md:data-[state=open]:slide-in-from-right"
        data-testid="one-location-nearby-check-in-sheet"
        data-one-location-nearby-check-in-sheet=""
      >
        {/* No build-stage badge. "Preview" reported how finished the FEATURE
            is, which is a fact about our roadmap, not about the person or the
            decision in front of them — and it sat in the highest-priority slot
            on the screen, beside the title. Admission to nearby check-in is
            already gated by a build flag and a server cohort, so nobody
            reaches this sheet who was not meant to. */}
        <SheetHeader className="gap-0 border-b border-border/60 px-5 py-4 text-left">
          <div className="flex min-h-9 items-center gap-2 pr-10">
            <SheetTitle className="text-[17px] leading-6">
              Check in nearby
            </SheetTitle>
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

          {viewState === "completed" ? (
            <div className="space-y-4" data-testid="nearby-presence-completed">
              <section className="rounded-[18px] border border-border/60 bg-card p-4">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full",
                      SUCCESS_ROLE.tile,
                      SUCCESS_ROLE.glyph,
                    )}
                    aria-hidden="true"
                  >
                    <Check className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">Check-in ended</p>
                    {completedCheckIn?.placeLabel ? (
                      <p className="mt-0.5 truncate text-sm font-medium">
                        {completedCheckIn.placeLabel}
                      </p>
                    ) : null}
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      You're no longer visible nearby.
                    </p>
                    {completedCheckIn?.saved ? (
                      <p className="mt-2 text-xs font-medium text-muted-foreground">
                        Saved for next time.
                      </p>
                    ) : null}
                    {completedCheckIn?.saveError ? (
                      <p
                        className="mt-2 text-xs font-medium text-destructive"
                        role="alert"
                      >
                        {completedCheckIn.saveError}
                      </p>
                    ) : null}
                  </div>
                </div>
              </section>
              <Button
                type="button"
                className="h-[52px] min-h-[52px] w-full rounded-2xl"
                onClick={finishCompletedCheckIn}
              >
                Done
              </Button>
              {savePlaceCandidateState && !completedCheckIn?.saved ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 min-h-11 w-full text-muted-foreground"
                  isLoading={savingPlace}
                  onClick={() => void saveCheckedOutPlace()}
                >
                  <Star className="h-4 w-4" />
                  Save for faster check-ins
                </Button>
              ) : null}
            </div>
          ) : viewState === "loading" ||
            (loadingPresence && !state.presence) ? null : state.presence ? (
            <div className="space-y-4" data-testid="nearby-presence-active">
              <section className="rounded-[18px] border border-border/60 bg-card p-4">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full",
                      SUCCESS_ROLE.tile,
                      SUCCESS_ROLE.glyph,
                    )}
                    aria-hidden="true"
                  >
                    <Check className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">Checked in</p>
                    <p
                      className="mt-0.5 truncate text-sm font-medium"
                      title={state.presence.placeLabel || undefined}
                    >
                      {state.presence.placeLabel || "Your place"}
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {[
                        timeLeftLabel(state.presence.expiresAt),
                        peopleNearbyLabel(state.attendees.length),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {activeDriftMeters !== null &&
                    activeDriftMeters > NEARBY_DRIFT_NUDGE_METERS ? (
                      <p
                        className="mt-2 flex items-start gap-1.5 text-xs leading-4 text-muted-foreground"
                        data-testid="nearby-active-drift"
                      >
                        <LocateFixed
                          className="mt-px h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span>
                          You’ve moved away. People still see you here.
                        </span>
                      </p>
                    ) : null}
                  </div>
                </div>
              </section>

              <section aria-labelledby="nearby-people-title">
                {/* The privacy mechanism used to be spelled out here in two
                    sentences, every time. The behaviour is unchanged — an
                    attendee object carries a name and nothing else, never a
                    coordinate — but a person reading a roster of names is not
                    asking how the roster is built. The count keeps its badge
                    only once there is a count worth reading; beside an empty
                    state that already says "nobody", a "0" is the same word
                    twice. */}
                <div className="flex items-center justify-between gap-3">
                  <h2 id="nearby-people-title" className="font-semibold">
                    People nearby
                  </h2>
                  {state.attendees.length ? (
                    <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">
                      {state.attendees.length}
                    </span>
                  ) : null}
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
                          // Back from Consent Center returns to the screen this
                          // was opened from -- check-in's own route. Naming Your
                          // Map here sent the person to a screen that withholds
                          // the check-in sheet, which then redirected on to the
                          // same place: the flow they had left visibly rebuilt
                          // itself twice before reappearing.
                          router.push(
                            buildConsentCenterHref("pending", {
                              from: ROUTES.ONE_LOCATION_CHECK_IN,
                            }),
                          )
                        }
                      />
                    ))}
                  </ul>
                ) : (
                  <div className="mt-3 rounded-2xl bg-muted/70 px-4 py-5 text-center">
                    <UsersRound className="mx-auto h-5 w-5 text-muted-foreground" />
                    {/* The auto-refresh line is gone. The list refreshes on a
                        timer whether or not it is advertised, and telling
                        someone their empty list will keep checking itself is
                        an implementation detail dressed as reassurance. */}
                    <p className="mt-2 text-sm font-medium">Nobody nearby yet</p>
                  </div>
                )}
              </section>

              {addTimeOpen ? (
                <section
                  className="rounded-[18px] border border-border/60 bg-card p-3"
                  aria-label="Add time"
                >
                  <div className="grid grid-cols-2 gap-2">
                    {([30, 60] as const).map((increment) => (
                      <Button
                        key={increment}
                        type="button"
                        variant="secondary"
                        className="h-11 min-h-11"
                        disabled={busy !== null}
                        onClick={() => void addTime(increment)}
                      >
                        {addTimeBusy === increment ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : null}
                        {increment === 60 ? "1 hour more" : "30 min more"}
                      </Button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="mt-2 h-10 min-h-10 w-full text-muted-foreground"
                    disabled={busy !== null}
                    onClick={() => setAddTimeOpen(false)}
                  >
                    Cancel
                  </Button>
                </section>
              ) : null}

              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="h-12 min-h-12"
                  disabled={busy !== null}
                  onClick={() => setAddTimeOpen((current) => !current)}
                >
                  Add time
                </Button>
                <Button
                  type="button"
                  variant={CHECK_OUT_BUTTON_VARIANT}
                  className="h-12 min-h-12"
                  disabled={busy !== null}
                  onClick={() => void checkout()}
                >
                  {busy === "checkout" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  {busy === "checkout" ? "Leaving..." : "I'm leaving"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-5" data-testid="nearby-presence-setup">
              <section>
                {/* "Places within 500 m" restated the circle the map is
                    already drawing directly behind this panel, in the units
                    the backend happens to use. The radius is unchanged and
                    still named on the map's own legend; the heading only has
                    to say what the list is. */}
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">Nearby places</h2>
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
                      <span className="sr-only">Search</span>
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
                        placeholder="Search places"
                        className="h-11 rounded-full pl-9"
                      />
                      {searching ? (
                        <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                      ) : null}
                    </label>

                    <div
                      className={CHECK_IN_CATEGORY_ROW_CLASSNAME}
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
                        // One supporting line, not two joined by a middot.
                        //
                        // The row is a choice between venues the person can
                        // see out of the window, so the useful cue is what
                        // kind of place it is. A postal address is longer than
                        // the row, always truncates, and the tail that gets
                        // cut is the part that would have disambiguated it —
                        // so it cost a line and answered nothing. The address
                        // still shows when there is no category to show
                        // instead, and the full pair stays in the title
                        // attribute for a pointer and for assistive tech.
                        const category = place.category?.trim() || "";
                        const address = place.address?.trim() || "";
                        const metadataLabel = category || address;
                        const metadataTitle = Array.from(
                          new Set([category, address].filter(Boolean)),
                        ).join(" · ");
                        return (
                          <button
                            key={place.placeId}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={cn(
                              CHECK_IN_PLACE_ROW_CLASSNAME,
                              selected
                                ? CHECK_IN_PLACE_ROW_ON_CLASSNAME
                                : CHECK_IN_PLACE_ROW_OFF_CLASSNAME,
                            )}
                            onClick={() => setSelectedPlaceId(place.placeId)}
                          >
                            <MapPin className="h-4 w-4 shrink-0 text-[var(--app-accent-deep)] dark:text-[var(--app-accent-bright)]" />
                            <span className="min-w-0 flex-1">
                              <span
                                title={name}
                                className={CHECK_IN_PLACE_NAME_CLASSNAME}
                              >
                                {name}
                              </span>
                              {metadataLabel ? (
                                <span
                                  title={metadataTitle}
                                  className={CHECK_IN_PLACE_META_CLASSNAME}
                                >
                                  {metadataLabel}
                                </span>
                              ) : null}
                            </span>
                            <span className={CHECK_IN_PLACE_DISTANCE_CLASSNAME}>
                              {compactDistanceLabel(place.distanceMeters)}
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
                            See all {places.length}
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
                        <p className="text-sm font-medium">Nothing here</p>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="mt-3"
                          onClick={() => selectCategory("all")}
                        >
                          See all {automaticPlaces.length}
                        </Button>
                      </div>
                    ) : null}
                    {/* Attribution only. The count that used to lead this line
                        is already on the "See all N" control and in the list
                        itself, and "N places · Google Maps" read as one fact
                        when it was two. The provider name stays because the
                        Places terms require it wherever their data is shown. */}
                    {places.length ? (
                      <p className="mt-2 text-xs text-muted-foreground">
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
                {/* Matches the "Nearby places" heading above it: a plain word
                    pair, no leading glyph. One of the two section headings
                    carrying an icon and the other not was the only reason
                    they did not read as a pair. */}
                <h2 className="font-semibold">Visible for</h2>
                {/* Raw <button>, not the morphy <Button>: at `size="default"`
                    that component carries min-h-[50px] in a different
                    tailwind-merge group from h-*, and `.ui-text-button-label`
                    forces 17px !important — so it cannot be made compact from
                    the outside. These are the same class strings the share
                    duration ladder uses for the identical role (44px, 15px),
                    so the two duration controls in this product can no longer
                    disagree about how big a duration choice is. */}
                <div className={cn("mt-3", CHECK_IN_DURATION_GRID_CLASS)}>
                  {DURATIONS.map((duration) => (
                    <button
                      key={duration.value}
                      type="button"
                      aria-pressed={durationMinutes === duration.value}
                      onClick={() => setDurationMinutes(duration.value)}
                      className={cn(
                        DURATION_CELL_CLASS,
                        durationMinutes === duration.value
                          ? DURATION_CELL_ON_CLASS
                          : DURATION_CELL_OFF_CLASS,
                      )}
                    >
                      {duration.label}
                    </button>
                  ))}
                </div>
              </section>

              {/*
                Two preferences, one of them load-bearing.

                "Appear nearby" stays in the open because it is the consent the
                server requires and the condition the Check in button is
                disabled on. Hiding the only reason a primary action is greyed
                out behind a disclosure would make the button look broken.

                "Connection requests" is genuinely a preference: it defaults
                off, changes nothing about who can see the person, and only
                decides whether someone already looking at their name may ask
                to connect. It does not need answering before every check-in,
                so it drops one level. Same state, same default, same value
                sent — only its prominence changes.
              */}
              <section className="rounded-2xl border border-border/60">
                <label className="flex cursor-pointer items-start gap-3 p-4">
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
                      Your name only
                    </span>
                  </span>
                </label>

                <button
                  type="button"
                  className="flex min-h-11 w-full items-center justify-between gap-4 border-t border-border/60 px-4 py-2.5 text-left"
                  aria-expanded={optionsOpen}
                  aria-controls="nearby-check-in-options"
                  onClick={() => setOptionsOpen((current) => !current)}
                >
                  <span className="text-sm font-semibold">Options</span>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                      optionsOpen && "rotate-180",
                    )}
                    aria-hidden="true"
                  />
                </button>
                <div
                  id="nearby-check-in-options"
                  hidden={!optionsOpen}
                  className="px-4 pb-4"
                >
                  <div className="flex min-h-11 items-center justify-between gap-4">
                    <p className="text-sm">Connection requests</p>
                    <Switch
                      checked={allowConnectionRequests}
                      onCheckedChange={setAllowConnectionRequests}
                      aria-label="Allow nearby connection requests"
                    />
                  </div>
                </div>
              </section>

              <Button
                type="button"
                // Both halves, or neither lands: `h-12` alone loses to the
                // size variant's own min-h-[50px], which is why this button has
                // been 50px the whole time its class said 48.
                className="h-12 min-h-12 w-full disabled:!bg-muted disabled:!text-muted-foreground disabled:!opacity-100"
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
