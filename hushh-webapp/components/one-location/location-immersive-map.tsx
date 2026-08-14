"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  GoogleMap,
  LatLngBounds,
  type Circle,
  type Marker,
} from "@capacitor/google-maps";
import { App as CapacitorApp } from "@capacitor/app";
import {
  ChevronDown,
  Eye,
  EyeOff,
  LocateFixed,
  Loader2,
  MapPin,
  Search,
  UsersRound,
  WifiOff,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import {
  NearbyCheckInSheet,
  type NearbyCheckInPlaceFocus,
} from "@/components/one-location/nearby-check-in/nearby-check-in-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRequireAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  decryptLocationEnvelope,
  encryptLocationForRecipient,
} from "@/lib/one-location/encryption";
import { buildCheckInHrefFromYourMap } from "@/lib/one-location/check-in-navigation";
import {
  readLocationWorkspaceMemory,
  writeLocationWorkspaceMemory,
} from "@/lib/one-location/location-workspace-memory";
import { updateOneLocationControlState } from "@/lib/one-location/location-control-state";
import {
  getBrowserMapsApiKey,
  getNativeMapsApiKey,
} from "@/lib/one-location/maps-config";
import { isOneLocationNearbyCheckInAvailable } from "@/lib/one-location/nearby-check-in-availability";
import {
  consumeNearbyPrivateReturn,
  NEARBY_PRIVATE_RESUME_PARAM,
} from "@/lib/one-location/nearby-private-navigation";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationMapMarker,
  OneLocationMapPreferences,
  OneLocationNearbyAttendee,
  OneLocationNearbyPresenceState,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { getPlatform, isNative } from "@/lib/capacitor/platform";
import { ROUTES } from "@/lib/navigation/routes";
import {
  isLocationMapDemoAvailable,
  isLocationMapDemoEnabled,
  locationMapDemoPeople,
} from "@/lib/testing/location-map-demo";
import { beginRouteTransition } from "@/lib/morphy-ux/hooks/use-route-transition";
import { motionDurations, motionEasings } from "@/lib/morphy-ux/motion";
import { useVault } from "@/lib/vault/vault-context";
import {
  claimNativeMap,
  isNativeMapSuperseded,
  waitForLaidOutBox,
  withNativeMapLock,
} from "@/lib/one-location/native-map-lifecycle";
import {
  GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
  readCachedRendererConsentAccepted,
  writeCachedRendererConsentAccepted,
} from "@/lib/one-location/map-renderer-consent";

const MAP_ID = "one-location-private-map";

// Create and destroy for this id are serialized in `native-map-lifecycle`.
// The plugin addresses every native map by its string id alone and cannot
// cancel an in-flight create, so an unmount inside a create window used to let
// an abandoned instance destroy the map the NEXT mount had just created --
// leaving Your Map blank while the screen reported itself ready. See that
// module for the full contract and its latency budget.

const NEARBY_CHECK_IN_RADIUS_METERS = 500;
const TRAY_COLLAPSED_HEIGHT_PX = 56; // 3.5rem, the collapsed pill.
// The section's own `border` (1px top + 1px bottom) is border-box, so it
// eats into the content area rather than shrink it away from the header and
// scroll container. It is the one piece of the sheet's height that isn't a
// measured DOM element, so it stays a literal constant -- everything else
// below is read from the real, rendered header and body instead of guessed.
const TRAY_BORDER_HEIGHT_PX = 2;
const MAP_ACCENT_CONTROL_CLASSNAME =
  "!border-[var(--app-accent-border)] !bg-[var(--app-accent-surface)] !text-[var(--app-accent-deep)] hover:!bg-[var(--app-accent-surface-strong)] dark:!text-[var(--app-accent-bright)]";
const MAP_ACCENT_ACTIVE_CLASSNAME =
  "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-fg)] hover:bg-[var(--app-accent-hover)]";

type RenderMarker = {
  key: string;
  point: PlainLocationPoint;
  label: string;
  /**
   * `place` is the venue the owner is checking in to. It is deliberately
   * distinct from `self`: the two are frequently a street apart, and collapsing
   * them is what made the map unable to explain where a check-in actually is.
   */
  kind: "person" | "self" | "place";
  grantId?: string;
  tint?: { r: number; g: number; b: number; a: number };
  /**
   * When this position was taken, not when it was fetched. A person whose
   * phone locked keeps their last known pin instead of disappearing, and this
   * is what lets the map say so rather than quietly implying they are still
   * moving.
   */
  capturedAt?: string | null;
};

/** Grey. A pin whose owner has gone quiet stops claiming to be live. */
const STALE_TINT = { r: 142, g: 142, b: 147, a: 255 } as const;

/** "last seen 7m ago" -- a fact about their signal, not their intent. */
function lastSeenLabel(
  capturedAt: string | null | undefined,
  nowMs: number,
): string | null {
  if (!capturedAt) return null;
  const captured = Date.parse(capturedAt);
  if (!Number.isFinite(captured)) return null;
  const minutes = Math.floor(Math.max(0, nowMs - captured) / 60_000);
  if (minutes < 1) return "last seen just now";
  if (minutes < 60) return `last seen ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${Math.floor(hours / 24)}d ago`;
}

function isStaleAt(
  capturedAt: string | null | undefined,
  freshnessSeconds: number,
  nowMs: number,
): boolean {
  if (!capturedAt) return false;
  const captured = Date.parse(capturedAt);
  if (!Number.isFinite(captured)) return false;
  return nowMs - captured > freshnessSeconds * 1_000;
}

function displayLabel(marker: OneLocationMapMarker): string {
  return marker.grant.ownerDisplayName?.trim() || "A trusted person";
}

function personInitials(label: string): string {
  return label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() || "")
    .join("");
}

function nearbyRelationshipLabel(attendee: OneLocationNearbyAttendee): string {
  if (attendee.relationship === "connected") return "Connected";
  if (attendee.relationship === "pending_outgoing") return "Checked in nearby";
  if (attendee.relationship === "pending_incoming") return "Wants to connect";
  return attendee.canConnect ? "Available to connect" : "Checked in nearby";
}

function mapApiKey(): string {
  if (!isNative()) return getBrowserMapsApiKey();
  const platform = getPlatform();
  return platform === "ios" || platform === "android"
    ? getNativeMapsApiKey(platform)
    : "";
}

function markerSignature(markers: RenderMarker[]): string {
  return markers
    .map((marker) =>
      [
        marker.key,
        marker.point.latitude.toFixed(6),
        marker.point.longitude.toFixed(6),
        marker.point.capturedAt,
      ].join(":"),
    )
    .join("|");
}

function zoomForAccuracy(accuracyM: number | null | undefined): number {
  if (!Number.isFinite(accuracyM)) return 16;
  if (Number(accuracyM) <= 40) return 16;
  if (Number(accuracyM) <= 150) return 15;
  if (Number(accuracyM) <= 1_000) return 14;
  return 12;
}

async function frameMarkers(
  map: GoogleMap,
  markers: RenderMarker[],
): Promise<void> {
  if (markers.length === 0) return;
  if (markers.length === 1) {
    const marker = markers[0];
    if (!marker) return;
    await map.setCamera({
      coordinate: {
        lat: marker.point.latitude,
        lng: marker.point.longitude,
      },
      zoom: 15,
      animate: true,
    });
    return;
  }

  const latitudes = markers.map((marker) => marker.point.latitude);
  const longitudes = markers.map((marker) => marker.point.longitude);
  const southwest = {
    lat: Math.min(...latitudes),
    lng: Math.min(...longitudes),
  };
  const northeast = {
    lat: Math.max(...latitudes),
    lng: Math.max(...longitudes),
  };
  const center = {
    lat: (southwest.lat + northeast.lat) / 2,
    lng: (southwest.lng + northeast.lng) / 2,
  };
  await map.fitBounds(new LatLngBounds({ southwest, northeast, center }), 24);
}

function wrappedLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function radiusBounds(
  point: { latitude: number; longitude: number },
  radiusMeters: number,
) {
  const latitudeDelta = radiusMeters / 111_320;
  const longitudeScale = Math.abs(
    Math.cos((point.latitude * Math.PI) / 180),
  );
  const longitudeDelta = Math.min(
    180,
    radiusMeters / (111_320 * Math.max(longitudeScale, 0.000001)),
  );
  const southwest = {
    lat: Math.max(-90, point.latitude - latitudeDelta),
    lng:
      longitudeDelta === 180
        ? -180
        : wrappedLongitude(point.longitude - longitudeDelta),
  };
  const northeast = {
    lat: Math.min(90, point.latitude + latitudeDelta),
    lng:
      longitudeDelta === 180
        ? 180
        : wrappedLongitude(point.longitude + longitudeDelta),
  };
  return new LatLngBounds({
    southwest,
    northeast,
    center: { lat: point.latitude, lng: point.longitude },
  });
}

/**
 * Bounds that contain two points with breathing room around them.
 *
 * Used to frame the owner and the place they are checking in to together: if
 * either falls off-screen, the gap between them stops being legible, which is
 * the one thing this view exists to show.
 */
function pairBounds(
  first: { lat: number; lng: number },
  second: { lat: number; lng: number },
) {
  const minimumSpanDegrees = 400 / 111_320;
  const latitudePad = Math.max(
    minimumSpanDegrees,
    Math.abs(first.lat - second.lat) * 0.35,
  );
  const longitudePad = Math.max(
    minimumSpanDegrees,
    Math.abs(first.lng - second.lng) * 0.35,
  );
  return new LatLngBounds({
    southwest: {
      lat: Math.max(-90, Math.min(first.lat, second.lat) - latitudePad),
      lng: wrappedLongitude(Math.min(first.lng, second.lng) - longitudePad),
    },
    northeast: {
      lat: Math.min(90, Math.max(first.lat, second.lat) + latitudePad),
      lng: wrappedLongitude(Math.max(first.lng, second.lng) + longitudePad),
    },
    center: {
      lat: (first.lat + second.lat) / 2,
      lng: (first.lng + second.lng) / 2,
    },
  });
}

/**
 * Full-screen private-map surface. It only receives ciphertext for active
 * recipient-scoped grants, decrypts it in foreground memory, and destroys both
 * renderer and coordinates on unmount. Opening this route requests one
 * foreground location fix so the initial camera settles on the current device;
 * it never starts a background watcher or publishes that fix to recipients.
 */
/**
 * `surface` decides which product this screen is.
 *
 * "map" is Your Map: the people who already share their location with you,
 * pinned, plus your own position. "check-in" is the nearby flow: a place you
 * pick, the 500 m area around it, and a list of opted-in people there. They
 * were the same route with a drawer on top, so both read as one feature and QA
 * could not tell them apart. The private-share pins and the people tray belong
 * to Your Map only, and are withheld here.
 */
