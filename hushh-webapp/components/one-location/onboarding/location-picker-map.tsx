"use client";

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { useTheme } from "next-themes";
import { GoogleMap } from "@capacitor/google-maps";
import { Check, Crosshair, Loader2, MapPin, X } from "lucide-react";

import {
  useGoogleMaps,
  type MapsLoadStatus,
} from "@/lib/one-location/use-google-maps";
import {
  DARK_MAP_STYLES,
  getNativeMapsApiKey,
} from "@/lib/one-location/maps-config";
import { PICKER_MAP_HEIGHT_CLASSNAME } from "@/components/one-location/onboarding/save-location-sheet-layout";
import { getPlatform, isNative } from "@/lib/capacitor/platform";
import {
  claimNativeMap,
  isNativeMapSuperseded,
  waitForLaidOutBox,
  withNativeMapLock,
} from "@/lib/one-location/native-map-lifecycle";
import { cn } from "@/lib/utils";

export type PickedLocation = {
  latitude: number;
  longitude: number;
  address: string | null;
};

/**
 * Lets the surrounding carousel commit the pin from a swipe or a dot tap, not
 * only from the Confirm button. The pin, the settle state and the resolved
 * address all live in here, so the parent cannot decide on its own whether a
 * confirm is safe -- it has to ask.
 */
export type LocationPickerMapHandle = {
  /** True when the pin has settled and its address lookup has finished. */
  canConfirm: () => boolean;
  /** Commit the current pin. Returns false when it was not safe to. */
  confirm: () => boolean;
};

export interface LocationPickerMapProps {
  ref?: Ref<LocationPickerMapHandle>;
  /** Where the map centers when it first opens. */
  initialLatitude: number;
  initialLongitude: number;
  /** Friendly address already resolved for the initial point (optional). */
  initialAddress?: string | null;
  /** Device accuracy for copy only; the chosen map centre remains authoritative. */
  initialAccuracyM?: number | null;
  /** Server-side reverse geocode used to keep the address in sync with the pin. */
  reverseGeocode?: (lat: number, lng: number) => Promise<string | null>;
  /** Re-center the map on the device GPS fix. */
  onLocateMe?: () => Promise<{ latitude: number; longitude: number } | null>;
  /** Emitted when the owner confirms the pin position. */
  onConfirm: (picked: PickedLocation) => void;
  /**
   * Fires whenever "this pin is ready to commit" changes, so a surrounding
   * carousel can enable its own forward affordance from real state instead of
   * reading the imperative handle during render -- where a ref is still null.
   */
  onReadyChange?: (ready: boolean) => void;
  /** Keep the chosen point/address in sync with a unified parent form. */
  onSelectionChange?: (picked: PickedLocation) => void;
  /** Dismiss the map without changing the captured point. */
  onCancel: () => void;
  /**
   * Retained for API compatibility with existing callers. The map now opens
   * directly (no separate "Before the map opens" disclosure step), so these are
   * optional and unused by the picker.
   */
  rendererDisclosureAccepted?: boolean;
  onAcceptRendererDisclosure?: () => Promise<void>;

  confirmLabel?: string;
  cancelLabel?: string;
  /** Render only the map, hint, and recovery state inside a larger screen. */
  embedded?: boolean;
  className?: string;
}

const PIN_REVERSE_GEOCODE_DEBOUNCE_MS = 350;
// Distinct id so the onboarding picker never collides with the immersive
// "Your Map" native map instance.
const PICKER_NATIVE_MAP_ID = "one-location-onboarding-picker-map";

