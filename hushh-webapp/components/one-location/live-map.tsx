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
  googleMapsLocationEmbedUrl,
  locationLatLng,
} from "@/lib/one-location/maps-urls";
import { useGoogleMaps } from "@/lib/one-location/use-google-maps";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

// One glide should finish before the next ~5s poll lands.
const MARKER_ANIMATION_MS = 1200;
const DEFAULT_PREVIEW_ZOOM = 16;

// In iframe-fallback mode (Maps JS unavailable — e.g. the iOS App:// WebView)
// every src change reloads the whole embed, a visible flash. So we only recenter
// the embed once the point has moved a meaningful distance: stationary stays put
// (no flashing), and movement recenters occasionally instead of on every fix.
// The interactive JS map path is unaffected — it glides smoothly on every point.
const IFRAME_RECENTER_METERS = 50;

export interface LiveMapProps {
  point: PlainLocationPoint;
  className?: string;
  /**
   * Bump this only for an explicit user-requested refresh. Background point
   * updates keep the person's chosen zoom, while a manual refresh restores the
   * preview camera to the location marker.
   */
  viewportResetKey?: string | number;
}

export function LiveMap({ point, className, viewportResetKey }: LiveMapProps) {
  const { status } = useGoogleMaps();
  const { resolvedTheme } = useTheme();
  // Follow the APP theme (next-themes class), not the OS scheme, so the map
  // matches the surrounding surfaces when the user overrides light/dark.
  const colorScheme = resolvedTheme === "dark" ? "DARK" : "LIGHT";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const frameRef = useRef<number | null>(null);
  const resetPointRef = useRef(point);
  const lastViewportResetKeyRef = useRef(viewportResetKey);
  resetPointRef.current = point;

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

  // The iframe fallback cannot expose a camera API. A user-requested reset
  // therefore recenters its source point and remounts the iframe below. This is
  // deliberately separate from background GPS updates so stationary previews
  // do not flash every few seconds.
  useEffect(() => {
    setIframePoint(resetPointRef.current);
  }, [viewportResetKey]);

  // Create the map + marker once the API is ready and the container exists.
  // Google Maps applies colorScheme only at construction, so a theme flip
  // recreates the map (the container div is keyed by scheme below, giving a
  // fresh node; position is restored from the current target).
  useEffect(() => {
    if (status !== "ready" || !containerRef.current || mapRef.current) return;
    const map = new google.maps.Map(containerRef.current, {
      center: target,
      zoom: DEFAULT_PREVIEW_ZOOM,
      disableDefaultUI: true,
      keyboardShortcuts: false,
      // Google Maps attribution, map-data credits, and Terms are provider-owned
      // legal UI. They must remain visible and must never be hidden or cropped.
      clickableIcons: false,
      colorScheme,
    });
    mapRef.current = map;
    markerRef.current = new google.maps.Marker({ map, position: target });
    // Created once per scheme; movement handled by the glide effect below.
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, colorScheme]);

  // Glide the marker to each new point.
  useEffect(() => {
    if (status !== "ready") return;
    const marker = markerRef.current;
    const map = mapRef.current;
    if (!marker || !map) return;

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
  }, [target.lat, target.lng, status]);

  // A fresh reading can have the same coordinates as the previous one. Treat
  // the explicit reset key—not coordinate movement—as the signal to restore
  // the original marker-centered camera after the user has panned or zoomed.
  useEffect(() => {
    if (status !== "ready") return;
    if (Object.is(lastViewportResetKeyRef.current, viewportResetKey)) return;

    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;

    lastViewportResetKeyRef.current = viewportResetKey;
    const resetTarget = locationLatLng(resetPointRef.current);
    marker.setPosition(resetTarget);
    map.setZoom(DEFAULT_PREVIEW_ZOOM);
    map.panTo(resetTarget);
  }, [status, viewportResetKey]);

  // Not ready (loading or error / no key) -> keep today's iframe embed. The
  // keyless embed has no dark mode, so dark theme applies an invert+hue-rotate
  // filter (standard technique) to keep the surface from glowing white.
  if (status !== "ready") {
    return (
      <iframe
        key={`live-map-iframe:${viewportResetKey ?? "initial"}`}
        title="Live location map preview"
        src={googleMapsLocationEmbedUrl(iframePoint)}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        allowFullScreen
        className={cn(
          "h-full w-full border-0",
          "dark:[filter:invert(0.9)_hue-rotate(180deg)_saturate(0.85)]",
          className,
        )}
      />
    );
  }

  return (
    <div
      key={colorScheme}
      ref={containerRef}
      className={cn("h-full w-full", className)}
    />
  );
}
