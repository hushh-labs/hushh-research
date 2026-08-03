"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Check, Crosshair, Loader2, MapPin, X } from "lucide-react";

import { useGoogleMaps } from "@/lib/one-location/use-google-maps";
import { cn } from "@/lib/utils";

export type PickedLocation = {
  latitude: number;
  longitude: number;
  address: string | null;
};

export interface LocationPickerMapProps {
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
  /** Dismiss the map without changing the captured point. */
  onCancel: () => void;
  /** Google Maps may initialize only after this explicit renderer disclosure. */
  rendererDisclosureAccepted?: boolean;
  /** Persist or session-acknowledge the shared renderer disclosure. */
  onAcceptRendererDisclosure: () => Promise<void>;
  confirmLabel?: string;
  cancelLabel?: string;
  className?: string;
}

const PIN_REVERSE_GEOCODE_DEBOUNCE_MS = 350;

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
 */
export function LocationPickerMap({
  initialLatitude,
  initialLongitude,
  initialAddress = null,
  initialAccuracyM = null,
  reverseGeocode,
  onLocateMe,
  onConfirm,
  onCancel,
  rendererDisclosureAccepted = false,
  onAcceptRendererDisclosure,
  confirmLabel = "Confirm location",
  cancelLabel = "Cancel",
  className,
}: LocationPickerMapProps) {
  const { status } = useGoogleMaps({ enabled: rendererDisclosureAccepted });
  const { resolvedTheme } = useTheme();
  const colorScheme = resolvedTheme === "dark" ? "DARK" : "LIGHT";

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
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
  const [acceptingRenderer, setAcceptingRenderer] = useState(false);
  const [rendererError, setRendererError] = useState<string | null>(null);

  useEffect(() => {
    if (hasInteractedRef.current) return;
    setAddress((initialAddress && initialAddress.trim()) || null);
  }, [initialAddress]);

  const reverseGeocodeInBrowser = useCallback(
    async (lat: number, lng: number): Promise<string | null> => {
      if (typeof google === "undefined" || !google.maps.Geocoder) return null;
      const geocoder = geocoderRef.current ?? new google.maps.Geocoder();
      geocoderRef.current = geocoder;
      const response = await geocoder.geocode({ location: { lat, lng } });
      return response.results[0]?.formatted_address?.trim() || null;
    },
    [],
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

  // Build the interactive map once the API is ready. Google applies colorScheme
  // only at construction, so the container is keyed by scheme to force a fresh
  // node when the theme flips.
  useEffect(() => {
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
  }, [status, colorScheme]);

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
        const map = mapRef.current;
        if (map) {
          map.panTo({ lat: fix.latitude, lng: fix.longitude });
          map.setZoom(17);
        } else {
          scheduleResolve(fix.latitude, fix.longitude);
        }
      } else {
        setLocationError(
          "Current location is unavailable. Keep the pin here or move the map manually.",
        );
      }
    } catch {
      setLocationError(
        "Current location is unavailable. Keep the pin here or move the map manually.",
      );
    } finally {
      setLocating(false);
    }
  }, [locating, onLocateMe, scheduleResolve]);

  const handleConfirm = useCallback(() => {
    const { lat, lng } = centerRef.current;
    if (!isValidCoordinate(lat, lng)) return;
    onConfirm({ latitude: lat, longitude: lng, address });
  }, [address, onConfirm]);

  const handleAcceptRendererDisclosure = useCallback(async () => {
    if (acceptingRenderer) return;
    setAcceptingRenderer(true);
    setRendererError(null);
    try {
      await onAcceptRendererDisclosure();
    } catch {
      setRendererError(
        "Google Maps could not be prepared. Try again or skip this step.",
      );
    } finally {
      setAcceptingRenderer(false);
    }
  }, [acceptingRenderer, onAcceptRendererDisclosure]);

  const unavailable = status === "error";
  const accuracyHint = unavailable
    ? "Review the captured point, then complete the address details on the next step."
    : typeof initialAccuracyM === "number" && Number.isFinite(initialAccuracyM)
      ? initialAccuracyM <= 20
        ? "GPS gave us a strong starting point. Confirm the entrance yourself."
        : initialAccuracyM <= 75
          ? "GPS is only a starting point. Check the pin before continuing."
          : "GPS is approximate here. Move the pin carefully to your entrance."
      : "Move the map so the pin tip sits on your entrance.";

  if (!rendererDisclosureAccepted) {
    return (
      <div
        className={cn("flex flex-col gap-4", className)}
        data-testid="saved-location-map-disclosure"
      >
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-semibold text-[#374151] dark:text-[#c4cdda]">
            Before the map opens
          </p>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close map"
            className="press-scale flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.05] text-[#4b5563] transition-colors hover:bg-black/[0.08] dark:bg-white/[0.08] dark:text-[#aeb8c7]"
          >
            <X className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>

        <section className="rounded-3xl border border-black/[0.07] bg-[#f4f6fa] p-5 dark:border-white/[0.08] dark:bg-white/[0.05]">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-[color:var(--app-accent,#087ff5)] shadow-sm dark:bg-[#1c2430]">
            <MapPin className="h-5 w-5" strokeWidth={2.3} aria-hidden />
          </span>
          <h3 className="mt-4 text-[20px] font-bold leading-tight text-[#111827] dark:text-[#f4f7fb]">
            Adjust your entrance with Google Maps
          </h3>
          <p className="mt-2 text-[14px] leading-6 text-[#5b6472] dark:text-[#9aa6b6]">
            Google Maps receives the selected point after you continue so it can
            draw the map and suggest an address. Opening the map does not share
            this point with nearby people; any later location sharing still
            needs your approval.
          </p>
        </section>

        {rendererError ? (
          <p
            role="alert"
            className="rounded-xl bg-[#fff1f0] px-3 py-2 text-[12px] font-medium text-[#b42318] dark:bg-[#7a271a]/20 dark:text-[#ff9b91]"
          >
            {rendererError}
          </p>
        ) : null}

        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => void handleAcceptRendererDisclosure()}
            disabled={acceptingRenderer}
            className="press-scale flex h-[52px] w-full items-center justify-center gap-2 rounded-full bg-[color:var(--app-accent,#087ff5)] text-[16px] font-bold text-[color:var(--app-accent-fg,#ffffff)] transition-colors hover:bg-[color:var(--app-accent-hover,#0b62c4)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {acceptingRenderer ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            ) : (
              <MapPin className="h-5 w-5" strokeWidth={2.4} aria-hidden />
            )}
            Use Google Maps
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={acceptingRenderer}
            className="h-11 w-full rounded-full text-[15px] font-semibold text-[#6b7280] transition-colors hover:text-[#374151] disabled:opacity-50 dark:text-[#9aa6b6] dark:hover:text-[#c4cdda]"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold text-[#374151] dark:text-[#c4cdda]">
          Pin your entrance on the map
        </p>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close map"
          className="press-scale flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.05] text-[#4b5563] transition-colors hover:bg-black/[0.08] dark:bg-white/[0.08] dark:text-[#aeb8c7]"
        >
          <X className="h-4 w-4" strokeWidth={2.4} />
        </button>
      </div>

      <div className="relative h-[min(48vh,340px)] w-full overflow-hidden rounded-2xl border border-black/[0.08] bg-[#eef2f7] dark:border-white/[0.1] dark:bg-[#10151d]">
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
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[#5b6472] dark:text-[#9aa6b6]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading
            map…
          </div>
        ) : (
          <>
            <div
              key={colorScheme}
              ref={containerRef}
              className="h-full w-full"
            />

            {/* Fixed centre pin — the map moves beneath it, so the pin always
                marks the chosen coordinate. */}
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
              aria-hidden="true"
            >
              {/* Offset up by half the pin height so the pin TIP (not its centre)
                  marks the exact map centre; lift a little more while dragging. */}
              <div
                className={cn(
                  "flex flex-col items-center transition-transform duration-150 ease-out",
                  dragging ? "-translate-y-[26px]" : "-translate-y-[20px]",
                )}
              >
                <MapPin
                  className="h-9 w-9 text-[color:var(--app-accent,#087ff5)] drop-shadow-[0_6px_8px_rgba(8,127,245,0.35)]"
                  strokeWidth={2.4}
                  fill="currentColor"
                  fillOpacity={0.18}
                />
                <span
                  className={cn(
                    "mt-0.5 h-2 w-2 rounded-full bg-black/40 blur-[1px] transition-all duration-150",
                    dragging ? "scale-75 opacity-40" : "scale-100 opacity-60",
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

      <div
        aria-live="polite"
        className="flex items-start gap-2 rounded-2xl bg-[#f4f6fa] px-3.5 py-3 dark:bg-white/[0.05]"
      >
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-[color:var(--app-accent,#087ff5)] shadow-sm dark:bg-[#1c2430]">
          <MapPin className="h-4 w-4" strokeWidth={2.4} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[#8b93a1] dark:text-[#7f8a99]">
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

      <div className="flex flex-col gap-2.5">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={status === "loading" || dragging || resolving || locating}
          aria-describedby={
            unavailable ? mapUnavailableDescriptionId : undefined
          }
          className={cn(
            "press-scale flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[16px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-45",
            "bg-[color:var(--app-accent,#087ff5)] text-[color:var(--app-accent-fg,#ffffff)] hover:bg-[color:var(--app-accent-hover,#0b62c4)]",
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
    </div>
  );
}
