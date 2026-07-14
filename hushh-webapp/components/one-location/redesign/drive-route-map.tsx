"use client";

/**
 * One Location redesign — interactive source → destination route map for the
 * Drive To flow. Reuses the shared useGoogleMaps() loader. When the JS SDK is
 * unavailable (iOS App:// WebView, missing key, auth failure) it degrades to a
 * keyless Google Maps directions iframe. Draws the real driving route via the
 * Directions API and falls back to a straight polyline if that request fails.
 */

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";

import { useGoogleMaps } from "@/lib/one-location/use-google-maps";
import { googleMapsDirectionsEmbedUrl } from "@/lib/one-location/maps-urls";
import type { LatLngLiteral } from "@/lib/one-location/marker-interpolation";
import type { DriveDestination, RouteEta } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

/** Google Maps JS API needs concrete colors; resolve the live accent token. */
function resolveAccentColor(): string {
  if (typeof window === "undefined") return "#007aff";
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--app-accent")
    .trim();
  return value || "#007aff";
}

export function driveBadgeText(eta: RouteEta): {
  primary: string;
  secondary: string;
} {
  const mins = Math.max(1, Math.round(eta.etaSeconds / 60));
  const km = (eta.distanceMeters / 1000).toFixed(1);
  const traffic = eta.trafficLevel ? ` · ${eta.trafficLevel} traffic` : "";
  return { primary: `${mins} min`, secondary: `${km} km${traffic}` };
}

function RouteBadge({
  primary,
  secondary,
}: {
  primary: string;
  secondary: string;
}) {
  return (
    <div className="pointer-events-none absolute right-3 top-3 rounded-[11px] bg-white/90 px-3 py-2 shadow-[rgba(0,0,0,0.22)_3px_5px_30px_0px] backdrop-blur">
      <div className="text-[19px] font-semibold leading-tight text-[#1d1d1f]">
        {primary}
      </div>
      <div className="text-xs text-black/50">{secondary}</div>
    </div>
  );
}

export interface DriveRouteMapProps {
  origin: LatLngLiteral;
  destination: DriveDestination;
  eta?: RouteEta | null;
  className?: string;
}

export function DriveRouteMap({
  origin,
  destination,
  eta,
  className,
}: DriveRouteMapProps) {
  const { status } = useGoogleMaps();
  const { resolvedTheme } = useTheme();
  // Follow the APP theme so the route map matches surrounding dark surfaces.
  const colorScheme = resolvedTheme === "dark" ? "DARK" : "LIGHT";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const routeRef = useRef<{ setMap: (map: google.maps.Map | null) => void } | null>(
    null,
  );

  const dest: LatLngLiteral = {
    lat: destination.latitude,
    lng: destination.longitude,
  };

  useEffect(() => {
    if (status !== "ready" || !containerRef.current) return;

    // Reuse the existing map across origin/destination changes (live location
    // moves often). Only build a new one if none exists or the previous map is
    // bound to a stale container node (e.g. after a ready→error→ready cycle or
    // a theme flip remounted the keyed div — colorScheme applies only at
    // construction).
    const existing = mapRef.current;
    const map =
      existing && existing.getDiv() === containerRef.current
        ? existing
        : new google.maps.Map(containerRef.current, {
            disableDefaultUI: true,
            clickableIcons: false,
            gestureHandling: "greedy",
            colorScheme,
          });
    mapRef.current = map;

    // Clear any overlays from a previous origin/destination.
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];
    if (routeRef.current) {
      routeRef.current.setMap(null);
      routeRef.current = null;
    }

    const accentColor = resolveAccentColor();
    const dot = (fill: string) => ({
      path: google.maps.SymbolPath.CIRCLE,
      scale: 7,
      fillColor: fill,
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 2.5,
    });
    markersRef.current.push(
      new google.maps.Marker({ map, position: origin, icon: dot(accentColor) }),
    );
    markersRef.current.push(
      new google.maps.Marker({ map, position: dest, icon: dot("#1d1d1f") }),
    );

    const bounds = new google.maps.LatLngBounds();
    bounds.extend(origin);
    bounds.extend(dest);
    map.fitBounds(bounds, 48);

    const renderer = new google.maps.DirectionsRenderer({
      map,
      suppressMarkers: true,
      preserveViewport: true,
      polylineOptions: {
        strokeColor: accentColor,
        strokeWeight: 4.5,
        strokeOpacity: 1,
      },
    });
    routeRef.current = renderer;
    const service = new google.maps.DirectionsService();
    let cancelled = false;
    service.route(
      {
        origin,
        destination: dest,
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (result, dirStatus) => {
        if (cancelled) return;
        if (dirStatus === google.maps.DirectionsStatus.OK && result) {
          renderer.setDirections(result);
        } else {
          renderer.setMap(null);
          routeRef.current = new google.maps.Polyline({
            map,
            path: [origin, dest],
            strokeColor: accentColor,
            strokeWeight: 4.5,
            strokeOpacity: 1,
          });
        }
      },
    );

    return () => {
      cancelled = true;
      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = [];
      if (routeRef.current) {
        routeRef.current.setMap(null);
        routeRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, origin.lat, origin.lng, dest.lat, dest.lng, colorScheme]);

  const badge = eta ? driveBadgeText(eta) : null;

  if (status !== "ready") {
    return (
      <div className={cn("relative", className)}>
        <iframe
          title="Drive route map preview"
          src={googleMapsDirectionsEmbedUrl(origin, dest)}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          className="h-full w-full border-0 dark:[filter:invert(0.9)_hue-rotate(180deg)_saturate(0.85)]"
        />
        {badge ? <RouteBadge {...badge} /> : null}
      </div>
    );
  }

  return (
    <div className={cn("relative", className)}>
      <div key={colorScheme} ref={containerRef} className="h-full w-full" />
      {badge ? <RouteBadge {...badge} /> : null}
    </div>
  );
}
