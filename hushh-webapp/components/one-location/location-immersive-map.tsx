"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  decryptLocationEnvelope,
  encryptLocationForRecipient,
} from "@/lib/one-location/encryption";
import {
  readLocationWorkspaceMemory,
  writeLocationWorkspaceMemory,
} from "@/lib/one-location/location-workspace-memory";
import { updateOneLocationControlState } from "@/lib/one-location/location-control-state";
import {
  DARK_MAP_STYLES,
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
import { GOOGLE_MAPS_RENDERER_CONSENT_VERSION } from "@/lib/one-location/map-renderer-consent";

const MAP_ID = "one-location-private-map";
const NEARBY_CHECK_IN_RADIUS_METERS = 500;
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
};

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
export function LocationImmersiveMap() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const auth = useRequireAuth();
  const { vaultOwnerToken } = useVault();
  const demoAvailable = isLocationMapDemoAvailable();
  const nearbyCheckInAvailable = isOneLocationNearbyCheckInAvailable();
  const initialDemoMode = isLocationMapDemoEnabled(searchParams.get("demo"));
  const mapElement = useRef<HTMLElement | null>(null);
  const mapRef = useRef<GoogleMap | null>(null);
  const topControlsRef = useRef<HTMLDivElement | null>(null);
  const peopleTrayRef = useRef<HTMLElement | null>(null);
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
  const markerSignatureRef = useRef("");
  const initialDemoModeRef = useRef(initialDemoMode);
  const closeRequestedRef = useRef(false);
  const nearbyHistoryPreparedRef = useRef(false);
  const entryLocationRequestedRef = useRef(false);
  const locationCaptureRef = useRef<Promise<PlainLocationPoint> | null>(null);
  const nearbyConnectInFlightRef = useRef(false);
  const nearbyConnectGenerationRef = useRef(0);
  const nearbyConnectOwnerRef = useRef({
    userId: auth.userId,
    vaultOwnerToken,
  });
  const [demoMode, setDemoMode] = useState(initialDemoMode);
  const [acceptedRenderer, setAcceptedRenderer] = useState(false);
  const [preferences, setPreferences] = useState<OneLocationMapPreferences>({
    presenceMode: "ghost",
  });
  const [markers, setMarkers] = useState<RenderMarker[]>([]);
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
    const requested = action === "check-in";
    setNearbyCheckInOpen(requested);
    if (
      !requested ||
      nearbyHistoryPreparedRef.current ||
      typeof window === "undefined"
    ) {
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
  }, [nearbyCheckInAvailable, router, searchParams]);

  const openNearbyCheckIn = useCallback(() => {
    if (
      !nearbyCheckInAvailable ||
      !rendererReady ||
      demoMode ||
      searchParams.get("action") === "check-in"
    ) {
      return;
    }
    setTrayExpanded(false);
    nearbyHistoryPreparedRef.current = true;
    const params = new URLSearchParams(searchParams.toString());
    params.set("action", "check-in");
    router.push(`${ROUTES.ONE_LOCATION_MAP}?${params.toString()}`, {
      scroll: false,
    });
  }, [demoMode, nearbyCheckInAvailable, rendererReady, router, searchParams]);

  const closeNearbyCheckIn = useCallback(() => {
    setNearbyCheckInOpen(false);
    if (
      typeof window !== "undefined" &&
      new URL(window.location.href).searchParams.get("action") === "check-in"
    ) {
      window.history.back();
    }
  }, []);

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

  const captureCurrentLocation =
    useCallback((): Promise<PlainLocationPoint> => {
      if (locationCaptureRef.current) return locationCaptureRef.current;
      const request = OneLocationService.captureCurrentPosition();
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

  const captureAndRememberCurrentLocation = useCallback(async () => {
    const point = await captureCurrentLocation();
    if (auth.userId) {
      const workspace = readLocationWorkspaceMemory(auth.userId);
      writeLocationWorkspaceMemory(auth.userId, {
        ...workspace,
        myLocationPoint: point,
      });
    }
    return point;
  }, [auth.userId, captureCurrentLocation]);

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
    if (refreshInFlightRef.current) return;
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
    }
  }, [auth.userId, demoMode, rendererReady, vaultOwnerToken]);

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
      void mapRef.current?.destroy();
      mapRef.current = null;
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
    let cancelled = false;
    void OneLocationService.getMapState(vaultOwnerToken)
      .then((state) => {
        if (cancelled) return;
        setPreferences(state.preferences);
        setAcceptedRenderer(
          state.preferences.rendererConsentVersion ===
            GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
        );
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
      void appListener?.remove();
    };
  }, [demoMode, refresh, refreshShareCount, rendererReady, vaultOwnerToken]);

  useEffect(() => {
    if (!rendererReady || !mapElement.current) return;
    const apiKey = mapApiKey();
    if (!apiKey) {
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    if (isNative()) {
      document.documentElement.classList.add("one-location-map-native");
      document.body.classList.add("one-location-map-native");
    }
    const cachedPoint = readLocationWorkspaceMemory(
      auth.userId,
    ).myLocationPoint;
    void GoogleMap.create({
      id: MAP_ID,
      element: mapElement.current,
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
        // Open dark to match the mobile dark theme. Read the resolved theme from
        // the <html> `dark` class that next-themes sets, so no camera-recreating
        // hook dependency is introduced; a cloud-styled mapId can supersede this.
        styles:
          typeof document !== "undefined" &&
          document.documentElement.classList.contains("dark")
            ? DARK_MAP_STYLES
            : undefined,
      },
    })
      .then(async (map) => {
        if (cancelled) {
          void map.destroy();
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
      })
      .catch(() => {
        if (!cancelled) setStatus("unavailable");
      });
    return () => {
      cancelled = true;
      setMapReady(false);
    };
  }, [auth.userId, rendererReady]);

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
    const next = [...markers];
    if (selfMarker) next.push(selfMarker);
    if (nearbyPlaceMarker) next.push(nearbyPlaceMarker);
    return next;
  }, [markers, nearbyPlaceMarker, selfMarker]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let paddingTimer: number | null = null;
    let lastPaddingKey = "";
    // The people tray is a bottom-sheet overlay that animates its height when
    // expanded. Anchor the camera's bottom inset to the tray's stable bottom
    // edge plus its COLLAPSED footprint, never its live expanded height, so
    // toggling the tray open/closed never re-frames (zooms/pans) the map.
    const COLLAPSED_TRAY_HEIGHT = 56; // 3.5rem, matches the collapsed tray
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
          tintColor: marker.tint,
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
  }, [entryLocationSettled, mapReady, visibleMarkers]);

  const acceptRenderer = useCallback(async () => {
    if (!vaultOwnerToken) return;
    try {
      const next = await OneLocationService.updateMapPreferences({
        vaultOwnerToken,
        rendererConsentVersion: GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
      });
      setPreferences(next);
      setAcceptedRenderer(true);
    } catch {
      toast.error("Your Map could not be prepared.");
    }
  }, [vaultOwnerToken]);

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
          ? "Ghost Mode is on."
          : "Map visibility is ready. Tap Locate me to appear.",
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
          "Your location is visible only to you. Turn off Ghost Mode to appear to active private recipients.",
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
  const hasVisibleTrayResults =
    filteredPeople.length > 0 ||
    filteredNearbyAttendees.length > 0 ||
    selected !== null;

  const peopleDrawerLabel = useMemo(() => {
    if (nearbyPresenceState.presence) {
      if (nearbyAttendees.length > 0 && markers.length > 0) {
        return `${nearbyAttendees.length} nearby · ${markers.length} sharing`;
      }
      if (nearbyAttendees.length > 0) {
        return `${nearbyAttendees.length} ${
          nearbyAttendees.length === 1 ? "person" : "people"
        } checked in nearby`;
      }
      if (markers.length > 0) {
        return `${markers.length} ${
          markers.length === 1 ? "person" : "people"
        } sharing · no one nearby`;
      }
      return "No one checked in nearby";
    }
    return `${markers.length} ${
      markers.length === 1 ? "person" : "people"
    } sharing with you`;
  }, [markers.length, nearbyAttendees.length, nearbyPresenceState.presence]);

  const peopleDrawerSubtitle = nearbyPresenceState.presence
    ? `Within ${nearbyPresenceState.presence.radiusMeters} m · precise nearby locations stay private`
    : (activeShareCount ?? 0) > 0
      ? `People sharing with you · you're sharing with ${activeShareCount}`
      : "People sharing their location with you";

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
    void mapRef.current?.disableTouch();
    beginRouteTransition(
      ROUTES.ONE_LOCATION,
      () => router.replace(ROUTES.ONE_LOCATION, { scroll: false }),
      "tap",
      "full",
    );
    // If route settlement is externally interrupted, allow an explicit retry
    // rather than leaving the visible close affordance inert.
    window.setTimeout(() => {
      if (window.location.pathname !== ROUTES.ONE_LOCATION_MAP) return;
      closeRequestedRef.current = false;
      setClosing(false);
      void mapRef.current?.enableTouch();
    }, 1_500);
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
      <div
        ref={topControlsRef}
        className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 p-4 pt-[max(1rem,env(safe-area-inset-top))]"
      >
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
        {rendererReady && nearbyCheckInAvailable && !demoMode ? (
          <ShellActionSurface
            variant="pill"
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
        ) : null}
        {!demoMode && (activeShareCount ?? 0) > 0 ? (
          <span
            data-testid="one-location-map-sharing-status"
            aria-label={`You are sharing your location with ${activeShareCount} ${
              activeShareCount === 1 ? "person" : "people"
            }`}
            className="pointer-events-none hidden min-w-0 shrink items-center gap-1.5 truncate rounded-full border border-[var(--app-accent-border)] bg-background/85 px-3 py-1.5 text-[12px] font-semibold text-[var(--app-accent-deep)] shadow-lg backdrop-blur-md md:flex dark:text-[var(--app-accent-bright)]"
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-accent)] motion-safe:animate-pulse"
              aria-hidden="true"
            />
            <span className="truncate">Sharing with {activeShareCount}</span>
          </span>
        ) : null}
        {rendererReady ? (
          <ShellActionSurface
            className={`pointer-events-auto !h-14 !w-14 touch-manipulation border shadow-lg backdrop-blur-md ${MAP_ACCENT_CONTROL_CLASSNAME}`}
            aria-label="Show my location"
            data-testid="one-location-map-locate"
            disabled={busy === "locate"}
            onClick={() => void locateMe()}
          >
            <LocateFixed className="h-5 w-5 stroke-[2.25]" />
          </ShellActionSurface>
        ) : null}
      </div>
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
        <section className="absolute inset-x-4 bottom-4 z-20 rounded-3xl bg-background/95 p-5 shadow-xl">
          <h1 className="font-semibold">
            Your Map needs secure map configuration
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            No location was captured or exposed. Try again after the app’s
            restricted Maps key is configured.
          </p>
        </section>
      ) : null}
      {rendererReady && status !== "unavailable" ? (
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
            height: trayExpanded
              ? hasVisibleTrayResults
                ? "clamp(10rem, calc(100dvh - 6.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom)), 29.5rem)"
                : "min(22rem, calc(100dvh - 6.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom)))"
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
                <span className="block truncate text-xs text-muted-foreground">
                  {peopleDrawerSubtitle}
                </span>
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
              className="h-full min-h-0 overflow-y-auto overscroll-contain px-3 pb-3 pt-1"
              data-testid="one-location-map-tray-scroll"
            >
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <span className="sr-only">Find a person on Your Map</span>
                <Input
                  className="h-11 rounded-full border-border/60 bg-muted/80 pl-9 pr-4"
                  data-testid="one-location-map-search"
                  inputMode="search"
                  placeholder="Find a person"
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
                        ? "No nearby check-ins match your search."
                        : "No one else is checked in nearby yet."}
                    </p>
                  )}
                </section>
              ) : null}

              <section className="mt-3">
                <div className="flex items-center justify-between gap-3 px-1">
                  <div>
                    <h3 className="text-sm font-semibold">
                      Live locations shared with you
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Nearby check-ins stay in the list and never become map
                      pins. A pin appears only after that person explicitly
                      shares their location with you.
                    </p>
                  </div>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">
                    {markers.length}
                  </span>
                </div>
                <div
                  className="mt-2 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  data-testid="one-location-map-people"
                >
                  {filteredPeople.map((person) => {
                    const selectedPerson = selected?.key === person.key;
                    return (
                      <button
                        key={person.key}
                        type="button"
                        className={`flex h-11 shrink-0 items-center gap-2 rounded-full border px-2.5 pr-3 text-left text-sm transition-colors ${
                          selectedPerson
                            ? MAP_ACCENT_ACTIVE_CLASSNAME
                            : "border-border/60 bg-muted/70 text-foreground hover:bg-muted"
                        }`}
                        aria-label={`Show ${person.label} on the map`}
                        data-testid="one-location-map-person"
                        onClick={() => void focusMarker(person)}
                      >
                        <span
                          className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-semibold text-white"
                          style={{
                            backgroundColor: person.tint
                              ? `rgba(${person.tint.r}, ${person.tint.g}, ${person.tint.b}, ${person.tint.a / 255})`
                              : "var(--app-accent)",
                          }}
                        >
                          {personInitials(person.label)}
                        </span>
                        <span className="max-w-28 truncate font-medium">
                          {person.label}
                        </span>
                      </button>
                    );
                  })}
                  {filteredPeople.length === 0 ? (
                    <p className="py-2 pl-1 text-sm text-muted-foreground">
                      {markers.length > 0
                        ? "No live shares match your search."
                        : "No one is sharing a live location with you."}
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
                    <p className="text-xs text-muted-foreground">
                      {selected.kind === "self"
                        ? "Your current location"
                        : "Sharing privately now"}
                    </p>
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
                    <span className="truncate">
                      {demoMode ? "Demo on" : "Demo"}
                    </span>
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
                    {preferences.presenceMode === "ghost"
                      ? demoAvailable
                        ? "Ghost"
                        : "Ghost Mode"
                      : "Visible"}
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
                  {demoAvailable ? "Everyone" : "Show everyone"}
                </Button>
              </div>
              {status === "error" ? (
                <p className="mt-2 text-center text-xs text-destructive">
                  Some locations could not be refreshed.
                </p>
              ) : null}
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
