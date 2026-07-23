"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, LatLngBounds, type Marker } from "@capacitor/google-maps";
import { App as CapacitorApp } from "@capacitor/app";
import {
  ChevronDown,
  Eye,
  EyeOff,
  LocateFixed,
  MapPin,
  Search,
  UsersRound,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRequireAuth } from "@/hooks/use-auth";
import { decryptLocationEnvelope, encryptLocationForRecipient } from "@/lib/one-location/encryption";
import {
  readLocationWorkspaceMemory,
  writeLocationWorkspaceMemory,
} from "@/lib/one-location/location-workspace-memory";
import { getBrowserMapsApiKey, getNativeMapsApiKey } from "@/lib/one-location/maps-config";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationMapMarker,
  OneLocationMapPreferences,
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
import { useVault } from "@/lib/vault/vault-context";

const RENDERER_CONSENT_VERSION = "google-maps-renderer-v1";
const MAP_ID = "one-location-private-map";

type RenderMarker = {
  key: string;
  point: PlainLocationPoint;
  label: string;
  kind: "person" | "self";
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

function mapApiKey(): string {
  if (!isNative()) return getBrowserMapsApiKey();
  const platform = getPlatform();
  return platform === "ios" || platform === "android" ? getNativeMapsApiKey(platform) : "";
}

function markerSignature(markers: RenderMarker[]): string {
  return markers
    .map((marker) => [
      marker.key,
      marker.point.latitude.toFixed(6),
      marker.point.longitude.toFixed(6),
      marker.point.capturedAt,
    ].join(":"))
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

/**
 * Full-screen private-map surface. It only receives ciphertext for active
 * recipient-scoped grants, decrypts it in foreground memory, and destroys both
 * renderer and coordinates on unmount. Opening this route never captures the
 * device's location or starts a background watcher.
 */
export function LocationImmersiveMap() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const auth = useRequireAuth();
  const { vaultOwnerToken } = useVault();
  const demoAvailable = isLocationMapDemoAvailable();
  const initialDemoMode = isLocationMapDemoEnabled(searchParams.get("demo"));
  const mapElement = useRef<HTMLElement | null>(null);
  const mapRef = useRef<GoogleMap | null>(null);
  const topControlsRef = useRef<HTMLDivElement | null>(null);
  const peopleTrayRef = useRef<HTMLDivElement | null>(null);
  const markerIdsRef = useRef<string[]>([]);
  const markerByMapIdRef = useRef<Map<string, RenderMarker>>(new Map());
  const framedInitialMarkersRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const markerSignatureRef = useRef("");
  const initialDemoModeRef = useRef(initialDemoMode);
  const closeRequestedRef = useRef(false);
  const [demoMode, setDemoMode] = useState(initialDemoMode);
  const [acceptedRenderer, setAcceptedRenderer] = useState(false);
  const [preferences, setPreferences] = useState<OneLocationMapPreferences>({ presenceMode: "ghost" });
  const [markers, setMarkers] = useState<RenderMarker[]>([]);
  const [selfMarker, setSelfMarker] = useState<RenderMarker | null>(null);
  const [selected, setSelected] = useState<RenderMarker | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [trayExpanded, setTrayExpanded] = useState(true);
  const [closing, setClosing] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "unavailable" | "error">("idle");
  const [busy, setBusy] = useState<"presence" | "locate" | null>(null);
  const mountedRef = useRef(true);
  const rendererReady = acceptedRenderer || demoMode;

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
            const point = await decryptLocationEnvelope({ userId: auth.userId!, envelope: marker.envelope });
            return {
              key: marker.envelope.id || `${marker.grant.id}:${marker.envelope.capturedAt}`,
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      markerIdsRef.current = [];
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
          state.preferences.rendererConsentVersion === RENDERER_CONSENT_VERSION,
        );
      })
      .catch(() => {
        // The disclosure remains available; do not misrepresent a transient
        // bootstrap error as a location or consent failure.
      });
    return () => { cancelled = true; };
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
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5_000);
    let appListener: { remove: () => Promise<void> } | undefined;
    if (isNative()) {
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) void refresh();
      }).then((listener) => { appListener = listener; });
    }
    return () => {
      window.clearInterval(timer);
      void appListener?.remove();
    };
  }, [demoMode, refresh, rendererReady, vaultOwnerToken]);

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
    void GoogleMap.create({
      id: MAP_ID,
      element: mapElement.current,
      apiKey,
      forceCreate: true,
      config: {
        center: initialDemoModeRef.current
          ? { lat: 37.7749, lng: -122.4194 }
          : { lat: 20, lng: 0 },
        zoom: initialDemoModeRef.current ? 11 : 2,
        disableDefaultUI: true,
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
      .catch(() => { if (!cancelled) setStatus("unavailable"); });
    return () => {
      cancelled = true;
      setMapReady(false);
    };
  }, [rendererReady]);

  const visibleMarkers = useMemo(
    () => (selfMarker ? [...markers, selfMarker] : markers),
    [markers, selfMarker],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let paddingTimer: number | null = null;
    const publishPadding = () => {
      const top = topControlsRef.current?.getBoundingClientRect().bottom ?? 72;
      const trayTop =
        peopleTrayRef.current?.getBoundingClientRect().top ??
        window.innerHeight - 160;
      void map.setPadding({
        top: Math.ceil(top + 12),
        right: 20,
        bottom: Math.ceil(window.innerHeight - trayTop + 12),
        left: 20,
      });
    };
    const schedulePadding = () => {
      if (paddingTimer !== null) window.clearTimeout(paddingTimer);
      // ResizeObserver fires throughout the card-to-button morph. Publish only
      // after geometry settles so the native bridge does not receive a call on
      // every animation frame.
      paddingTimer = window.setTimeout(publishPadding, 80);
    };
    publishPadding();
    const observer = new ResizeObserver(schedulePadding);
    if (topControlsRef.current) observer.observe(topControlsRef.current);
    if (peopleTrayRef.current) observer.observe(peopleTrayRef.current);
    window.addEventListener("resize", schedulePadding);
    return () => {
      if (paddingTimer !== null) window.clearTimeout(paddingTimer);
      observer.disconnect();
      window.removeEventListener("resize", schedulePadding);
    };
  }, [mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let cancelled = false;
    void (async () => {
      if (markerIdsRef.current.length) await map.removeMarkers(markerIdsRef.current);
      const mapMarkers: Marker[] = visibleMarkers.map((marker) => ({
        coordinate: { lat: marker.point.latitude, lng: marker.point.longitude },
        // Labels stay in the local HTML tray/search index. The native Google
        // renderer receives coordinates and a generic accessibility title,
        // never the private recipient name.
        title: marker.kind === "self" ? "Your location" : "Private location",
        snippet:
          marker.kind === "self" ? "Your current location" : "Sharing privately now",
        tintColor: marker.tint,
        zIndex: marker.kind === "self" ? 10 : 1,
      }));
      const ids = mapMarkers.length ? await map.addMarkers(mapMarkers) : [];
      if (cancelled) return;
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
      if (!framedInitialMarkersRef.current && visibleMarkers.length > 0) {
        framedInitialMarkersRef.current = true;
        await frameMarkers(map, visibleMarkers);
      }
    })().catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [mapReady, visibleMarkers]);

  const acceptRenderer = useCallback(async () => {
    if (!vaultOwnerToken) return;
    try {
      const next = await OneLocationService.updateMapPreferences({
        vaultOwnerToken,
        rendererConsentVersion: RENDERER_CONSENT_VERSION,
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
      const nextMode = preferences.presenceMode === "ghost" ? "foreground_private" : "ghost";
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
      const next = await OneLocationService.updateMapPreferences({ vaultOwnerToken, presenceMode: nextMode });
      setPreferences(next);
      toast.success(nextMode === "ghost" ? "Ghost Mode is on." : "Map visibility is ready. Tap Locate me to appear.");
    } catch {
      toast.error("Map visibility could not be updated.");
    } finally { setBusy(null); }
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
      const point = await OneLocationService.captureCurrentPosition();
      const currentLocation: RenderMarker = {
        key: "current-device-location",
        kind: "self",
        label: "You",
        point,
        tint: { r: 0, g: 122, b: 255, a: 255 },
      };
      setSelfMarker(currentLocation);
      setSelected(currentLocation);
      if (auth.userId && !demoMode) {
        const workspace = readLocationWorkspaceMemory(auth.userId);
        writeLocationWorkspaceMemory(auth.userId, {
          ...workspace,
          myLocationPoint: point,
        });
      }
      await mapRef.current?.setCamera({
        coordinate: { lat: point.latitude, lng: point.longitude },
        zoom: zoomForAccuracy(point.accuracyM),
        animate: true,
      });
      if (demoMode) {
        toast.success("Centered on your device location.");
        return;
      }
      if (preferences.presenceMode !== "foreground_private") {
        toast.message("Your location is visible only to you. Turn off Ghost Mode to appear to active private recipients.");
        return;
      }
      const state = await OneLocationService.getState(vaultOwnerToken);
      const recipientsByKey = new Map(state.recipients.map((recipient) => [`${recipient.userId}:${recipient.keyId}`, recipient]));
      const grants = state.ownerGrants.filter((grant) => grant.status === "active" && !!grant.id);
      await Promise.all(grants.map(async (grant) => {
        const recipient = recipientsByKey.get(`${grant.recipientUserId}:${grant.recipientKeyId}`);
        if (!recipient?.publicKeyJwk || !recipient.keyId) return;
        const envelope = await encryptLocationForRecipient({ point, recipientPublicKeyJwk: recipient.publicKeyJwk, recipientKeyId: recipient.keyId });
        envelope.publicationContext = "foreground_map_visible";
        await OneLocationService.storeEnvelope({ vaultOwnerToken, grantId: grant.id, envelope });
      }));
      toast.success("Your active private recipients can see this foreground update.");
    } catch {
      toast.error("We could not update your location.");
    } finally { setBusy(null); }
  }, [auth.userId, demoMode, preferences.presenceMode, vaultOwnerToken]);

  const filteredPeople = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return markers;
    return markers.filter((marker) =>
      marker.label.toLocaleLowerCase().includes(query),
    );
  }, [markers, searchQuery]);

  const markerCountLabel = useMemo(
    () => `${markers.length} ${markers.length === 1 ? "person" : "people"} on Your Map`,
    [markers.length],
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
    void CapacitorApp.addListener("backButton", () => closeMap()).then(
      (handle) => {
        listener = handle;
      },
    );
    return () => {
      void listener?.remove();
    };
  }, [closeMap]);

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
          className="pointer-events-auto !h-14 !w-14 touch-manipulation border border-border/50 !bg-background/95 !text-foreground shadow-lg backdrop-blur-md hover:!bg-background"
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
        {rendererReady ? (
          <ShellActionSurface
            className="pointer-events-auto !h-14 !w-14 touch-manipulation border border-border/50 !bg-background/95 !text-foreground shadow-lg backdrop-blur-md hover:!bg-background"
            aria-label="Show my location"
            data-testid="one-location-map-locate"
            disabled={busy === "locate"}
            onClick={() => void locateMe()}
          >
            <LocateFixed className="h-5 w-5 stroke-[2.25]" />
          </ShellActionSurface>
        ) : null}
      </div>
      {!rendererReady ? (
        <section
          className="absolute inset-x-4 z-20 rounded-3xl border border-border/60 bg-background/95 p-5 shadow-2xl backdrop-blur"
          data-testid="one-location-map-disclosure"
          style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <MapPin className="h-6 w-6 text-primary" />
          <h1 className="mt-3 text-xl font-semibold">Your Map</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Your Map renders active private shares with Google Maps. One sends
            Google only the map request; coordinates stay encrypted until this
            device decrypts an approved share.
          </p>
          <Button className="mt-4 w-full" onClick={() => void acceptRenderer()}>
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
          <h1 className="font-semibold">Your Map needs secure map configuration</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            No location was captured or exposed. Try again after the app’s
            restricted Maps key is configured.
          </p>
        </section>
      ) : null}
      {rendererReady && status !== "unavailable" ? (
        <div
          ref={peopleTrayRef}
          className="absolute left-1/2 z-20 will-change-[width] motion-reduce:transition-none"
          data-testid="one-location-map-people-tray"
          data-state={trayExpanded ? "expanded" : "collapsed"}
          style={{
            bottom: "max(0.75rem, env(safe-area-inset-bottom))",
            transform: "translateX(-50%)",
            transition:
              "width 500ms cubic-bezier(0.34, 1.56, 0.64, 1)",
            width: trayExpanded
              ? "min(34rem, calc(100vw - 1.5rem))"
              : "4rem",
          }}
        >
          <section
            className={`overflow-hidden border border-border/50 bg-background/95 shadow-2xl backdrop-blur-xl transition-[max-height,border-radius,background-color,box-shadow] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none ${
              trayExpanded
                ? "max-h-[30rem] rounded-[1.75rem]"
                : "max-h-16 rounded-full"
            }`}
          >
            <button
              type="button"
              className={`group relative flex w-full touch-manipulation items-center text-left transition-[height,padding] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70 motion-reduce:transition-none ${
                trayExpanded ? "h-[4.5rem] px-3 pb-2 pt-2.5" : "h-16 justify-center p-0"
              }`}
              aria-expanded={trayExpanded}
              aria-label={trayExpanded ? "Minimize map controls" : "Expand map controls"}
              data-testid="one-location-map-tray-toggle"
              onClick={() => setTrayExpanded((current) => !current)}
            >
            <span
              className={`absolute left-1/2 top-1.5 h-1 w-10 -translate-x-1/2 rounded-full bg-foreground/20 transition-[opacity,transform] duration-300 group-hover:bg-foreground/35 ${
                trayExpanded ? "scale-x-100 opacity-100" : "scale-x-75 opacity-0"
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
              <UsersRound className="h-6 w-6 stroke-[2.25]" />
              {markers.length > 0 ? (
                <span className="absolute right-2 top-2 grid min-h-5 min-w-5 place-items-center rounded-full bg-foreground px-1 text-[10px] font-semibold leading-none text-background">
                  {markers.length > 9 ? "9+" : markers.length}
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
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">
                    {markerCountLabel}
                  </span>
                  {demoMode ? (
                    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent-foreground">
                      Demo
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  Active private shares only
                </span>
              </span>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted/80 text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-foreground">
                <ChevronDown className="h-4 w-4" />
              </span>
            </span>
            </button>

            <div
              className={`origin-bottom overflow-hidden transition-[max-height,opacity,transform] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none ${
                trayExpanded
                  ? "max-h-[25rem] translate-y-0 scale-[1] opacity-100"
                  : "pointer-events-none max-h-0 translate-y-4 scale-[0.96] opacity-0"
              }`}
              aria-hidden={!trayExpanded}
              inert={!trayExpanded}
            >
            <div className="min-h-0 overflow-hidden">
              <div className="px-3 pb-3 pt-1">
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

                <div
                  className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                            ? "border-foreground/30 bg-foreground text-background"
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
                      No matching person is active.
                    </p>
                  ) : null}
                </div>

                {selected ? (
                  <div
                    className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-2xl bg-muted/80 px-3"
                    data-testid="one-location-map-selection"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{selected.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {selected.kind === "self"
                          ? "Your current location"
                          : "Sharing privately now"}
                      </p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => void showEveryone()}>
                      Show everyone
                    </Button>
                  </div>
                ) : null}

                <div
                  className={`mt-3 grid gap-2 ${
                    demoAvailable ? "grid-cols-3" : "grid-cols-2"
                  }`}
                >
                  {demoAvailable ? (
                    <Button
                      className="h-11 min-w-0 rounded-2xl px-2"
                      variant={demoMode ? "default" : "secondary"}
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
                    className="h-11 min-w-0 justify-between rounded-2xl px-2.5"
                    variant="secondary"
                    disabled={busy === "presence"}
                    onClick={() => void setPresence()}
                  >
                    <span className="truncate">
                      {preferences.presenceMode === "ghost"
                        ? demoAvailable ? "Ghost" : "Ghost Mode"
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
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
