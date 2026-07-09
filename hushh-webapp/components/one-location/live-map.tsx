"use client";

import { useEffect, useRef, useState } from "react";

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

// In iframe-fallback mode (Maps JS unavailable — e.g. the iOS App:// WebView)
// every src change reloads the whole embed, a visible flash. So we only recenter
// the embed once the point has moved a meaningful distance: stationary stays put
// (no flashing), and movement recenters occasionally instead of on every fix.
// The interactive JS map path is unaffected — it glides smoothly on every point.
const IFRAME_RECENTER_METERS = 50;

export interface LiveMapProps {
  point: PlainLocationPoint;
  className?: string;
}

export function LiveMap({ point, className }: LiveMapProps) {
  const { status } = useGoogleMaps();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
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
  useEffect(() => {
    if (status !== "ready" || !containerRef.current || mapRef.current) return;
    const map = new google.maps.Map(containerRef.current, {
      center: target,
      zoom: 16,
      disableDefaultUI: true,
      clickableIcons: false,
    });
    mapRef.current = map;
    markerRef.current = new google.maps.Marker({ map, position: target });
    // Created once; subsequent movement handled by the glide effect below.
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

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

  // Not ready (loading or error / no key) -> keep today's iframe embed.
  if (status !== "ready") {
    return (
      <iframe
        title="Live location map preview"
        src={googleMapsLocationEmbedUrl(iframePoint)}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        allowFullScreen
        className={cn("h-full w-full border-0", className)}
      />
    );
  }

  return <div ref={containerRef} className={cn("h-full w-full", className)} />;
}