function isValidCoordinate(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * LocationPickerMap uses the familiar "drag the map, the pin stays centred"
 * pattern so the owner can confirm their entrance instead of trusting a coarse
 * GPS fix. The centre pin marks the chosen coordinate; when the map settles we
 * reverse-geocode the centre so the address preview stays truthful. A "Use my
 * location" control re-centres on the live GPS fix, and Confirm returns the
 * owner-confirmed coordinate and resolved address to the caller.
 *
 * Rendering differs by platform, and this matters for iOS/Android:
 * - Web loads the Google Maps JS SDK (referrer-authorised browser key).
 * - Native uses the SAME native @capacitor/google-maps SDK that powers "Your
 *   Map" (bundle-id authorised key). The browser JS SDK is rejected inside the
 *   App:// WebView (RefererNotAllowedMapError), which is why the picker used to
 *   show a blank map on the TestFlight build. The native map draws BELOW the
 *   WebView, so the map surface opts into the shared `one-location-map-native`
 *   transparency class while the pin + controls stay as regular web UI on top.
 */
export function LocationPickerMap({
  ref,
  initialLatitude,
  initialLongitude,
  initialAddress = null,
  initialAccuracyM = null,
  reverseGeocode,
  onLocateMe,
  onConfirm,
  onReadyChange,
  onSelectionChange,
  onCancel,
  rendererDisclosureAccepted = false,
  onAcceptRendererDisclosure,
  confirmLabel = "Confirm location",
  cancelLabel = "Cancel",
  embedded = false,
  className,
}: LocationPickerMapProps) {
  // The map opens directly now (no pre-map disclosure gate), so Google Maps
  // initializes as soon as the picker mounts.
  void rendererDisclosureAccepted;
  void onAcceptRendererDisclosure;
  const native = isNative();
  // Only the web renderer needs the browser JS SDK; skip loading it on native.
  const { status: webStatus } = useGoogleMaps({ enabled: !native });
  const [nativeStatus, setNativeStatus] = useState<MapsLoadStatus>("loading");
  const status = native ? nativeStatus : webStatus;
  const { resolvedTheme } = useTheme();

  const colorScheme = resolvedTheme === "dark" ? "DARK" : "LIGHT";

  const containerRef = useRef<HTMLDivElement | null>(null);
  const nativeMapElementRef = useRef<HTMLElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const nativeMapRef = useRef<GoogleMap | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const resolveIdRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const hasInteractedRef = useRef(false);
  const mapUnavailableDescriptionId = useId();

  const centerRef = useRef<{ lat: number; lng: number }>({
    lat: initialLatitude,
    lng: initialLongitude,
  });
  const [address, setAddress] = useState<string | null>(initialAddress);
  const [resolving, setResolving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  // Safety net: if the map never reaches "ready" within this window, fall back
  // to the captured-point flow so the owner is never blocked behind an infinite
  // "Loading map…". See the timeout effect below.
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (hasInteractedRef.current) return;
    setAddress((initialAddress && initialAddress.trim()) || null);
  }, [initialAddress]);

  // Resolve the pinned coordinate to a human address entirely in the browser.
  // Primary path is google.maps.Geocoder (classic Geocoding API). Some Maps
  // keys (like this project's) enable the Maps JavaScript API + Places API (New)
  // but NOT the classic Geocoding API, which makes Geocoder return nothing. In
  // that case we fall back to the Places nearest-place lookup — the SAME source
  // the backend/Your Map uses — so the address still resolves instead of
  // showing "Address not found".
  const reverseGeocodeViaNearestPlace = useCallback(
    async (lat: number, lng: number): Promise<string | null> => {
      if (typeof google === "undefined") return null;
      const places = (
        google.maps as unknown as {
          places?: {
            Place?: {
              searchNearby: (request: unknown) => Promise<{
                places: Array<{
                  formattedAddress?: string | null;
                  displayName?: string | null;
                }>;
              }>;
            };
            SearchNearbyRankPreference?: { DISTANCE?: unknown };
          };
        }
      ).places;
      if (!places?.Place?.searchNearby) return null;
      try {
        const { places: results } = await places.Place.searchNearby({
          fields: ["formattedAddress", "displayName"],
          locationRestriction: {
            center: { lat, lng },
            // Keep the fallback tightly bounded so a distant landmark is never
            // presented as the user's pinned spot (mirrors the backend radius).
            radius: 100,
          },
          maxResultCount: 1,
          rankPreference: places.SearchNearbyRankPreference?.DISTANCE,
        });
        const nearest = results?.[0];
        if (!nearest) return null;
        const formatted =
          typeof nearest.formattedAddress === "string"
            ? nearest.formattedAddress.trim()
            : "";
        if (formatted) return formatted;
        const name =
          typeof nearest.displayName === "string"
            ? nearest.displayName.trim()
            : "";
        return name || null;
      } catch {
        return null;
      }
    },
    [],
  );

  const reverseGeocodeInBrowser = useCallback(
    async (lat: number, lng: number): Promise<string | null> => {
      if (typeof google === "undefined") return null;
      if (google.maps.Geocoder) {
        try {
          const geocoder = geocoderRef.current ?? new google.maps.Geocoder();
          geocoderRef.current = geocoder;
          const response = await geocoder.geocode({ location: { lat, lng } });
          const formatted =
            response.results[0]?.formatted_address?.trim() || null;
          if (formatted) return formatted;
        } catch {
          // Geocoding API not enabled / denied for this key — fall through to
          // the Places nearest-place lookup below.
        }
      }
      return reverseGeocodeViaNearestPlace(lat, lng);
    },
    [reverseGeocodeViaNearestPlace],
  );

  const scheduleResolve = useCallback(
    (lat: number, lng: number) => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
      // The map centre is now authoritative. Invalidate the old address before
      // the debounce starts so Confirm cannot pair new coordinates with stale
      // reverse-geocoded copy from the previous centre.
      const requestId = resolveIdRef.current + 1;
      resolveIdRef.current = requestId;
      setAddress(null);
      setResolving(true);
      setLocationError(null);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        // On native the browser JS SDK is not loaded, so the server-side
        // reverseGeocode prop is the only resolver; the browser fallback simply
        // returns null there and the owner completes the address on the next step.
        const resolve = reverseGeocode ?? reverseGeocodeInBrowser;
        void Promise.resolve(resolve(lat, lng))
          .then((next) => {
            if (resolveIdRef.current !== requestId) return;
            setAddress((next && next.trim()) || null);
          })
          .catch(() => {
            if (resolveIdRef.current !== requestId) return;
            setAddress(null);
          })
          .finally(() => {
            if (resolveIdRef.current === requestId) setResolving(false);
          });
      }, PIN_REVERSE_GEOCODE_DEBOUNCE_MS);
    },
    [reverseGeocode, reverseGeocodeInBrowser],
  );

  // WEB: build the interactive JS map once the API is ready. Google applies
  // colorScheme only at construction, so the container is keyed by scheme to
  // force a fresh node when the theme flips.
  useEffect(() => {
    if (native) return;
    if (status !== "ready" || !containerRef.current || mapRef.current) return;
    const start = centerRef.current;
    const map = new google.maps.Map(containerRef.current, {
      center: start,
      zoom: 17,
      disableDefaultUI: true,
      clickableIcons: false,
      gestureHandling: "greedy",
      colorScheme,
    });
    mapRef.current = map;

    const dragStart = map.addListener("dragstart", () => {
      hasInteractedRef.current = true;
      setHasInteracted(true);
      resolveIdRef.current += 1;
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      setAddress(null);
      setResolving(true);
      setDragging(true);
    });
    const idle = map.addListener("idle", () => {
      const center = map.getCenter();
      if (!center) return;
      const lat = center.lat();
      const lng = center.lng();
      centerRef.current = { lat, lng };
      setDragging(false);
      scheduleResolve(lat, lng);
    });
    // Tapping the map recenters the pin on that spot (a second familiar gesture).
    const click = map.addListener(
      "click",
      (event: google.maps.MapMouseEvent) => {
        if (!event.latLng) return;
        hasInteractedRef.current = true;
        setHasInteracted(true);
        map.panTo(event.latLng);
      },
    );

    return () => {
      dragStart.remove();
      idle.remove();
      click.remove();
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      resolveIdRef.current += 1;
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, status, colorScheme]);

  // NATIVE: build the map with the SAME @capacitor/google-maps SDK as "Your
  // Map". This authenticates by app bundle id (native key), so it renders inside
  // the App:// WebView where the browser JS SDK is rejected. The native map view
  // is drawn below the WebView, so the surface + shell opt into the shared
  // `one-location-map-native` transparency class while it is mounted.
  useEffect(() => {
    if (!native) return;
    const element = nativeMapElementRef.current;
    if (!element) return;
    const platform = getPlatform();
    const apiKey =
      platform === "ios" || platform === "android"
        ? getNativeMapsApiKey(platform)
        : "";
    if (!apiKey) {
      setNativeStatus("error");
      return;
    }

    let cancelled = false;
    // Claimed before any await. This effect re-runs on colorScheme, which
    // resolves from `undefined` after next-themes hydrates -- so an ordinary
    // cold open tears this mount down while its create is still in flight.
    const claim = claimNativeMap(PICKER_NATIVE_MAP_ID);
    const superseded = () =>
      cancelled || isNativeMapSuperseded(PICKER_NATIVE_MAP_ID, claim);
    let createdMap: GoogleMap | null = null;
    const start = centerRef.current;
    document.documentElement.classList.add("one-location-map-native");
    document.body.classList.add("one-location-map-native");

    void withNativeMapLock(PICKER_NATIVE_MAP_ID, async () => {
      if (superseded()) return;
      await waitForLaidOutBox(element);
      if (superseded()) return;
      const map = await GoogleMap.create({
        id: PICKER_NATIVE_MAP_ID,
        element,
        apiKey,
        forceCreate: true,
        config: {
          center: { lat: start.lat, lng: start.lng },
          zoom: 17,
          disableDefaultUI: true,
          styles: colorScheme === "DARK" ? DARK_MAP_STYLES : undefined,
        },
      });
      if (superseded()) {
        // Inside the lock, so this destroys the map this call created and
        // never one a later mount registered under the same id.
        await map.destroy().catch(() => undefined);
        return;
      }
      {
        createdMap = map;
        nativeMapRef.current = map;
        // Dragging the native map starts a camera move: invalidate the address
        // so Confirm never pairs a new centre with stale copy.
        await map.setOnCameraMoveStartedListener(() => {
          hasInteractedRef.current = true;
          setHasInteracted(true);
          resolveIdRef.current += 1;
          if (debounceRef.current !== null) {
            window.clearTimeout(debounceRef.current);
            debounceRef.current = null;
          }
          setAddress(null);
          setResolving(true);
          setDragging(true);
        });
        // When the camera settles, the centre coordinate is authoritative — the
        // fixed centre pin marks it. Reverse-geocode the settled centre.
        await map.setOnCameraIdleListener((data) => {
          if (!isValidCoordinate(data.latitude, data.longitude)) return;
          centerRef.current = { lat: data.latitude, lng: data.longitude };
          setDragging(false);
          scheduleResolve(data.latitude, data.longitude);
        });
        setNativeStatus("ready");
      }
    }).catch(() => {
      if (!cancelled) setNativeStatus("error");
    });

    return () => {
      cancelled = true;
      const stale = createdMap;
      createdMap = null;
      if (stale) {
        void withNativeMapLock(PICKER_NATIVE_MAP_ID, () =>
          stale.destroy(),
        ).catch(() => undefined);
      }
      nativeMapRef.current = null;
      document.documentElement.classList.remove("one-location-map-native");
      document.body.classList.remove("one-location-map-native");
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      resolveIdRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, colorScheme]);

  useEffect(() => {
    if (status !== "error") return;
    resolveIdRef.current += 1;
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setDragging(false);
    setResolving(false);
  }, [status]);

  // Timeout fallback: if the map hasn't reached "ready" within 5s, stop showing
  // the infinite "Loading map…" and switch to the captured-point flow so the
  // owner can still Confirm. Clears itself the moment the map becomes ready.
  useEffect(() => {
    if (status === "ready") {
      setTimedOut(false);
      return;
    }
    if (status === "error") return;
    const timer = window.setTimeout(() => setTimedOut(true), 5000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const handleLocateMe = useCallback(async () => {
    if (!onLocateMe || locating) return;
    setLocating(true);
    setLocationError(null);
    try {
      const fix = await onLocateMe();
      if (fix && isValidCoordinate(fix.latitude, fix.longitude)) {
        hasInteractedRef.current = true;
        setHasInteracted(true);
        resolveIdRef.current += 1;
        if (debounceRef.current !== null) {
          window.clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        setAddress(null);
        setResolving(true);
        centerRef.current = { lat: fix.latitude, lng: fix.longitude };
        if (native) {
          // `setCamera` reads `mapViewController.GMapView`, which the plugin
          // declares as an implicitly unwrapped `GMSMapView!`. Calling it while
          // the native map is being created or destroyed hits a nil there and
          // traps -- EXC_BREAKPOINT in Map.setCamera(config:), which kills the
          // app outright rather than throwing something JS could catch. The
          // teardown above clears `nativeMapRef` synchronously but destroys the
          // map asynchronously inside the lock, and the create effect re-runs
          // when the theme resolves, so a tap landing in that window crashed.
          //
          // Take the same lock the create and destroy take, and re-read the ref
          // inside it, so this can never overlap either one.
          let moved = false;
          await withNativeMapLock(PICKER_NATIVE_MAP_ID, async () => {
            const map = nativeMapRef.current;
            if (!map || status !== "ready") return;
            // The camera-idle listener re-resolves the address after the move.
            await map.setCamera({
              coordinate: { lat: fix.latitude, lng: fix.longitude },
              zoom: 17,
              animate: true,
            });
            moved = true;
          }).catch(() => undefined);
          // No map to move (torn down, or still coming up): resolve the address
          // for the fix directly so the pin still follows the person.
          if (!moved) scheduleResolve(fix.latitude, fix.longitude);
        } else {
          const map = mapRef.current;
          if (map) {
            map.panTo({ lat: fix.latitude, lng: fix.longitude });
            map.setZoom(17);
          } else {
            scheduleResolve(fix.latitude, fix.longitude);
          }
        }
      } else {
        setLocationError("Move the map manually.");
      }
    } catch {
      setLocationError("Move the map manually.");
    } finally {
      setLocating(false);
    }
  }, [locating, native, onLocateMe, scheduleResolve, status]);

  // Treat a hard SDK error OR the 5s load timeout as "unavailable" so the owner
  // is never trapped behind an infinite "Loading map…"; both fall back to the
  // captured-point confirm flow below.
  const unavailable = status === "error" || timedOut;

  // The single definition of "this pin is ready to commit", so the Confirm
  // button, its colour, the carousel swipe and the carousel dots can never
  // disagree about it.
  const canConfirm =
    !dragging &&
    !resolving &&
    !locating &&
    (unavailable || status === "ready") &&
    isValidCoordinate(centerRef.current.lat, centerRef.current.lng);

  const handleConfirm = useCallback(() => {
    const { lat, lng } = centerRef.current;
    if (!isValidCoordinate(lat, lng)) return false;
    onConfirm({ latitude: lat, longitude: lng, address });
    return true;
  }, [address, onConfirm]);

  useImperativeHandle(
    ref,
    () => ({
      canConfirm: () => canConfirm,
      confirm: () => (canConfirm ? handleConfirm() : false),
    }),
    [canConfirm, handleConfirm],
  );

  useEffect(() => {
    onReadyChange?.(canConfirm);
  }, [canConfirm, onReadyChange]);

  useEffect(() => {
    if (!canConfirm || !onSelectionChange) return;
    const { lat, lng } = centerRef.current;
    onSelectionChange({ latitude: lat, longitude: lng, address });
  }, [address, canConfirm, onSelectionChange]);

  /**
   * One short line, and it only changes when the advice changes.
   *
   * There were four, all of them narrating GPS at the person: "GPS gave us a
   * strong starting point. Confirm the entrance yourself." tells you about a
   * satellite system when the only thing you can do about it is drag a map.
   * The one distinction worth keeping is whether the starting point is close
   * enough to trust at a glance -- so a poor fix asks for more care, and
   * everything else just says what to do.
   */
  const accuracyHint =
    typeof initialAccuracyM === "number" &&
    Number.isFinite(initialAccuracyM) &&
    initialAccuracyM > 75
      ? "We're not sure of this spot. Check it."
      : "Move the pin if needed.";

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {!embedded ? (
        <div className="flex items-center justify-between">
          {/* Three words. "on the map" described the thing the person is already
            looking at, and this row shares a sheet header with the step rail --
            every word here is a word the title has to fit beside a 44px close
            target at 320px. */}
          <p className="text-[15px] font-semibold text-foreground">
            Pin your entrance
          </p>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close map"
            className={cn(
              "press-scale flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.05] text-[#4b5563] transition-colors hover:bg-black/[0.08] dark:bg-white/[0.08] dark:text-[#aeb8c7]",
              // 32px circle, 44x44 tappable. The `::after` box is painted, not
              // laid out, so the header row does not move.
              "relative after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
            )}
          >
            <X className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>
      ) : null}

      <div
        // Panning the map is a horizontal drag too. Marked so an enclosing
        // carousel can ignore gestures that start here instead of stealing
        // them and sliding the sheet while the person is moving the pin.
        data-location-picker-surface
        className={cn(
          "relative w-full overflow-hidden rounded-2xl border border-black/[0.08] shadow-[0_8px_24px_rgba(16,24,40,0.12)] ring-1 ring-black/[0.02] dark:border-white/[0.1] dark:shadow-[0_8px_24px_rgba(0,0,0,0.4)]",
          embedded
            ? "h-[clamp(160px,25dvh,240px)] lg:h-[clamp(300px,44dvh,460px)]"
            : PICKER_MAP_HEIGHT_CLASSNAME,
          // The native map draws below the WebView, so the surface must stay
          // transparent for it to show through. Web keeps the neutral tile bg.
          native
            ? "one-location-picker-native-surface bg-transparent"
            : "bg-[#eef2f7] dark:bg-[#10151d]",
        )}
      >
        {/* NATIVE: the @capacitor/google-maps element must be mounted BEFORE
            GoogleMap.create runs (create needs a real element). Gating it behind
            status==="ready" deadlocked the picker — the element only mounted
            once ready, but ready only arrives after create succeeds against the
            element — which is what left it stuck on "Loading map…". So on native
            we always mount the element (unless the map is truly unavailable) and
            overlay the loader on top until it's ready. */}
        {native && !unavailable ? (
          <capacitor-google-map
            ref={(element: HTMLElement | null) => {
              nativeMapElementRef.current = element;
            }}
            className="block h-full w-full bg-transparent"
          />
        ) : null}

        {unavailable ? (
          <div
            role="status"
            aria-live="polite"
            className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
          >
            <MapPin
              className="h-7 w-7 text-[#8b93a1]"
              strokeWidth={2}
              aria-hidden
            />
            <p
              id={mapUnavailableDescriptionId}
              className="text-[13px] font-medium text-[#5b6472] dark:text-[#9aa6b6]"
            >
              The interactive map isn&apos;t available right now. You can
              continue with the captured point and complete the address
              manually.
            </p>
          </div>
        ) : status !== "ready" ? (
          // Overlay (not a replacement): on native the map element stays mounted
          // underneath so create() can resolve; this loader simply covers it
          // until ready.
          <div className="absolute inset-0 flex h-full items-center justify-center gap-2 bg-[#eef2f7] text-[13px] text-[#5b6472] dark:bg-[#10151d] dark:text-[#9aa6b6]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading
            map…
          </div>
        ) : (
          <>
            {native ? null : (
              <div
                key={colorScheme}
                ref={containerRef}
                className="h-full w-full"
              />
            )}

            {/* Fixed centre marker — the map moves beneath it, so the pin
                always marks the chosen coordinate. A polished Google-style
                teardrop (accent fill + white ring) with a soft ground shadow
                reads far better than a flat outline icon. */}
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
              aria-hidden="true"
            >
              <div
                className={cn(
                  "relative flex flex-col items-center transition-transform duration-150 ease-out",
                  // Lift so the teardrop TIP sits exactly on the map centre.
                  dragging ? "-translate-y-[30px]" : "-translate-y-[24px]",
                )}
              >
                <svg
                  width="40"
                  height="48"
                  viewBox="0 0 40 48"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="drop-shadow-[0_6px_10px_rgba(16,24,40,0.35)]"
                >
                  {/* Teardrop body */}
                  <path
                    d="M20 1.5c-9.66 0-17.5 7.6-17.5 17 0 7.02 4.02 12.06 8.2 16.86 2.1 2.42 4.28 4.86 6.02 7.62.72 1.14 1.28 2.02 3.28 2.02s2.56-.88 3.28-2.02c1.74-2.76 3.92-5.2 6.02-7.62 4.18-4.8 8.2-9.84 8.2-16.86 0-9.4-7.84-17-17.5-17z"
                    fill="var(--app-accent,#087ff5)"
                    stroke="#ffffff"
                    strokeWidth="2.5"
                  />
                  {/* Inner dot */}
                  <circle cx="20" cy="18.5" r="6.2" fill="#ffffff" />
                  <circle
                    cx="20"
                    cy="18.5"
                    r="3"
                    fill="var(--app-accent,#087ff5)"
                  />
                </svg>
                {/* Ground shadow under the tip */}
                <span
                  className={cn(
                    "mt-[1px] rounded-full bg-black/45 blur-[2px] transition-all duration-150",
                    dragging
                      ? "h-[5px] w-[10px] opacity-35"
                      : "h-[6px] w-[14px] opacity-55",
                  )}
                />
              </div>
            </div>

            {onLocateMe ? (
              <button
                type="button"
                onClick={() => void handleLocateMe()}
                disabled={locating}
                aria-label="Use my current location"
                className="press-scale absolute bottom-3 right-3 flex h-11 w-11 items-center justify-center rounded-full bg-white text-[color:var(--app-accent-deep,#0b62c4)] shadow-[0_4px_14px_rgba(16,24,40,0.22)] disabled:opacity-60 dark:bg-[#1c2430] dark:text-[#9bc7f5]"
              >
                {locating ? (
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                ) : (
                  <Crosshair
                    className="h-5 w-5"
                    strokeWidth={2.2}
                    aria-hidden
                  />
                )}
              </button>
            ) : null}
          </>
        )}
      </div>

      <p className="text-[12px] leading-[1.45] text-[#5b6472] dark:text-[#9aa6b6]">
        {accuracyHint}
      </p>

      {locationError ? (
        <p
          role="status"
          className="rounded-xl bg-[#fff4ed] px-3 py-2 text-[12px] font-medium leading-[1.4] text-[#b54708] dark:bg-[#7a2e0e]/20 dark:text-[#fdb022]"
        >
          {locationError}
        </p>
      ) : null}

      {!embedded ? (
        <div
          aria-live="polite"
          className="flex items-start gap-2 rounded-2xl bg-[#f4f6fa] px-3.5 py-3 dark:bg-white/[0.05]"
        >
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-[color:var(--app-accent,#087ff5)] shadow-sm dark:bg-[#1c2430]">
            <MapPin className="h-4 w-4" strokeWidth={2.4} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-normal leading-[18px] tracking-normal text-[#8b93a1] dark:text-[#7f8a99]">
              Selected spot
            </p>
            {resolving ? (
              <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-[#5b6472] dark:text-[#9aa6b6]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Finding this address…
              </span>
            ) : (
              <p className="mt-0.5 text-[14px] font-semibold text-[#111827] dark:text-[#e9eef7]">
                {address ||
                  (unavailable
                    ? "Captured point ready"
                    : hasInteracted
                      ? "Address not found — add details on the next step"
                      : "Move the map to choose a place")}
              </p>
            )}
          </div>
        </div>
      ) : null}

      {!embedded ? (
        <div className="flex flex-col gap-2.5 bg-background pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!canConfirm}
            aria-describedby={
              unavailable ? mapUnavailableDescriptionId : undefined
            }
            className={cn(
              "press-scale flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[16px] font-bold transition-colors disabled:cursor-not-allowed",
              // Blue means "this will take you forward". While the pin is still
              // settling or its address is still resolving it cannot, so it does
              // not get to look like it can -- a dimmed blue button still reads
              // as the live primary action and invites a dead tap.
              canConfirm
                ? "bg-[color:var(--app-accent,#087ff5)] text-[color:var(--app-accent-fg,#ffffff)] hover:bg-[color:var(--app-accent-hover,#0b62c4)]"
                : "bg-[#e6e9ef] text-[#98a1ae] dark:bg-white/[0.08] dark:text-[#6d7787]",
            )}
          >
            <Check className="h-5 w-5" strokeWidth={2.6} aria-hidden />
            {unavailable ? "Use captured point" : confirmLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="h-11 w-full rounded-full text-[15px] font-semibold text-[#6b7280] transition-colors hover:text-[#374151] dark:text-[#9aa6b6] dark:hover:text-[#c4cdda]"
          >
            {cancelLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
