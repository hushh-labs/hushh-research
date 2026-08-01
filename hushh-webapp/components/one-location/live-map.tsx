"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";

import {
  easeInOutQuad,
  haversineMeters,
  lerpLatLng,
  shouldSnap,
  type LatLngLiteral,
} from "@/lib/one-location/marker-interpolation";
import {
  approximateAreaMapZoom,
  googleMapsAreaEmbedUrl,
  googleMapsLocationEmbedUrl,
  locationLatLng,
} from "@/lib/one-location/maps-urls";
import { useGoogleMaps } from "@/lib/one-location/use-google-maps";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

// One glide should finish before the next ~5s poll lands.
const MARKER_ANIMATION_MS = 1200;

// In iframe-fallback mode (Maps JS unavailable — e.g. the iOS App:// WebView)
// every src change reloads the whole embed, a visible flash. So we only recenter
// the embed once the point has moved a meaningful distance: stationary stays put
// (no flashing), and movement recenters occasionally instead of on every fix.
// The interactive JS map path is unaffected — it glides smoothly on every point.
const IFRAME_RECENTER_METERS = 50;

export interface LiveMapProps {
  point: PlainLocationPoint;
  mode?: "precise" | "approximate";
  approximateRadiusM?: number;
  title?: string;
  className?: string;
}

export function LiveMap({
  point,
  mode = point.locationMode === "approximate" ? "approximate" : "precise",
  approximateRadiusM = point.approximateRadiusM ?? 1_000,
  title,
  className,
}: LiveMapProps) {
  const { status } = useGoogleMaps();
  const { resolvedTheme } = useTheme();
  // Follow the APP theme (next-themes class), not the OS scheme, so the map
  // matches the surrounding surfaces when the user overrides light/dark.
  const colorScheme = resolvedTheme === "dark" ? "DARK" : "LIGHT";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const circleRef = useRef<google.maps.Circle | null>(null);
  const frameRef = useRef<number | null>(null);

  const target: LatLngLiteral = locationLatLng(point);

  // The point the iframe embed is currently centered on. Updated lazily so tiny
  // GPS jitter / frequent fixes don't reload the embed on every render.
  const [iframePoint, setIframePoint] = useState(point);
  useEffect(() => {
    setIframePoint((current) =>
      haversineMeters(locationLatLng(current), locationLatLng(point)) >=
      IFRAME_RECENTER_METERS
        ? point
        : current,
    );
  }, [point]);

  // Create the map + marker once the API is ready and the container exists.
  // Google Maps applies colorScheme only at construction, so a theme flip
  // recreates the map (the container div is keyed by scheme below, giving a
  // fresh node; position is restored from the current target).
  useEffect(() => {
    if (status !== "ready" || !containerRef.current || mapRef.current) return;
    const map = new google.maps.Map(containerRef.current, {
      center: target,
      zoom:
        mode === "approximate"
          ? approximateAreaMapZoom(point, approximateRadiusM)
          : 16,
      disableDefaultUI: true,
      keyboardShortcuts: false,
      // Google Maps attribution, map-data credits, and Terms are provider-owned
      // legal UI. They must remain visible and must never be hidden or cropped.
      clickableIcons: false,
      colorScheme,
    });
    mapRef.current = map;
    if (mode === "approximate") {
      const accentColor =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--app-accent")
          .trim() || "blue";
      circleRef.current = new google.maps.Circle({
        map,
        center: target,
        radius: approximateRadiusM,
        strokeColor: accentColor,
        strokeOpacity: 0.72,
        strokeWeight: 2,
        fillColor: accentColor,
        fillOpacity: 0.18,
        clickable: false,
      });
    } else {
      markerRef.current = new google.maps.Marker({ map, position: target });
    }
    // Created once per scheme; movement handled by the glide effect below.
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, colorScheme, mode, approximateRadiusM]);

  // Glide the marker to each new point.
  useEffect(() => {
    if (status !== "ready") return;
    const marker = markerRef.current;
    const circle = circleRef.current;
    const map = mapRef.current;
    if (!map) return;
    if (mode === "approximate") {
      if (!circle) return;
      circle.setCenter(target);
      circle.setRadius(approximateRadiusM);
      map.panTo(target);
      return;
    }
    if (!marker) return;

    const current = marker.getPosition();
    const from: LatLngLiteral = current
      ? { lat: current.lat(), lng: current.lng() }
      : target;

    if (shouldSnap(from, target)) {
      marker.setPosition(target);
      map.panTo(target);
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / MARKER_ANIMATION_MS);
      marker.setPosition(lerpLatLng(from, target, easeInOutQuad(t)));
      if (t < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        map.panTo(target);
      }
    };
    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.lat, target.lng, status, mode, approximateRadiusM]);

  // Not ready (loading or error / no key) -> keep today's iframe embed. The
  // keyless embed has no dark mode, so dark theme applies an invert+hue-rotate
  // filter (standard technique) to keep the surface from glowing white.
  if (status !== "ready") {
    return (
      <div className={cn("relative h-full w-full", className)}>
        <iframe
          title={
            title ?? (mode === "approximate"
              ? "Approximate location area map preview"
              : "Live location map preview")
          }
          src={
            mode === "approximate"
              ? googleMapsAreaEmbedUrl(iframePoint, approximateRadiusM)
              : googleMapsLocationEmbedUrl(iframePoint)
          }
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
          className={cn(
            "h-full w-full border-0",
            "dark:[filter:invert(0.9)_hue-rotate(180deg)_saturate(0.85)]",
          )}
        />
        {mode === "approximate" ? (
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 h-32 w-32 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--app-accent)]/70 bg-[color:var(--app-accent)]/20 ring-[10px] ring-[color:var(--app-accent)]/10"
            aria-hidden="true"
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      key={`${colorScheme}-${mode}`}
      ref={containerRef}
      className={cn("h-full w-full", className)}
    />
  );
}