export function LocationImmersiveMap({
  surface = "map",
}: {
  surface?: "map" | "check-in";
} = {}) {
  const isCheckInSurface = surface === "check-in";
  const searchParams = useSearchParams();
  const router = useRouter();
  const auth = useRequireAuth();
  const { vaultOwnerToken } = useVault();
  const demoAvailable = isLocationMapDemoAvailable();
  const nearbyCheckInAvailable = isOneLocationNearbyCheckInAvailable();
  // Below md, Check-in moves into the header's center column (Sharing steps
  // aside there -- see the header below) instead of sitting grouped with
  // Locate on the trailing edge. A CSS-only breakpoint can't do this: the
  // same control can't sit centered-alone in one column and grouped with a
  // sibling in another without literally living in two places in the tree,
  // so this picks the one place it actually renders.
  const isMobile = useIsMobile();
  const initialDemoMode = isLocationMapDemoEnabled(searchParams.get("demo"));
  const mapElement = useRef<HTMLElement | null>(null);
  const mapRef = useRef<GoogleMap | null>(null);
  const topControlsRef = useRef<HTMLElement | null>(null);
  const peopleTrayRef = useRef<HTMLElement | null>(null);
  // Measures the tray's real rendered pieces -- the toggle header and the
  // body's natural (unclipped) content -- so the sheet can size itself to
  // its content instead of a hand-computed guess at their heights (a guess
  // that was previously off by the section's own border-width). Reading the
  // DOM directly here means there is nothing left to keep in sync by hand.
  const trayHeaderRef = useRef<HTMLButtonElement | null>(null);
  const trayContentRef = useRef<HTMLDivElement | null>(null);
  const [trayHeaderHeight, setTrayHeaderHeight] = useState(0);
  const [trayContentHeight, setTrayContentHeight] = useState(0);
  const markerIdsRef = useRef<string[]>([]);
  const markerGenerationRef = useRef(0);
  const markerCommandRef = useRef<Promise<void>>(Promise.resolve());
  const nearbyCircleIdsRef = useRef<string[]>([]);
  const nearbyConnectorIdsRef = useRef<string[]>([]);
  const nearbyCircleGenerationRef = useRef(0);
  const nearbyCircleCommandRef = useRef<Promise<void>>(Promise.resolve());
  const markerByMapIdRef = useRef<Map<string, RenderMarker>>(new Map());
  const framedInitialMarkersRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  /** A tick that arrived mid-refresh, to be served once the current one ends. */
  const refreshRequestedWhileBusyRef = useRef(false);
  /** Lets the finally block re-enter refresh without depending on itself. */
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const markerSignatureRef = useRef("");
  const initialDemoModeRef = useRef(initialDemoMode);
  const closeRequestedRef = useRef(false);
  const nearbyHistoryPreparedRef = useRef(false);
  // Whether the person has dismissed the sheet on check-in's own route. Held in
  // a ref, not the URL: the route-sync effect below re-runs whenever Next hands
  // back a fresh `searchParams` object, and without this the dismiss would be
  // undone on the next render.
  const checkInSheetDismissedRef = useRef(false);
  const entryLocationRequestedRef = useRef(false);
  const locationCaptureRef = useRef<Promise<PlainLocationPoint> | null>(null);
  const nearbyConnectInFlightRef = useRef(false);
  const nearbyConnectGenerationRef = useRef(0);
  const nearbyConnectOwnerRef = useRef({
    userId: auth.userId,
    vaultOwnerToken,
  });
  const [demoMode, setDemoMode] = useState(initialDemoMode);
  // Seeded from the local cache so a returning owner's map starts
  // initializing immediately instead of waiting on the consent re-check
  // below. That fetch still runs and remains authoritative.
  const [acceptedRenderer, setAcceptedRenderer] = useState(() =>
    readCachedRendererConsentAccepted(auth.userId),
  );
  const [preferences, setPreferences] = useState<OneLocationMapPreferences>({
    presenceMode: "ghost",
  });
  const [markers, setMarkers] = useState<RenderMarker[]>([]);
  // The server's own definition of live, rather than a second copy of 90 in
  // the client that could drift away from it.
  const [freshnessSeconds, setFreshnessSeconds] = useState(90);
  // Staleness is a function of time passing, not of new data arriving -- a pin
  // has to go grey while nothing at all is happening. The marker refresh alone
  // would never notice, because a phone that stopped publishing sends nothing
  // to notice.
  const [staleClockMs, setStaleClockMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setStaleClockMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const [selfMarker, setSelfMarker] = useState<RenderMarker | null>(null);
  // Count of the account's own ACTIVE outgoing shares (people it is sharing
  // its location WITH). Sourced from the full getState (map-state only carries
  // incoming markers), so it's fetched on a lighter cadence than the 5s marker
  // refresh — the map surfaces it as a "Sharing with N" status, since outgoing
  // shares carry no coordinate to plot.
  const [activeShareCount, setActiveShareCount] = useState<number | null>(null);
  const [selected, setSelected] = useState<RenderMarker | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [trayExpanded, setTrayExpanded] = useState(true);
  const [closing, setClosing] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [entryLocationSettled, setEntryLocationSettled] = useState(false);
  const [status, setStatus] = useState<
    "idle" | "loading" | "ready" | "unavailable" | "error"
  >("idle");
  // Why the map is unavailable. Both causes used to render the same card, which
  // told the user "no location was captured or exposed" when their location was
  // fine and the build simply had no Maps key — sending them to debug the wrong
  // thing entirely.
  const [unavailableReason, setUnavailableReason] = useState<
    "maps-key" | "renderer"
  >("maps-key");
  const [busy, setBusy] = useState<"presence" | "locate" | null>(null);
  const [nearbyConnectionBusyAlias, setNearbyConnectionBusyAlias] = useState<
    string | null
  >(null);
  const [nearbyCheckInOpen, setNearbyCheckInOpen] = useState(false);
  const [nearbySearchPoint, setNearbySearchPoint] =
    useState<PlainLocationPoint | null>(null);
  const [nearbyPlaceFocus, setNearbyPlaceFocus] =
    useState<NearbyCheckInPlaceFocus | null>(null);
  const [nearbyPresenceState, setNearbyPresenceState] =
    useState<OneLocationNearbyPresenceState>({
      presence: null,
      attendees: [],
    });
  const nearbyPresenceStateRef = useRef(nearbyPresenceState);
  const mountedRef = useRef(true);
  const rendererReady = acceptedRenderer || demoMode;

  useEffect(() => {
    nearbyConnectOwnerRef.current = {
      userId: auth.userId,
      vaultOwnerToken,
    };
  }, [auth.userId, vaultOwnerToken]);

  useEffect(() => {
    nearbyPresenceStateRef.current = nearbyPresenceState;
  }, [nearbyPresenceState]);

  useEffect(() => {
    const action = searchParams.get("action");
    if (
      !nearbyCheckInAvailable &&
      (action === "check-in" || action === "event-check-in")
    ) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("action");
      const query = params.toString();
      router.replace(
        query ? `${ROUTES.ONE_LOCATION_MAP}?${query}` : ROUTES.ONE_LOCATION_MAP,
        { scroll: false },
      );
      setNearbyCheckInOpen(false);
      return;
    }
    if (action === "event-check-in") {
      const params = new URLSearchParams(searchParams.toString());
      params.set("action", "check-in");
      router.replace(`${ROUTES.ONE_LOCATION_MAP}?${params.toString()}`, {
        scroll: false,
      });
      return;
    }
    // `?action=check-in` on the map route is the old entry point. Rather than
    // chase every caller -- the hub, breadcrumbs, notification deep links, and
    // anything already shared -- send them all to the destination that now owns
    // the flow. One redirect keeps old links working and stops the map from
    // rendering check-in over Your Map ever again.
    if (!isCheckInSurface && action === "check-in") {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("action");
      const query = params.toString();
      router.replace(
        query
          ? `${ROUTES.ONE_LOCATION_CHECK_IN}?${query}`
          : ROUTES.ONE_LOCATION_CHECK_IN,
        { scroll: false },
      );
      return;
    }
    // On its own route the sheet opens with the screen, but it is not welded to
    // it: once dismissed it stays dismissed until the person re-opens it, and
    // the check-in map is left standing underneath.
    if (!isCheckInSurface) {
      // Leaving the route retires the dismissal, so arriving at check-in always
      // arrives with the flow open.
      checkInSheetDismissedRef.current = false;
    }
    const requested = isCheckInSurface && !checkInSheetDismissedRef.current;
    setNearbyCheckInOpen(requested);
    if (
      !requested ||
      nearbyHistoryPreparedRef.current ||
      typeof window === "undefined"
    ) {
      return;
    }

    if (isCheckInSurface) {
      // A real route is already its own history entry: Back leaves check-in
      // without help. The synthetic boundary below existed only because the
      // sheet had no URL of its own, and re-creating it here would cost a
      // second Back press to escape. Consume any resume token and strip it so
      // a refresh cannot replay it.
      const surfaceResumeToken = searchParams.get(NEARBY_PRIVATE_RESUME_PARAM);
      if (surfaceResumeToken && typeof window !== "undefined") {
        consumeNearbyPrivateReturn(surfaceResumeToken);
        const resumedUrl = new URL(window.location.href);
        resumedUrl.searchParams.delete(NEARBY_PRIVATE_RESUME_PARAM);
        window.history.replaceState(window.history.state, "", resumedUrl.href);
      }
      nearbyHistoryPreparedRef.current = true;
      return;
    }

    const resumeToken = searchParams.get(NEARBY_PRIVATE_RESUME_PARAM);
    if (resumeToken) {
      const resumed = consumeNearbyPrivateReturn(resumeToken);
      const resumedUrl = new URL(window.location.href);
      resumedUrl.searchParams.delete(NEARBY_PRIVATE_RESUME_PARAM);
      window.history.replaceState(window.history.state, "", resumedUrl.href);
      if (resumed) {
        nearbyHistoryPreparedRef.current = true;
        return;
      }
    }

    // A direct/deep-linked check-in still gets a local Map history boundary:
    // first Back closes the sheet, the next Back leaves Your Map.
    const actionUrl = new URL(window.location.href);
    actionUrl.searchParams.delete(NEARBY_PRIVATE_RESUME_PARAM);
    const plainMapUrl = new URL(actionUrl.href);
    plainMapUrl.searchParams.delete("action");
    window.history.replaceState(window.history.state, "", plainMapUrl.href);
    window.history.pushState(window.history.state, "", actionUrl.href);
    nearbyHistoryPreparedRef.current = true;
  }, [isCheckInSurface, nearbyCheckInAvailable, router, searchParams]);

  const openNearbyCheckIn = useCallback(() => {
    if (!nearbyCheckInAvailable || !rendererReady || demoMode) {
      return;
    }
    // Already on the flow's own route: re-opening is a state change, not a
    // navigation. This is the way back in after a dismiss -- the "Check in"
    // pill in the top controls renders here too -- and pushing the route onto
    // itself would only stack a duplicate history entry.
    if (isCheckInSurface) {
      checkInSheetDismissedRef.current = false;
      setNearbyCheckInOpen(true);
      return;
    }
    if (searchParams.get("action") === "check-in") {
      return;
    }
    setTrayExpanded(false);
    // Recording Your Map as the opener is what lets dismiss come back here
    // instead of dropping the person on the Location hub.
    router.push(buildCheckInHrefFromYourMap(searchParams), {
      scroll: false,
    });
  }, [
    demoMode,
    isCheckInSurface,
    nearbyCheckInAvailable,
    rendererReady,
    router,
    searchParams,
  ]);

  const closeNearbyCheckIn = useCallback(() => {
    // Closing a drawer is not a request to leave the screen behind it.
    //
    // On its own route dismiss used to navigate -- first to the Location hub
    // for everyone, then to whichever screen a `?source=` param said had opened
    // the flow. Both were answering the wrong question. Someone who has just
    // checked in and swiped the sheet away wants the sheet away; the map they
    // were standing on, with where they are and the place they picked, is
    // already the right screen. Sending them anywhere -- especially back to the
    // Location hub, two screens from the flow they just completed -- reads as
    // the app throwing them out.
    //
    // What is left behind is a real screen, not a bare map: the top controls
    // still carry the "Check in" pill that re-opens the sheet, the locate
    // button, and an explicit "Back to Location" X for people who do want out.
    if (isCheckInSurface) {
      checkInSheetDismissedRef.current = true;
      setNearbyCheckInOpen(false);
      return;
    }
    setNearbyCheckInOpen(false);
    if (
      typeof window !== "undefined" &&
      new URL(window.location.href).searchParams.get("action") === "check-in"
    ) {
      window.history.back();
    }
  }, [isCheckInSurface]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const mobileQuery = window.matchMedia("(max-width: 767px)");
    const syncTouchState = () => {
      if (nearbyCheckInOpen && mobileQuery.matches) {
        void map.disableTouch();
        return;
      }
      if (!closing) void map.enableTouch();
    };
    syncTouchState();
    mobileQuery.addEventListener("change", syncTouchState);
    return () => mobileQuery.removeEventListener("change", syncTouchState);
  }, [closing, mapReady, nearbyCheckInOpen]);

  useEffect(() => {
    nearbyConnectGenerationRef.current += 1;
    nearbyConnectInFlightRef.current = false;
    setNearbyConnectionBusyAlias(null);
    setNearbyPresenceState({ presence: null, attendees: [] });
  }, [auth.userId, demoMode, nearbyCheckInAvailable, vaultOwnerToken]);

  const captureCurrentLocation = useCallback(
    (options?: {
      maxAgeMs?: number;
      fresh?: boolean;
    }): Promise<PlainLocationPoint> => {
      // A caller demanding a genuinely fresh fix must not be handed the
      // in-flight one this ref is holding — that is how the check-in anchor
      // silently became "wherever we already were".
      if (
        locationCaptureRef.current &&
        options?.maxAgeMs !== 0 &&
        !options?.fresh
      ) {
        return locationCaptureRef.current;
      }
      const request = OneLocationService.captureCurrentPosition(options);
      locationCaptureRef.current = request;
      void request.then(
        () => {
          if (locationCaptureRef.current === request) {
            locationCaptureRef.current = null;
          }
        },
        () => {
          if (locationCaptureRef.current === request) {
            locationCaptureRef.current = null;
          }
        },
      );
      return request;
    }, []);

  // Forwards `options` deliberately. Declared with no parameters, this silently
  // dropped a caller's `maxAgeMs: 0` — TypeScript accepts the narrower arity, so
  // it compiled clean while the check-in anchor quietly used a cached fix.
  const captureAndRememberCurrentLocation = useCallback(
    async (options?: { maxAgeMs?: number; fresh?: boolean }) => {
      const point = await captureCurrentLocation(options);
      if (auth.userId) {
        const workspace = readLocationWorkspaceMemory(auth.userId);
        writeLocationWorkspaceMemory(auth.userId, {
          ...workspace,
          myLocationPoint: point,
        });
      }
      return point;
    },
    [auth.userId, captureCurrentLocation],
  );

  const handleNearbyStateChange = useCallback(
    (next: OneLocationNearbyPresenceState) => {
      setNearbyPresenceState(next);
      if (!auth.userId) return;
      updateOneLocationControlState(auth.userId, (current) => ({
        ...current,
        paused: next.presence ? false : current.paused,
        nearbyPresenceActive: Boolean(next.presence),
        nearbyCheckedInAt: next.presence?.checkedInAt ?? null,
      }));
    },
    [auth.userId],
  );

  const focusSelfPoint = useCallback(
    async (
      point: PlainLocationPoint,
      options: { animate: boolean; select: boolean },
    ) => {
      const currentLocation: RenderMarker = {
        key: "current-device-location",
        kind: "self",
        label: "You",
        point,
        tint: { r: 0, g: 122, b: 255, a: 255 },
      };
      setSelfMarker(currentLocation);
      if (options.select) setSelected(currentLocation);
      if (auth.userId) {
        const workspace = readLocationWorkspaceMemory(auth.userId);
        writeLocationWorkspaceMemory(auth.userId, {
          ...workspace,
          myLocationPoint: point,
        });
      }
      await mapRef.current?.setCamera({
        coordinate: { lat: point.latitude, lng: point.longitude },
        zoom: zoomForAccuracy(point.accuracyM),
        animate: options.animate,
      });
    },
    [auth.userId],
  );

  useEffect(() => {
    if (!auth.userId || demoMode) return;
    const point = readLocationWorkspaceMemory(auth.userId).myLocationPoint;
    if (!point) return;
    setSelfMarker({
      key: "current-device-location",
      kind: "self",
      label: "You",
      point,
      tint: { r: 0, g: 122, b: 255, a: 255 },
    });
  }, [auth.userId, demoMode]);

  const refresh = useCallback(async () => {
    if (!vaultOwnerToken || !auth.userId || !rendererReady) return;
    if (refreshInFlightRef.current) {
      // A slow refresh used to swallow every tick that landed during it, and
      // the map then sat on whatever it had until some later tick happened to
      // find the door open. Remember that someone asked instead, and run once
      // more as soon as this one finishes, so the map converges on the truth
      // rather than on timing.
      refreshRequestedWhileBusyRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    setStatus("loading");
    try {
      if (demoMode) {
        const demoMarkers = locationMapDemoPeople().map((person) => ({
          ...person,
          kind: "person" as const,
        }));
        markerSignatureRef.current = markerSignature(demoMarkers);
        setMarkers(demoMarkers);
        setStatus("ready");
        return;
      }
      const state = await OneLocationService.getMapState(vaultOwnerToken);
      const resolved = await Promise.all(
        state.markers.map(async (marker): Promise<RenderMarker | null> => {
          try {
            const point = await decryptLocationEnvelope({
              userId: auth.userId!,
              envelope: marker.envelope,
            });
            return {
              key:
                marker.envelope.id ||
                `${marker.grant.id}:${marker.envelope.capturedAt}`,
              point,
              label: displayLabel(marker),
              kind: "person",
              grantId: marker.grant.id,
              capturedAt: marker.envelope.capturedAt ?? null,
            } satisfies RenderMarker;
          } catch {
            // A device without the recipient private key must not show a stale or
            // guessed marker. The owner can re-share after the recipient restores it.
            return null;
          }
        }),
      );
      if (!mountedRef.current) return;
      const nextMarkers = resolved.filter(
        (item): item is RenderMarker => item !== null,
      );
      setPreferences(state.preferences);
      if (Number.isFinite(state.freshnessSeconds) && state.freshnessSeconds > 0) {
        setFreshnessSeconds(state.freshnessSeconds);
      }
      const nextSignature = markerSignature(nextMarkers);
      if (nextSignature !== markerSignatureRef.current) {
        markerSignatureRef.current = nextSignature;
        setMarkers(nextMarkers);
      }
      setStatus("ready");
    } catch {
      if (mountedRef.current) setStatus("error");
    } finally {
      refreshInFlightRef.current = false;
      // Serve the tick that arrived while this one was running. Chained
      // rather than recursive, so a permanently slow backend cannot stack
      // calls on top of each other.
      if (refreshRequestedWhileBusyRef.current && mountedRef.current) {
        refreshRequestedWhileBusyRef.current = false;
        void refreshRef.current?.();
      }
    }
  }, [auth.userId, demoMode, rendererReady, vaultOwnerToken]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const refreshShareCount = useCallback(async () => {
    if (demoMode || !vaultOwnerToken || !auth.userId) return;
    try {
      const state = await OneLocationService.getState(vaultOwnerToken);
      if (!mountedRef.current) return;
      setActiveShareCount(
        state.ownerGrants.filter((grant) => grant.status === "active").length,
      );
    } catch {
      // A status count is non-critical; leave the last-known value in place.
    }
  }, [auth.userId, demoMode, vaultOwnerToken]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      markerIdsRef.current = [];
      nearbyCircleIdsRef.current = [];
      markerByMapIdRef.current.clear();
      // Deliberately does NOT destroy the map. The create effect's cleanup is
      // the single teardown owner and also runs on unmount, through the lock
      // that keeps destroys ordered against the next mount's create. A second
      // owner destroying MAP_ID unlocked from here is exactly how a live map
      // used to get torn down behind a screen that thought it was ready.
      // Android draws the native map behind the WebView. Restore every layer on
      // exit so no other Hussh surface becomes transparent.
      document.documentElement.classList.remove("one-location-map-native");
      document.body.classList.remove("one-location-map-native");
    };
  }, []);

  // Renderer consent is durable metadata, not a coordinate permission. Read it
  // before showing the disclosure so returning people do not have to accept on
  // every Map entry; no envelope is decrypted in this bootstrap step.
  useEffect(() => {
    if (!vaultOwnerToken || !auth.userId) return;
    if (demoMode) {
      setPreferences({ presenceMode: "ghost" });
      return;
    }
    // Re-apply the cache on every userId change (covers the case where the
    // very first render ran before auth.userId was available, so the lazy
    // useState initializer above saw nothing to read yet).
    if (readCachedRendererConsentAccepted(auth.userId)) {
      setAcceptedRenderer(true);
    }
    let cancelled = false;
    void OneLocationService.getMapState(vaultOwnerToken)
      .then((state) => {
        if (cancelled) return;
        setPreferences(state.preferences);
        const accepted =
          state.preferences.rendererConsentVersion ===
          GOOGLE_MAPS_RENDERER_CONSENT_VERSION;
        setAcceptedRenderer(accepted);
        writeCachedRendererConsentAccepted(auth.userId, accepted);
      })
      .catch(() => {
        // The disclosure remains available; do not misrepresent a transient
        // bootstrap error as a location or consent failure.
      });
    return () => {
      cancelled = true;
    };
  }, [auth.userId, demoMode, vaultOwnerToken]);

  useEffect(() => {
    markerSignatureRef.current = "";
    framedInitialMarkersRef.current = false;
    setMarkers([]);
    setSelected(null);
    setSearchQuery("");
  }, [demoMode]);

  useEffect(() => {
    if (!vaultOwnerToken || !rendererReady) return;
    void refresh();
    if (demoMode) return;
    void refreshShareCount();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5_000);
    // The outgoing-share count changes far less often than live positions, so
    // poll it on a much slower cadence than the 5s marker refresh.
    const shareCountTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshShareCount();
    }, 30_000);
    // Returning to the app is exactly when the map is most wrong, and the
    // interval only ever checked visibility on its own schedule -- so coming
    // back showed a position up to five seconds stale before anything moved.
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      void refreshShareCount();
    };
    document.addEventListener("visibilitychange", onVisibility);
    let appListener: { remove: () => Promise<void> } | undefined;
    if (isNative()) {
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) {
          void refresh();
          void refreshShareCount();
        }
      }).then((listener) => {
        appListener = listener;
      });
    }
    return () => {
      window.clearInterval(timer);
      window.clearInterval(shareCountTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      void appListener?.remove();
    };
  }, [demoMode, refresh, refreshShareCount, rendererReady, vaultOwnerToken]);

  useEffect(() => {
    // The renderer itself may initialize before consent -- what stays gated
    // behind rendererReady is any real coordinate. Below, a neutral world
    // view with zero markers is used until consent is given (same principle
    // demo mode already relies on: engaging the SDK is not the sensitive
    // part, showing this owner's own private data on it is). Real position
    // and recipient markers are set later, entirely by the separate
    // rendererReady-gated effects below, once this same map instance exists.
    if (!mapElement.current) return;
    const element = mapElement.current;
    const apiKey = mapApiKey();
    if (!apiKey) {
      setUnavailableReason("maps-key");
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    // Claimed before any await, so a later mount always wins the id even if
    // React runs this effect before the previous instance's cleanup.
    const claim = claimNativeMap(MAP_ID);
    if (isNative()) {
      document.documentElement.classList.add("one-location-map-native");
      document.body.classList.add("one-location-map-native");
    }
    // Only ever reads this device's OWN last-known point, and only once
    // consent already exists (a returning session via the cache above) --
    // never before the person has agreed to use this renderer at all.
    const cachedPoint = rendererReady
      ? readLocationWorkspaceMemory(auth.userId).myLocationPoint
      : null;
    const superseded = () =>
      cancelled || isNativeMapSuperseded(MAP_ID, claim);

    void withNativeMapLock(MAP_ID, async () => {
      // Never touch the bridge on behalf of a mount that is already gone: the
      // point of the lock is that a superseded instance cannot register a map
      // the live instance would then inherit and destroy out from under.
      if (superseded()) return;
      await waitForLaidOutBox(element);
      if (superseded()) return;
      const map = await GoogleMap.create({
        id: MAP_ID,
        element,
        apiKey,
        forceCreate: true,
        config: {
          center: cachedPoint
            ? { lat: cachedPoint.latitude, lng: cachedPoint.longitude }
            : initialDemoModeRef.current
              ? { lat: 37.7749, lng: -122.4194 }
              : { lat: 20, lng: 0 },
          zoom: cachedPoint
            ? zoomForAccuracy(cachedPoint.accuracyM)
            : initialDemoModeRef.current
              ? 11
              : 2,
          disableDefaultUI: true,
          // `styles` is deliberately NOT passed.
          //
          // @capacitor/google-maps sets its own `mapId` because advanced
          // markers require one, and Google ignores `styles` entirely whenever
          // a mapId is present — logging "A Map's styles property cannot be
          // set when a mapId is present" on every single map create. So this
          // was never theming anything: it was dead config that produced a
          // warning each time the map mounted, and made the console look like
          // the map was failing when it was not.
          //
          // Restoring a dark map means styling the mapId in the Google Cloud
          // console, which is where a mapId's appearance now lives. Passing
          // DARK_MAP_STYLES here cannot do it.
        },
      });
      if (superseded()) {
        // Still holding the lock, so this can only be destroying the map this
        // very call created -- never one a later mount registered.
        await map.destroy().catch(() => undefined);
        return;
      }
      mapRef.current = map;
      await map.setOnMarkerClickListener((event) => {
        const marker = markerByMapIdRef.current.get(event.markerId);
        if (!marker) return;
        setSelected(marker);
        void map.setCamera({
          coordinate: {
            lat: marker.point.latitude,
            lng: marker.point.longitude,
          },
          zoom: 15,
          animate: true,
        });
      });
      setMapReady(true);
    }).catch(() => {
      if (cancelled) return;
      setUnavailableReason("renderer");
      setStatus("unavailable");
    });
    return () => {
      cancelled = true;
      setMapReady(false);
      // Destroy the native map instance and drop the ref on teardown. Without
      // this, closing Your Map left the @capacitor/google-maps instance
      // (registered under MAP_ID) alive; re-opening then raced a fresh create()
      // against the stale instance and rendered a blank canvas the second time.
      //
      // This effect is the single owner of teardown -- it runs on unmount as
      // well as on re-run -- and the destroy goes through the lock so it can
      // never interleave with a create the next mount has already started.
      const staleMap = mapRef.current;
      mapRef.current = null;
      markerIdsRef.current = [];
      markerByMapIdRef.current.clear();
      if (staleMap) {
        void withNativeMapLock(MAP_ID, () => staleMap.destroy()).catch(
          () => undefined,
        );
      }
    };
    // rendererReady is read once, at creation time, only to decide the
    // starting center -- intentionally not a dependency. Consent flips this
    // value later without tearing the map instance down and rebuilding it;
    // the entry-location effect below re-centers the existing instance once
    // consent and a real position both land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.userId]);

  useEffect(() => {
    if (
      !rendererReady ||
      !mapReady ||
      !auth.userId ||
      entryLocationRequestedRef.current
    ) {
      return;
    }
    entryLocationRequestedRef.current = true;
    let cancelled = false;
    const cachedPoint = readLocationWorkspaceMemory(
      auth.userId,
    ).myLocationPoint;

    void (async () => {
      if (cachedPoint) {
        framedInitialMarkersRef.current = true;
        await focusSelfPoint(cachedPoint, { animate: false, select: false });
      }
      try {
        const point = await captureCurrentLocation();
        if (cancelled) return;
        framedInitialMarkersRef.current = true;
        await focusSelfPoint(point, { animate: true, select: false });
      } catch {
        // Entry focus is best-effort. The explicit Locate control remains
        // available for denied permissions, disabled services, or timeouts.
      } finally {
        if (!cancelled) setEntryLocationSettled(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    auth.userId,
    captureCurrentLocation,
    focusSelfPoint,
    mapReady,
    rendererReady,
  ]);

  /**
   * Accept a new focus only when something actually changed.
   *
   * The drawer republishes on every presence poll (every 15 s while checked
   * in). Storing each fresh object would retear and redraw the circle, the
   * connector and the pin on a timer, which reads as a flicker on the map.
   */
  const handlePlaceFocusChange = useCallback(
    (focus: NearbyCheckInPlaceFocus | null) => {
      setNearbyPlaceFocus((current) => {
        if (current === focus) return current;
        if (!current || !focus) return focus;
        const unchanged =
          current.placeId === focus.placeId &&
          current.label === focus.label &&
          current.latitude === focus.latitude &&
          current.longitude === focus.longitude &&
          current.distanceMeters === focus.distanceMeters &&
          current.active === focus.active;
        return unchanged ? current : focus;
      });
    },
    [],
  );

  /**
   * The check-in venue as its own pin.
   *
   * Shown while the drawer is open (the place being chosen) and for as long as
   * a check-in is live (the anchor). Kept separate from the "you" dot on
   * purpose: the whole point is that the owner can see the gap between where
   * they are standing and the place they are visible at.
   */
  const nearbyPlaceMarker = useMemo<RenderMarker | null>(() => {
    if (!nearbyPlaceFocus) return null;
    if (!nearbyCheckInOpen && !nearbyPlaceFocus.active) return null;
    return {
      key: `nearby-place:${nearbyPlaceFocus.placeId || "active"}`,
      kind: "place",
      label: nearbyPlaceFocus.label,
      point: {
        latitude: nearbyPlaceFocus.latitude,
        longitude: nearbyPlaceFocus.longitude,
        // A published venue location, not a reading from any receiver.
        capturedAt: new Date(0).toISOString(),
        sourcePlatform: "unknown",
      },
      tint: nearbyPlaceFocus.active
        ? { r: 16, g: 185, b: 129, a: 255 }
        : { r: 139, g: 92, b: 246, a: 255 },
    };
  }, [nearbyCheckInOpen, nearbyPlaceFocus]);

  const visibleMarkers = useMemo(() => {
    // Private-share pins are Your Map's answer to "where are the people who
    // share with me". Drawing them behind the check-in flow put that answer on
    // both screens and made the two read as one feature. Check-in shows only
    // the two points its own question needs: where you are, and the place you
    // are checking in to.
    const next = isCheckInSurface ? [] : [...markers];
    if (selfMarker) next.push(selfMarker);
    if (nearbyPlaceMarker) next.push(nearbyPlaceMarker);
    return next;
  }, [isCheckInSurface, markers, nearbyPlaceMarker, selfMarker]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let paddingTimer: number | null = null;
    let lastPaddingKey = "";
    // The people tray is a bottom-sheet overlay that animates its height when
    // expanded. Anchor the camera's bottom inset to the tray's stable bottom
    // edge plus its COLLAPSED footprint, never its live expanded height, so
    // toggling the tray open/closed never re-frames (zooms/pans) the map.
    const COLLAPSED_TRAY_HEIGHT = TRAY_COLLAPSED_HEIGHT_PX;
    const publishPadding = () => {
      const top = topControlsRef.current?.getBoundingClientRect().bottom ?? 72;
      const trayRect = peopleTrayRef.current?.getBoundingClientRect();
      const trayBottomInset = trayRect
        ? Math.max(0, window.innerHeight - trayRect.bottom)
        : 12;
      const desktopCheckInOpen =
        nearbyCheckInOpen && window.matchMedia("(min-width: 768px)").matches;
      const mobileCheckInOpen =
        nearbyCheckInOpen && window.matchMedia("(max-width: 767px)").matches;
      const checkInSheet = mobileCheckInOpen
        ? document.querySelector<HTMLElement>(
            "[data-one-location-nearby-check-in-sheet]",
          )
        : null;
      const mobileSheetInset = checkInSheet
        ? Math.max(0, window.innerHeight - checkInSheet.getBoundingClientRect().top)
        : 0;
      const padding = {
        top: Math.ceil(top + 12),
        right: desktopCheckInOpen ? 436 : 20,
        bottom: Math.ceil(
          Math.max(
            trayBottomInset + COLLAPSED_TRAY_HEIGHT + 12,
            mobileSheetInset + 12,
          ),
        ),
        left: 20,
      };
      const key = `${padding.top}:${padding.right}:${padding.bottom}:${padding.left}`;
      // Never re-hit the native bridge with identical padding: a redundant
      // setPadding can still nudge the camera on some SDK versions.
      if (key === lastPaddingKey) return;
      lastPaddingKey = key;
      void map.setPadding(padding);
    };
    const schedulePadding = () => {
      if (paddingTimer !== null) window.clearTimeout(paddingTimer);
      // ResizeObserver fires throughout the top-controls layout settle. Publish
      // only after geometry settles so the native bridge does not receive a call
      // on every animation frame.
      paddingTimer = window.setTimeout(publishPadding, 80);
    };
    publishPadding();
    // Observe only the top controls (a stable input). The people tray is left
    // out on purpose: its expand/collapse animation must not drive the camera.
    const observer = new ResizeObserver(schedulePadding);
    if (topControlsRef.current) observer.observe(topControlsRef.current);
    const checkInSheet = document.querySelector<HTMLElement>(
      "[data-one-location-nearby-check-in-sheet]",
    );
    if (nearbyCheckInOpen && checkInSheet) observer.observe(checkInSheet);
    window.addEventListener("resize", schedulePadding);
    return () => {
      if (paddingTimer !== null) window.clearTimeout(paddingTimer);
      observer.disconnect();
      window.removeEventListener("resize", schedulePadding);
    };
  }, [mapReady, nearbyCheckInOpen]);

  // The tray body's rendered box is height-clamped by its scroll container,
  // so its own size never reflects how tall its content actually is. Track
  // the header and the body's content directly instead, synchronously
  // before paint so there is no grow-in flash, and again whenever either
  // changes size (chips added/removed, search narrows the list, nearby
  // results arrive). The tray section itself only mounts once the renderer
  // is ready, so the dependencies below -- its exact mount condition --
  // make sure this attaches once the refs actually exist, not just once on
  // the component's own first render.
  useLayoutEffect(() => {
    const header = trayHeaderRef.current;
    const content = trayContentRef.current;
    if (!header || !content) return;
    const measure = () => {
      setTrayHeaderHeight(header.offsetHeight);
      setTrayContentHeight(content.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(content);
    return () => observer.disconnect();
  }, [rendererReady, status, isCheckInSurface]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const generation = ++nearbyCircleGenerationRef.current;
    const searchPoint = nearbyCheckInOpen ? nearbySearchPoint : null;
    const placeFocus =
      nearbyCheckInOpen || nearbyPlaceFocus?.active ? nearbyPlaceFocus : null;
    const placeCenter = placeFocus
      ? { lat: placeFocus.latitude, lng: placeFocus.longitude }
      : null;
    // Discovery is anchored on the *place* once a check-in is live -- that is
    // what the backend matches people against. While the owner is still
    // choosing, it is anchored on them, because that is what bounds the search.
    const circleCenter =
      placeFocus?.active && placeCenter
        ? placeCenter
        : searchPoint
          ? { lat: searchPoint.latitude, lng: searchPoint.longitude }
          : placeCenter;
    let addedIds: string[] = [];
    let addedLineIds: string[] = [];

    const enqueue = (command: () => Promise<void>): Promise<void> => {
      const next = nearbyCircleCommandRef.current
        .catch(() => undefined)
        .then(command);
      nearbyCircleCommandRef.current = next.catch(() => undefined);
      return next;
    };
    const removeSafely = async (ids: string[], lineIds: string[]) => {
      if (ids.length) await map.removeCircles(ids).catch(() => undefined);
      if (lineIds.length)
        await map.removePolylines(lineIds).catch(() => undefined);
    };

    void enqueue(async () => {
      const previousIds = nearbyCircleIdsRef.current;
      const previousLineIds = nearbyConnectorIdsRef.current;
      nearbyCircleIdsRef.current = [];
      nearbyConnectorIdsRef.current = [];
      await removeSafely(previousIds, previousLineIds);
      if (generation !== nearbyCircleGenerationRef.current || !circleCenter) {
        return;
      }

      const active = Boolean(placeFocus?.active);
      const circle: Circle = {
        center: circleCenter,
        radius: NEARBY_CHECK_IN_RADIUS_METERS,
        fillColor: "var(--app-accent-surface)",
        fillOpacity: 0.1,
        strokeColor: "var(--app-accent)",
        strokeOpacity: 0.85,
        strokeWeight: 2,
        clickable: false,
        title: active
          ? "500 m check-in area around your place"
          : "500 m check-in search area",
      };
      addedIds = await map.addCircles([circle]);
      if (generation !== nearbyCircleGenerationRef.current) {
        await removeSafely(addedIds, []);
        addedIds = [];
        return;
      }
      nearbyCircleIdsRef.current = addedIds;

      // Draw the gap the owner is being asked to confirm. Below ~25 m the two
      // pins overlap and a line is just noise.
      const connectorWorthDrawing =
        searchPoint &&
        placeCenter &&
        (placeFocus?.distanceMeters ?? Number.POSITIVE_INFINITY) >= 25;
      if (connectorWorthDrawing && searchPoint && placeCenter) {
        addedLineIds = await map
          .addPolylines([
            {
              path: [
                { lat: searchPoint.latitude, lng: searchPoint.longitude },
                placeCenter,
              ],
              strokeColor: "var(--app-accent)",
              strokeOpacity: 0.65,
              strokeWeight: 3,
              geodesic: true,
              clickable: false,
            },
          ])
          .catch(() => [] as string[]);
        if (generation !== nearbyCircleGenerationRef.current) {
          await removeSafely([], addedLineIds);
          addedLineIds = [];
        } else {
          nearbyConnectorIdsRef.current = addedLineIds;
        }
      }

      // Frame both points when they differ, so the owner never has to hunt for
      // the pin that is off-screen.
      const bounds =
        searchPoint && placeCenter
          ? pairBounds(
              { lat: searchPoint.latitude, lng: searchPoint.longitude },
              placeCenter,
            )
          : radiusBounds(
              {
                latitude: circleCenter.lat,
                longitude: circleCenter.lng,
              },
              NEARBY_CHECK_IN_RADIUS_METERS,
            );
      await map.fitBounds(bounds, 48);
    }).catch(() => {
      // Place discovery remains usable from the drawer if an older renderer
      // cannot draw the visual boundary. Never convert this into map data.
    });

    return () => {
      if (nearbyCircleGenerationRef.current === generation) {
        nearbyCircleGenerationRef.current += 1;
      }
      void enqueue(async () => {
        const ownsCurrentIds =
          addedIds.length > 0 &&
          addedIds.every((id) => nearbyCircleIdsRef.current.includes(id));
        if (ownsCurrentIds) nearbyCircleIdsRef.current = [];
        const ownsCurrentLineIds =
          addedLineIds.length > 0 &&
          addedLineIds.every((id) =>
            nearbyConnectorIdsRef.current.includes(id),
          );
        if (ownsCurrentLineIds) nearbyConnectorIdsRef.current = [];
        await removeSafely(addedIds, addedLineIds);
        addedIds = [];
        addedLineIds = [];
      }).catch(() => undefined);
    };
  }, [mapReady, nearbyCheckInOpen, nearbyPlaceFocus, nearbySearchPoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    // Marker writes must be serialized. Two overlapping runs could each remove
    // the ids they captured on entry and then add their own, so a batch added
    // by the slower run stayed on the map with nothing tracking its ids --
    // ghost pins that no later pass could remove. That showed up as a second
    // "Your location" sitting where the device used to be. The check-in place
    // pin made it routine: `visibleMarkers` now also changes on every place
    // selection and presence poll, not just on a position update.
    const generation = ++markerGenerationRef.current;
    let cancelled = false;
    const enqueue = (command: () => Promise<void>): Promise<void> => {
      const next = markerCommandRef.current.catch(() => undefined).then(command);
      markerCommandRef.current = next.catch(() => undefined);
      return next;
    };
    void enqueue(async () => {
      if (markerIdsRef.current.length) {
        const stale = markerIdsRef.current;
        markerIdsRef.current = [];
        await map.removeMarkers(stale).catch(() => undefined);
      }
      if (generation !== markerGenerationRef.current) return;
      const mapMarkers: Marker[] = visibleMarkers.map((marker) => {
        // Labels stay in the local HTML tray/search index. The native Google
        // renderer receives coordinates and a generic accessibility title,
        // never the private recipient name.
        const title =
          marker.kind === "self"
            ? "Your location"
            : marker.kind === "place"
              ? // A public venue the owner picked, so its name may reach the
                // renderer -- unlike a private recipient's label.
                marker.label
              : "Private location";
        return {
          coordinate: {
            lat: marker.point.latitude,
            lng: marker.point.longitude,
          },
          // `title` is only safe to send on native, where it fills the info
          // window that opens on tap. The web renderer feeds it to the pin's
          // *glyph* instead -- a slot meant for one character -- so any real
          // title is painted across the map beside the pin. A place name plus
          // its full postal address made a banner of it. Web keeps the plain
          // coloured pin; the drawer already names both points in HTML.
          ...(isNative()
            ? {
                title,
                snippet:
                  marker.kind === "self"
                    ? "Your current location"
                    : marker.kind === "place"
                      ? "Your check-in place"
                      : "Sharing privately now",
              }
            : {}),
          // Grey once the position is older than live. tintColor is the only
          // per-pin styling this bridge exposes -- `title` cannot carry it,
          // because the web renderer paints titles across the map as a glyph
          // (see above) -- so the colour is where staleness has to be said.
          tintColor: isStaleAt(marker.capturedAt, freshnessSeconds, staleClockMs)
            ? STALE_TINT
            : marker.tint,
          zIndex:
            marker.kind === "self" ? 10 : marker.kind === "place" ? 9 : 1,
        };
      });
      const ids = mapMarkers.length ? await map.addMarkers(mapMarkers) : [];
      // A superseded run must take its own markers back off the map. Returning
      // early here is what stranded them.
      if (generation !== markerGenerationRef.current || cancelled) {
        if (ids.length) await map.removeMarkers(ids).catch(() => undefined);
        return;
      }
      markerIdsRef.current = ids;
      markerByMapIdRef.current = new Map(
        ids.flatMap((id, index) => {
          const marker = visibleMarkers[index];
          return marker ? [[id, marker] as const] : [];
        }),
      );
      if (visibleMarkers.length > 8) {
        await map.enableClustering(4);
      } else {
        await map.disableClustering();
      }
      if (
        entryLocationSettled &&
        !framedInitialMarkersRef.current &&
        visibleMarkers.length > 0
      ) {
        framedInitialMarkersRef.current = true;
        await frameMarkers(map, visibleMarkers);
      }
    }).catch(() => {
      if (!cancelled) setStatus("error");
    });
    return () => {
      cancelled = true;
    };
    // staleClockMs and freshnessSeconds are dependencies because a pin has to
    // change colour while nothing else changes at all. Without them the tint
    // is decided once, when the marker is drawn, and a person who went quiet
    // keeps a live-coloured pin until some unrelated refresh happens to redraw
    // it.
  }, [
    entryLocationSettled,
    mapReady,
    visibleMarkers,
    freshnessSeconds,
    staleClockMs,
  ]);

  const acceptRenderer = useCallback(async () => {
    if (!vaultOwnerToken) return;
    try {
      const next = await OneLocationService.updateMapPreferences({
        vaultOwnerToken,
        rendererConsentVersion: GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
      });
      setPreferences(next);
      setAcceptedRenderer(true);
      writeCachedRendererConsentAccepted(auth.userId, true);
    } catch {
      toast.error("Your Map could not be prepared.");
    }
  }, [auth.userId, vaultOwnerToken]);

  const setPresence = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("presence");
    try {
      const nextMode =
        preferences.presenceMode === "ghost" ? "foreground_private" : "ghost";
      if (demoMode) {
        setPreferences((current) => ({
          ...current,
          presenceMode: nextMode,
        }));
        toast.success(
          nextMode === "ghost"
            ? "Demo Ghost Mode is on."
            : "Demo visibility is on.",
        );
        return;
      }
      const next = await OneLocationService.updateMapPreferences({
        vaultOwnerToken,
        presenceMode: nextMode,
      });
      setPreferences(next);
      toast.success(
        nextMode === "ghost"
          ? "Ghost Mode is on. Nobody sees you on their map."
          // "Tap Locate me to appear" was true while the locate button was the
          // only thing that ever published a map-visible position. Sharing does
          // it now, so telling somebody to go and tap something else would send
          // them looking for a step that no longer exists.
          : "You will appear on the map of anyone you share with.",
      );
    } catch {
      toast.error("Map visibility could not be updated.");
    } finally {
      setBusy(null);
    }
  }, [demoMode, preferences.presenceMode, vaultOwnerToken]);

  const focusMarker = useCallback(async (marker: RenderMarker) => {
    setSelected(marker);
    setSearchQuery("");
    setTrayExpanded(false);
    await mapRef.current?.setCamera({
      coordinate: {
        lat: marker.point.latitude,
        lng: marker.point.longitude,
      },
      zoom: 15,
      animate: true,
    });
  }, []);

  const locateMe = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("locate");
    try {
      const point = await captureCurrentLocation();
      await focusSelfPoint(point, { animate: true, select: true });
      if (demoMode) {
        toast.success("Centered on your device location.");
        return;
      }
      if (preferences.presenceMode !== "foreground_private") {
        toast.message(
          "Ghost Mode is on. Only you can see this.",
        );
        return;
      }
      const state = await OneLocationService.getState(vaultOwnerToken);
      const recipientsByKey = new Map(
        state.recipients.map((recipient) => [
          `${recipient.userId}:${recipient.keyId}`,
          recipient,
        ]),
      );
      const grants = state.ownerGrants.filter(
        (grant) => grant.status === "active" && !!grant.id,
      );
      // Keep the on-map "Sharing with N" status in sync off this same fetch.
      if (mountedRef.current) {
        setActiveShareCount(
          state.ownerGrants.filter((grant) => grant.status === "active").length,
        );
      }
      await Promise.all(
        grants.map(async (grant) => {
          const recipient = recipientsByKey.get(
            `${grant.recipientUserId}:${grant.recipientKeyId}`,
          );
          if (!recipient?.publicKeyJwk || !recipient.keyId) return;
          const envelope = await encryptLocationForRecipient({
            point,
            recipientPublicKeyJwk: recipient.publicKeyJwk,
            recipientKeyId: recipient.keyId,
          });
          envelope.publicationContext = "foreground_map_visible";
          await OneLocationService.storeEnvelope({
            vaultOwnerToken,
            grantId: grant.id,
            envelope,
          });
        }),
      );
      toast.success(
        "Your active private recipients can see this foreground update.",
      );
    } catch {
      toast.error("We could not update your location.");
    } finally {
      setBusy(null);
    }
  }, [
    captureCurrentLocation,
    demoMode,
    focusSelfPoint,
    preferences.presenceMode,
    vaultOwnerToken,
  ]);

  const filteredPeople = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return markers;
    return markers.filter((marker) =>
      marker.label.toLocaleLowerCase().includes(query),
    );
  }, [markers, searchQuery]);

  const nearbyAttendees = useMemo(
    () => (nearbyPresenceState.presence ? nearbyPresenceState.attendees : []),
    [nearbyPresenceState],
  );

  const filteredNearbyAttendees = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return nearbyAttendees;
    return nearbyAttendees.filter((attendee) =>
      attendee.displayName.toLocaleLowerCase().includes(query),
    );
  }, [nearbyAttendees, searchQuery]);

  const drawerEntryCount = markers.length + nearbyAttendees.length;

  // One number, one word for what it counts. The screen is already the map and
  // the tray is already the people, so "live locations on your map" spent five
  // words restating both. Everything the row used to explain in a subtitle now
  // either shows here or is not worth a line.
  const peopleDrawerLabel = useMemo(() => {
    if (nearbyPresenceState.presence) {
      if (nearbyAttendees.length > 0 && markers.length > 0) {
        return `${nearbyAttendees.length} nearby · ${markers.length} sharing`;
      }
      if (nearbyAttendees.length > 0) {
        return `${nearbyAttendees.length} nearby`;
      }
      if (markers.length > 0) {
        return `${markers.length} sharing · none nearby`;
      }
      return "No one nearby";
    }
    return markers.length > 0
      ? `${markers.length} on your map`
      : "No one sharing yet";
  }, [markers.length, nearbyAttendees.length, nearbyPresenceState.presence]);

  // Only when it adds something the title cannot. Restating the title in
  // smaller grey type is the noise this tray had most of.
  const peopleDrawerSubtitle = nearbyPresenceState.presence
    ? `Within ${nearbyPresenceState.presence.radiusMeters} m · exact spots stay private`
    : (activeShareCount ?? 0) > 0
      ? `Sharing with ${activeShareCount}`
      : null;

  const connectNearbyAttendee = useCallback(
    async (attendee: OneLocationNearbyAttendee) => {
      const ownerSnapshot = nearbyConnectOwnerRef.current;
      const presenceCheckedInAt =
        nearbyPresenceStateRef.current.presence?.checkedInAt;
      if (
        !ownerSnapshot.userId ||
        !ownerSnapshot.vaultOwnerToken ||
        !presenceCheckedInAt ||
        !attendee.canConnect ||
        nearbyConnectInFlightRef.current
      ) {
        return;
      }

      const generation = ++nearbyConnectGenerationRef.current;
      nearbyConnectInFlightRef.current = true;
      setNearbyConnectionBusyAlias(attendee.participantAlias);
      const requestIsCurrent = () => {
        const currentOwner = nearbyConnectOwnerRef.current;
        const currentPresence = nearbyPresenceStateRef.current;
        return (
          mountedRef.current &&
          nearbyConnectGenerationRef.current === generation &&
          currentOwner.userId === ownerSnapshot.userId &&
          currentOwner.vaultOwnerToken === ownerSnapshot.vaultOwnerToken &&
          currentPresence.presence?.checkedInAt === presenceCheckedInAt &&
          currentPresence.attendees.some(
            (item) => item.participantAlias === attendee.participantAlias,
          )
        );
      };
      try {
        const result = await OneLocationService.requestNearbyConnection({
          vaultOwnerToken: ownerSnapshot.vaultOwnerToken,
          participantAlias: attendee.participantAlias,
        });
        if (!requestIsCurrent()) return;
        setNearbyPresenceState((current) => ({
          ...current,
          attendees: current.attendees.map((item) =>
            item.participantAlias === attendee.participantAlias
              ? {
                  ...item,
                  relationship: result.relationship,
                  canConnect:
                    result.relationship === "none" ? item.canConnect : false,
                }
              : item,
          ),
        }));
        toast.success("Connection request sent.");
      } catch {
        if (requestIsCurrent()) {
          toast.error(
            "That person may no longer be nearby. Open Check in and refresh the list.",
          );
        }
      } finally {
        if (nearbyConnectGenerationRef.current === generation) {
          nearbyConnectInFlightRef.current = false;
          if (mountedRef.current) setNearbyConnectionBusyAlias(null);
        }
      }
    },
    [],
  );

  const closeMap = useCallback(() => {
    if (closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    setClosing(true);
    // Tear the native map down immediately. The @capacitor/google-maps view
    // renders BELOW the WebView; if it lingers it can swallow the very taps that
    // should dismiss the overlay (the on-device "X does nothing" report), and it
    // must never cover the next screen. Destroying it up front frees the touch
    // surface before we navigate.
    //
    // Through the lock, and dropping the ref first, so that closing and
    // immediately re-opening the map cannot land this destroy on top of the
    // next entry's create.
    const closingMap = mapRef.current;
    mapRef.current = null;
    if (closingMap) {
      void withNativeMapLock(MAP_ID, async () => {
        await closingMap.disableTouch().catch(() => undefined);
        await closingMap.destroy().catch(() => undefined);
      });
    }
    beginRouteTransition(
      ROUTES.ONE_LOCATION,
      () => router.replace(ROUTES.ONE_LOCATION, { scroll: false }),
      "tap",
      "full",
    );
    // Guaranteed exit: if the SPA route transition is interrupted (observed on
    // native, where the map layer/transition could leave the close affordance
    // inert), force a hard navigation to the Location dashboard so the user is
    // never trapped in the full-screen map.
    //
    // The escape hatch is armed against the route we are leaving, whichever it
    // is. Hard-coding Your Map's path silently disarmed it on check-in's own
    // route -- the one screen where the X is now the primary way out, because
    // dismissing the sheet deliberately leaves you standing here.
    const exitingFrom = window.location.pathname;
    window.setTimeout(() => {
      if (window.location.pathname !== exitingFrom) return;
      window.location.assign(ROUTES.ONE_LOCATION);
    }, 1_200);
  }, [router]);

  useEffect(() => {
    if (!isNative() || getPlatform() !== "android") return;
    let listener: { remove: () => Promise<void> } | undefined;
    void CapacitorApp.addListener("backButton", () => {
      if (nearbyCheckInOpen) {
        closeNearbyCheckIn();
        return;
      }
      closeMap();
    }).then((handle) => {
      listener = handle;
    });
    return () => {
      void listener?.remove();
    };
  }, [closeMap, closeNearbyCheckIn, nearbyCheckInOpen]);

  const toggleDemoPeople = useCallback(() => {
    if (!demoAvailable) return;
    const nextEnabled = !demoMode;
    markerSignatureRef.current = "";
    framedInitialMarkersRef.current = false;
    setDemoMode(nextEnabled);
    setTrayExpanded(true);
    toast.message(
      nextEnabled
        ? "Showing fictional people. Locate Me still uses this device."
        : "Fictional people hidden.",
    );
  }, [demoAvailable, demoMode]);

  const showEveryone = useCallback(async () => {
    const map = mapRef.current;
    if (!map || visibleMarkers.length === 0) return;
    setSelected(null);
    setSearchQuery("");
    setTrayExpanded(false);
    await frameMarkers(map, visibleMarkers);
  }, [visibleMarkers]);

  // Built once and placed into exactly one of two header slots below
  // (mobile's center column, or desktop's trailing group with Locate) --
  // never both, so it only ever mounts once.
  const checkInPill = (
    <ShellActionSurface
      variant="pill"
      // ShellActionSurface's own wrapper is shrink-0 by default (a
      // fixed-size top-bar control never used to need to give way). On
      // desktop this shares a grid column with Locate and can be pushed by
      // Sharing sitting dead-center, so it needs to be the one that yields
      // -- wrapperClassName reaches the actual flex item; min-w-0 on the
      // trigger itself lets its own truncate span ellipsis instead of just
      // refusing to shrink.
      wrapperClassName="min-w-0 shrink"
      className={`pointer-events-auto min-w-0 border shadow-lg backdrop-blur-md ${
        nearbyPresenceState.presence
          ? MAP_ACCENT_ACTIVE_CLASSNAME
          : MAP_ACCENT_CONTROL_CLASSNAME
      }`}
      aria-label={
        nearbyPresenceState.presence
          ? `Nearby check-in active with ${nearbyPresenceState.attendees.length} people`
          : "Check in nearby"
      }
      data-testid="one-location-map-nearby-check-in"
      onClick={openNearbyCheckIn}
    >
      <UsersRound className="h-4 w-4 shrink-0" />
      <span className="truncate">
        {nearbyPresenceState.presence
          ? `Nearby ${nearbyPresenceState.attendees.length}`
          : "Check in"}
      </span>
    </ShellActionSurface>
  );

  return (
    <main
      className="one-location-map relative h-[100dvh] w-full overflow-hidden bg-muted"
      data-testid="one-location-map"
      data-map-ready={mapReady && status === "ready" ? "true" : "false"}
      data-map-marker-count={markers.length}
      data-map-demo={demoMode ? "true" : undefined}
      data-map-closing={closing ? "true" : undefined}
      data-ambient-chrome-ignore
    >
      <capacitor-google-map
        ref={(element: HTMLElement | null) => {
          mapElement.current = element;
        }}
        className={`absolute inset-0 block h-full w-full ${
          closing ? "pointer-events-none" : ""
        }`}
      />
      <header
        ref={topControlsRef}
        aria-label={
          isCheckInSurface ? "Check in map controls" : "Location map controls"
        }
        // z-30 (above the z-20 map loading/error overlay and people tray): at
        // equal z-index the later-in-DOM full-screen overlay painted on top of
        // the close X and could swallow the tap that dismisses the map. Keeping
        // the controls strictly above every map layer guarantees the back/X and
        // locate buttons stay tappable in every state (loading, error, tray open).
        //
        // A three-column grid, not a flex row: with flex + justify-between,
        // three-plus items of uneven width get spread by *equal gaps*, which
        // is what dragged Check-in and Sharing out of place in the first
        // place. `1fr auto 1fr` instead forces the two outer columns to the
        // same width regardless of what they contain, which puts the middle
        // (auto) column at the header's true visual center no matter how
        // wide the close X or the trailing group are.
        //
        // The center column's occupant depends on viewport: on desktop it's
        // Sharing, with Check-in grouped into the trailing edge alongside
        // Locate; below md, Check-in takes the center column instead (see
        // `isMobile` below) and Sharing steps aside, matching how little
        // room a phone-width header actually has for three live pills.
        className="pointer-events-none absolute inset-x-0 top-0 z-30 grid grid-cols-[1fr_auto_1fr] items-center gap-3 p-4 pt-[max(1rem,env(safe-area-inset-top))]"
      >
        <div className="flex min-w-0 items-center">
          <ShellActionSurface
            className={`pointer-events-auto !h-14 !w-14 touch-manipulation border shadow-lg backdrop-blur-md ${MAP_ACCENT_CONTROL_CLASSNAME}`}
            aria-label="Back to Location"
            data-testid="one-location-map-close"
            disabled={closing}
            onClick={closeMap}
            onPointerUp={(event) => {
              if (event.pointerType === "touch" || event.pointerType === "pen") {
                closeMap();
              }
            }}
          >
            <X className="h-5 w-5 stroke-[2.25]" />
          </ShellActionSurface>
        </div>
        <div className="flex min-w-0 items-center justify-center">
          {isMobile
            ? rendererReady && nearbyCheckInAvailable && !demoMode
              ? checkInPill
              : null
            : !demoMode && (activeShareCount ?? 0) > 0
              ? (
                <span
                  data-testid="one-location-map-sharing-status"
                  aria-label={`You are sharing your location with ${activeShareCount} ${
                    activeShareCount === 1 ? "person" : "people"
                  }`}
                  role="status"
                  aria-live="polite"
                  className="pointer-events-none flex min-w-0 shrink items-center gap-1.5 truncate rounded-full border border-[var(--app-accent-border)] bg-background/85 px-3 py-1.5 text-[12px] font-semibold text-[var(--app-accent-deep)] shadow-lg backdrop-blur-md dark:text-[var(--app-accent-bright)]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-accent)] motion-safe:animate-pulse"
                    aria-hidden="true"
                  />
                  <span className="truncate">Sharing with {activeShareCount}</span>
                </span>
              )
              : null}
        </div>
        {rendererReady ? (
          <div className="flex min-w-0 items-center justify-end gap-3">
            {!isMobile && rendererReady && nearbyCheckInAvailable && !demoMode
              ? checkInPill
              : null}
            {rendererReady ? (
              <ShellActionSurface
                className={`pointer-events-auto !h-14 !w-14 touch-manipulation border shadow-lg backdrop-blur-md ${MAP_ACCENT_CONTROL_CLASSNAME}`}
                aria-label={
                  busy === "locate" ? "Finding your location" : "Show my location"
                }
                aria-busy={busy === "locate"}
                data-testid="one-location-map-locate"
                disabled={busy === "locate"}
                onClick={() => void locateMe()}
              >
                {busy === "locate" ? (
                  <Loader2
                    className="h-5 w-5 animate-spin stroke-[2.25]"
                    aria-hidden="true"
                  />
                ) : (
                  <LocateFixed className="h-5 w-5 stroke-[2.25]" />
                )}
              </ShellActionSurface>
            ) : null}
          </div>
        ) : null}
      </header>
      {/*
        Two pins on one map need naming, or the owner cannot tell which is
        "me" and which is "the place I'm checking in to" -- and those are
        routinely a street apart.
      */}
      {rendererReady &&
      (nearbyCheckInOpen || nearbyPlaceFocus?.active) &&
      (nearbySearchPoint || nearbyPlaceFocus) ? (
        <div
          className="pointer-events-none absolute left-4 right-4 z-20 flex max-w-[18rem] flex-col gap-1.5 rounded-2xl border border-[var(--app-accent-border)] bg-background/90 px-3 py-2 text-xs font-semibold shadow-lg backdrop-blur-md md:right-auto"
          style={{
            top: "calc(max(1rem, env(safe-area-inset-top)) + 4.5rem)",
          }}
          data-testid="one-location-nearby-search-area-legend"
        >
          {nearbySearchPoint ? (
            <span className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full bg-[rgb(0,122,255)]"
                aria-hidden="true"
              />
              <span className="truncate text-foreground">You are here</span>
            </span>
          ) : null}
          {nearbyPlaceFocus ? (
            <span
              className="flex items-center gap-2"
              data-testid="one-location-nearby-place-legend"
            >
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                  nearbyPlaceFocus.active
                    ? "bg-emerald-500"
                    : "bg-violet-500"
                }`}
                aria-hidden="true"
              />
              <span className="truncate text-foreground">
                {nearbyPlaceFocus.active ? "Checked in at " : "Checking in at "}
                {nearbyPlaceFocus.label}
              </span>
            </span>
          ) : null}
          {nearbyPlaceFocus?.distanceMeters != null &&
          nearbyPlaceFocus.distanceMeters >= 25 ? (
            <span className="pl-[1.125rem] font-normal text-muted-foreground">
              {nearbyPlaceFocus.distanceMeters < 1_000
                ? `${nearbyPlaceFocus.distanceMeters} m`
                : `${(nearbyPlaceFocus.distanceMeters / 1_000).toFixed(1)} km`}{" "}
              from you
            </span>
          ) : null}
          <span className="pl-[1.125rem] font-normal text-muted-foreground">
            500 m {nearbyPlaceFocus?.active ? "match" : "search"} area
          </span>
        </div>
      ) : null}
      {status !== "unavailable" && !mapReady ? (
        // The map now starts initializing as soon as this screen opens --
        // before consent it's a neutral world view with zero markers, no
        // different in privacy terms from Preview-with-fictional-people,
        // which already loads this same renderer with no consent gate at
        // all. What consent actually governs is this owner's own coordinate
        // and private recipient markers, applied later by the entry-location
        // and marker effects below, never by this one. Until GoogleMap.create()
        // resolves (a real async wait either way) this covers the native
        // view, which is composited under the WebView and stays fully
        // transparent until then -- without this the whole surface reads as
        // a blank flash of the app's native background.
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#eef2f7] px-6 text-center dark:bg-[#10151d]"
          data-testid="one-location-map-loading"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.5] [background-image:linear-gradient(to_right,color-mix(in_srgb,var(--foreground)_8%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--foreground)_8%,transparent)_1px,transparent_1px)] [background-size:32px_32px]"
          />
          <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-background text-[color:var(--app-accent,#087ff5)] shadow-lg">
            <Loader2 className="h-7 w-7 animate-spin" strokeWidth={2} aria-hidden />
          </span>
          <p className="relative text-sm font-medium text-muted-foreground">
            Loading your map…
          </p>
        </div>
      ) : null}
      {!rendererReady ? (
        <section
          className="absolute inset-x-0 z-20 rounded-none border border-border/60 bg-background/95 p-5 shadow-2xl backdrop-blur md:left-1/2 md:right-auto md:w-[min(52rem,calc(100%-4rem))] md:-translate-x-1/2 md:rounded-3xl"
          data-testid="one-location-map-disclosure"
          style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <MapPin className="h-6 w-6 text-[var(--app-accent-deep)] dark:text-[var(--app-accent-bright)]" />
          <h1 className="mt-3 text-xl font-semibold">Your Map</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Private shares open only on this device. Google Maps uses the
            minimum location needed to show them. Nearby Check-In is separate
            and starts only when you choose it.
          </p>
          <Button
            className={`mt-4 w-full ${MAP_ACCENT_ACTIVE_CLASSNAME}`}
            onClick={() => void acceptRenderer()}
          >
            Continue to Your Map
          </Button>
          {demoAvailable ? (
            <Button
              className="mt-2 w-full"
              variant="secondary"
              data-testid="one-location-map-demo-preview"
              onClick={toggleDemoPeople}
            >
              <UsersRound className="h-4 w-4" />
              Preview with fictional people
            </Button>
          ) : null}
        </section>
      ) : null}
      {rendererReady && status === "unavailable" ? (
        // Full-bleed styled fallback. Previously only a small bottom card sat
        // over the (blank) native canvas, so most of Your Map read as a blank
        // white screen when the Maps key was missing. Cover the whole surface
        // with an intentional muted placeholder (subtle grid + pin) so it never
        // looks broken, and center the explanation.
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#eef2f7] px-6 text-center dark:bg-[#10151d]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.5] [background-image:linear-gradient(to_right,color-mix(in_srgb,var(--foreground)_8%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--foreground)_8%,transparent)_1px,transparent_1px)] [background-size:32px_32px]"
          />
          <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-background text-[color:var(--app-accent,#087ff5)] shadow-lg">
            <MapPin className="h-7 w-7" strokeWidth={2} aria-hidden />
          </span>
          <h1 className="relative font-semibold">
            {unavailableReason === "maps-key"
              ? "This build has no Maps key"
              : "The map could not start"}
          </h1>
          <p className="relative max-w-sm text-sm text-muted-foreground">
            {unavailableReason === "maps-key"
              ? "Maps is not configured for this build."
              : "Check your connection and try again."}
          </p>
        </div>
      ) : null}
      {rendererReady && status !== "unavailable" && !isCheckInSurface ? (
        <section
          ref={peopleTrayRef}
          className="absolute left-1/2 z-20 isolate flex min-h-0 flex-col overflow-hidden border border-[var(--app-accent-border)] bg-background/95 shadow-[0_18px_60px_color-mix(in_oklab,var(--app-accent)_18%,transparent)] backdrop-blur-xl motion-reduce:transition-none"
          data-testid="one-location-map-people-tray"
          data-state={trayExpanded ? "expanded" : "collapsed"}
          style={{
            bottom: "max(0.75rem, env(safe-area-inset-bottom))",
            transform: "translateX(-50%)",
            width: trayExpanded
              ? "min(34rem, calc(100vw - 1.5rem - env(safe-area-inset-left) - env(safe-area-inset-right)))"
              : "3.5rem",
            // Fit the sheet to its content (header + measured body), not the
            // viewport's full allowance -- that fixed allowance is what left
            // a slab of dead space below the last row of buttons whenever
            // the content was shorter than the available height. The
            // viewport calc and 29.5rem figure now only cap it: a short list
            // shrinks the sheet, a long one still stops short of the notch
            // and scrolls internally.
            height: trayExpanded
              ? `clamp(${TRAY_COLLAPSED_HEIGHT_PX}px, ${trayHeaderHeight + trayContentHeight + TRAY_BORDER_HEIGHT_PX}px, min(29.5rem, calc(100dvh - 6.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))))`
              : "3.5rem",
            borderRadius: trayExpanded ? "1.75rem" : "999px",
            transition: [
              `width ${motionDurations.xl}ms ${motionEasings.emphasized}`,
              `height ${motionDurations.xl}ms ${motionEasings.emphasized}`,
              `border-radius ${motionDurations.xl}ms ${motionEasings.emphasized}`,
              `box-shadow ${motionDurations.md}ms ${motionEasings.emphasized}`,
            ].join(", "),
            willChange: "width, height, border-radius",
          }}
        >
          <button
            ref={trayHeaderRef}
            type="button"
            className={`group relative flex w-full shrink-0 touch-manipulation items-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70 motion-reduce:transition-none ${
              trayExpanded
                ? "h-[4.5rem] px-3 pb-2 pt-2.5"
                : "h-14 justify-center p-0"
            }`}
            style={{
              transition: [
                `height ${motionDurations.xl}ms ${motionEasings.emphasized}`,
                `padding ${motionDurations.xl}ms ${motionEasings.emphasized}`,
              ].join(", "),
            }}
            aria-expanded={trayExpanded}
            aria-label={
              trayExpanded ? "Minimize map controls" : "Expand map controls"
            }
            data-testid="one-location-map-tray-toggle"
            onClick={() => setTrayExpanded((current) => !current)}
          >
            <span
              className={`absolute left-1/2 top-1.5 h-1 w-10 -translate-x-1/2 rounded-full bg-[var(--app-accent-border)] transition-[opacity,transform,background-color] duration-300 group-hover:bg-[var(--app-accent)] ${
                trayExpanded
                  ? "scale-x-100 opacity-100"
                  : "scale-x-75 opacity-0"
              }`}
            />
            <span
              className={`absolute inset-0 grid place-items-center transition-[opacity,transform] duration-300 ${
                trayExpanded
                  ? "pointer-events-none scale-75 opacity-0"
                  : "scale-100 opacity-100"
              }`}
              aria-hidden={trayExpanded}
            >
              <UsersRound className="h-6 w-6 stroke-[2.25] text-[var(--app-accent-deep)] dark:text-[var(--app-accent-bright)]" />
              {drawerEntryCount > 0 ? (
                <span className="absolute right-1.5 top-1.5 grid min-h-5 min-w-5 place-items-center rounded-full bg-[var(--app-accent)] px-1 text-[10px] font-semibold leading-none text-[var(--app-accent-fg)]">
                  {drawerEntryCount > 9 ? "9+" : drawerEntryCount}
                </span>
              ) : null}
            </span>
            <span
              className={`mt-2 flex min-w-0 flex-1 items-center gap-3 transition-[opacity,transform] duration-300 ${
                trayExpanded
                  ? "translate-y-0 opacity-100"
                  : "pointer-events-none translate-y-2 opacity-0"
              }`}
              aria-hidden={!trayExpanded}
            >
              <span className="flex shrink-0 -space-x-2" aria-hidden="true">
                {markers.slice(0, 3).map((person) => (
                  <span
                    key={person.key}
                    className="grid h-8 w-8 place-items-center rounded-full border-2 border-background text-[10px] font-semibold text-white"
                    style={{
                      backgroundColor: person.tint
                        ? `rgba(${person.tint.r}, ${person.tint.g}, ${person.tint.b}, ${person.tint.a / 255})`
                        : "var(--app-accent)",
                    }}
                  >
                    {personInitials(person.label)}
                  </span>
                ))}
                {nearbyAttendees
                  .slice(0, Math.max(0, 3 - markers.length))
                  .map((attendee) => (
                    <span
                      key={attendee.participantAlias}
                      className="grid h-8 w-8 place-items-center rounded-full border-2 border-background bg-[var(--app-accent)] text-[10px] font-semibold text-[var(--app-accent-fg)]"
                    >
                      {personInitials(attendee.displayName)}
                    </span>
                  ))}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">
                    {peopleDrawerLabel}
                  </span>
                  {demoMode ? (
                    <span className="rounded-full bg-[var(--app-accent-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--app-accent-deep)] dark:text-[var(--app-accent-bright)]">
                      Demo
                    </span>
                  ) : null}
                </span>
                {peopleDrawerSubtitle ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {peopleDrawerSubtitle}
                  </span>
                ) : null}
              </span>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--app-accent-surface)] text-[var(--app-accent-deep)] transition-colors group-hover:bg-[var(--app-accent-surface-strong)] dark:text-[var(--app-accent-bright)]">
                <ChevronDown className="h-4 w-4" />
              </span>
            </span>
          </button>

          <div
            className={`min-h-0 flex-1 motion-reduce:transition-none ${
              trayExpanded
                ? "translate-y-0 opacity-100"
                : "pointer-events-none translate-y-2 opacity-0"
            }`}
            data-testid="one-location-map-tray-body"
            style={{
              transition: [
                `opacity ${motionDurations.sm}ms ${motionEasings.emphasized}`,
                `transform ${motionDurations.md}ms ${motionEasings.emphasized}`,
              ].join(", "),
            }}
            aria-hidden={!trayExpanded}
            inert={!trayExpanded}
          >
            <div
              className="h-full min-h-0 overflow-y-auto overscroll-contain"
              data-testid="one-location-map-tray-scroll"
            >
              {/* Unconstrained by the scroll container's fixed height above,
                  so its offsetHeight is the content's true natural size,
                  padding included since that padding lives here now. */}
              <div ref={trayContentRef} className="px-3 pb-3 pt-1">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <span className="sr-only">Find a person on Your Map</span>
                <Input
                  className="h-11 rounded-full border-border/60 bg-muted/80 pl-9 pr-4"
                  data-testid="one-location-map-search"
                  inputMode="search"
                  placeholder="Search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </label>

              {nearbyPresenceState.presence ? (
                <section
                  className="mt-2"
                  data-testid="one-location-map-nearby-people"
                  aria-label="People checked in nearby"
                >
                  {filteredNearbyAttendees.length > 0 ? (
                    <div className="space-y-1">
                      {filteredNearbyAttendees.map((attendee) => {
                        const connectionBusy =
                          nearbyConnectionBusyAlias ===
                          attendee.participantAlias;
                        return (
                          <div
                            key={attendee.participantAlias}
                            className="flex min-h-11 items-center gap-1 rounded-xl px-1.5 transition-colors hover:bg-muted/70 focus-within:ring-2 focus-within:ring-accent/70"
                            data-testid="one-location-map-nearby-person"
                          >
                            <button
                              type="button"
                              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
                              aria-label={`Open nearby actions for ${attendee.displayName}`}
                              onClick={openNearbyCheckIn}
                            >
                              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--app-accent)] text-[11px] font-semibold text-[var(--app-accent-fg)]">
                                {personInitials(attendee.displayName)}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">
                                  {attendee.displayName}
                                </span>
                                <span className="block truncate text-xs text-muted-foreground">
                                  {nearbyRelationshipLabel(attendee)}
                                </span>
                              </span>
                            </button>
                            {attendee.canConnect &&
                            attendee.relationship === "none" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                className="h-8 shrink-0 rounded-full px-3"
                                aria-label={`Connect with ${attendee.displayName}`}
                                disabled={nearbyConnectionBusyAlias !== null}
                                onClick={() =>
                                  void connectNearbyAttendee(attendee)
                                }
                              >
                                {connectionBusy ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  "Connect"
                                )}
                              </Button>
                            ) : attendee.relationship === "pending_outgoing" ? (
                              <span className="shrink-0 px-2 text-xs font-medium text-muted-foreground">
                                Requested
                              </span>
                            ) : attendee.relationship === "pending_incoming" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                className="h-8 shrink-0 rounded-full px-3"
                                aria-label={`Respond to ${attendee.displayName}`}
                                onClick={openNearbyCheckIn}
                              >
                                Respond
                              </Button>
                            ) : (
                              <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="px-1 py-2 text-sm text-muted-foreground">
                      {nearbyAttendees.length > 0
                        ? "No matches."
                        : "No one else here yet."}
                    </p>
                  )}
                </section>
              ) : null}

              {/* The heading, the count badge and the two-sentence pin rule
                  all used to sit here, and all three said what the row above
                  already says: how many people are on this map. What survives
                  is the list itself, plus the pin rule in the one state where
                  it answers a real question -- "why is this list empty when
                  people are checked in nearby?" -- phrased once, in a line. */}
              <section className="mt-3" aria-label="Live locations shared with you">
                <div
                  className="mt-2 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  data-testid="one-location-map-people"
                >
                  {filteredPeople.map((person) => {
                    const selectedPerson = selected?.key === person.key;
                    // The tray is where identity lives, because it is the only
                    // part of this screen that is real DOM. Map pins come from
                    // the Capacitor bridge, which offers a tint and nothing
                    // else -- no avatar, no badge, and no hover at all on a
                    // touch device.
                    const personStale = isStaleAt(
                      person.capturedAt,
                      freshnessSeconds,
                      staleClockMs,
                    );
                    const lastSeen = personStale
                      ? lastSeenLabel(person.capturedAt, staleClockMs)
                      : null;
                    return (
                      <button
                        key={person.key}
                        type="button"
                        className={`flex h-11 shrink-0 items-center gap-2 rounded-full border px-2.5 pr-3 text-left text-sm transition-colors ${
                          selectedPerson
                            ? MAP_ACCENT_ACTIVE_CLASSNAME
                            : "border-border/60 bg-muted/70 text-foreground hover:bg-muted"
                        }`}
                        // The live case keeps its original name exactly. Only a
                        // person who has gone quiet has anything extra worth
                        // announcing, and saying "sharing live" on every other
                        // row would be noise in a screen reader.
                        aria-label={
                          lastSeen
                            ? `Show ${person.label} on the map. Last seen ${lastSeen}.`
                            : `Show ${person.label} on the map`
                        }
                        title={
                          lastSeen
                            ? `${person.label} — last seen ${lastSeen}`
                            : `${person.label} — live now`
                        }
                        data-testid="one-location-map-person"
                        data-stale={personStale ? "true" : "false"}
                        onClick={() => void focusMarker(person)}
                      >
                        <span className="relative shrink-0">
                          <span
                            className={`grid h-7 w-7 place-items-center rounded-full text-[11px] font-semibold text-white transition-[filter,opacity] ${
                              personStale ? "opacity-70 grayscale" : ""
                            }`}
                            style={{
                              backgroundColor: person.tint
                                ? `rgba(${person.tint.r}, ${person.tint.g}, ${person.tint.b}, ${person.tint.a / 255})`
                                : "var(--app-accent)",
                            }}
                          >
                            {personInitials(person.label)}
                          </span>
                          {/* Bottom-right, over the avatar's own edge. Shape as
                              well as colour, so it survives being read on a
                              greyscale avatar by someone who cannot rely on
                              the grey itself. */}
                          {personStale ? (
                            <span
                              className="absolute -bottom-0.5 -right-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-background ring-1 ring-border"
                              aria-hidden="true"
                            >
                              <WifiOff className="h-2.5 w-2.5 text-muted-foreground" />
                            </span>
                          ) : null}
                        </span>
                        <span className="flex min-w-0 flex-col leading-tight">
                          <span className="max-w-28 truncate font-medium">
                            {person.label}
                          </span>
                          {lastSeen ? (
                            <span className="max-w-28 truncate text-[11px] text-muted-foreground">
                              {lastSeen}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                  {filteredPeople.length === 0 ? (
                    <p className="py-2 pl-1 text-sm text-muted-foreground">
                      {markers.length > 0
                        ? "No matches."
                        : // The header already says no one is sharing. This
                          // line spends itself on the part the header cannot:
                          // what it takes to appear here.
                          "Pins appear once they share and allow maps."}
                    </p>
                  ) : null}
                </div>
              </section>

              {selected ? (
                <div
                  className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-2xl bg-muted/80 px-3"
                  data-testid="one-location-map-selection"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {selected.label}
                    </p>
                    {/* The self marker is already labelled "You"; captioning it
                        "Your current location" was the same fact twice. */}
                    {selected.kind === "self" ? null : (
                      <p className="text-xs text-muted-foreground">
                        Sharing now
                      </p>
                    )}
                  </div>
                </div>
              ) : null}

              <div
                className={`mt-3 grid gap-2 ${
                  demoAvailable ? "grid-cols-3" : "grid-cols-2"
                }`}
              >
                {demoAvailable ? (
                  <Button
                    className={`h-11 min-w-0 rounded-2xl px-2 ${
                      demoMode ? MAP_ACCENT_ACTIVE_CLASSNAME : ""
                    }`}
                    variant="secondary"
                    aria-pressed={demoMode}
                    data-testid="one-location-map-demo-toggle"
                    onClick={toggleDemoPeople}
                  >
                    <UsersRound className="h-4 w-4 shrink-0" />
                    {/* Pressed state is already carried by the accent fill and
                        aria-pressed; the label need not say it too. */}
                    <span className="truncate">Demo</span>
                  </Button>
                ) : null}
                <Button
                  className={`h-11 min-w-0 justify-between rounded-2xl px-2.5 ${
                    preferences.presenceMode === "foreground_private"
                      ? MAP_ACCENT_ACTIVE_CLASSNAME
                      : ""
                  }`}
                  variant="secondary"
                  aria-pressed={
                    preferences.presenceMode === "foreground_private"
                  }
                  disabled={busy === "presence"}
                  onClick={() => void setPresence()}
                >
                  <span className="truncate">
                    {preferences.presenceMode === "ghost" ? "Ghost" : "Visible"}
                  </span>
                  {preferences.presenceMode === "ghost" ? (
                    <EyeOff className="h-4 w-4 shrink-0" />
                  ) : (
                    <Eye className="h-4 w-4 shrink-0" />
                  )}
                </Button>
                <Button
                  className="h-11 min-w-0 rounded-2xl px-2"
                  variant="secondary"
                  disabled={visibleMarkers.length === 0}
                  onClick={() => void showEveryone()}
                >
                  Everyone
                </Button>
              </div>
              {status === "error" ? (
                <p className="mt-2 text-center text-xs text-destructive">
                  Some locations didn&apos;t refresh.
                </p>
              ) : null}
              </div>
            </div>
          </div>
        </section>
      ) : null}
      {rendererReady && nearbyCheckInAvailable && !demoMode ? (
        <NearbyCheckInSheet
          open={nearbyCheckInOpen}
          ownerId={auth.userId}
          vaultOwnerToken={vaultOwnerToken}
          captureCurrentPosition={captureAndRememberCurrentLocation}
          onOpenChange={(nextOpen) => {
            if (nextOpen) {
              openNearbyCheckIn();
              return;
            }
            closeNearbyCheckIn();
          }}
          onStateChange={handleNearbyStateChange}
          onSearchAreaChange={setNearbySearchPoint}
          onPlaceFocusChange={handlePlaceFocusChange}
        />
      ) : null}
    </main>
  );
}
