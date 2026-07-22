"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { MapPin } from "lucide-react";

import { liveFreshness } from "@/lib/one-location/freshness";
import { useGoogleMaps } from "@/lib/one-location/use-google-maps";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import { cn } from "@/lib/utils";

const LIVE_THRESHOLD_MS = 90_000;

export type FriendsMapEntry = {
  id: string;
  name: string;
  point: PlainLocationPoint;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
}

export function FriendsMap({ entries }: { entries: FriendsMapEntry[] }) {
  const { status } = useGoogleMaps();
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const [selectedId, setSelectedId] = useState(entries[0]?.id ?? "");
  const colorScheme = resolvedTheme === "dark" ? "DARK" : "LIGHT";

  useEffect(() => {
    if (!entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(entries[0]?.id ?? "");
    }
  }, [entries, selectedId]);

  useEffect(() => {
    if (status !== "ready" || !containerRef.current) return;
    const map = new google.maps.Map(containerRef.current, {
      center: { lat: 0, lng: 0 },
      zoom: 2,
      disableDefaultUI: true,
      clickableIcons: false,
      colorScheme,
    });
    mapRef.current = map;
    return () => {
      markersRef.current.forEach((marker) => marker.setMap(null));
      markersRef.current = [];
      mapRef.current = null;
    };
  }, [colorScheme, status]);

  useEffect(() => {
    const map = mapRef.current;
    if (status !== "ready" || !map || !entries.length) return;
    markersRef.current.forEach((marker) => marker.setMap(null));
    const bounds = new google.maps.LatLngBounds();
    const accentColor = getComputedStyle(document.documentElement)
      .getPropertyValue("--app-accent")
      .trim();
    markersRef.current = entries.map((entry) => {
      const position = {
        lat: entry.point.latitude,
        lng: entry.point.longitude,
      };
      bounds.extend(position);
      const marker = new google.maps.Marker({
        map,
        position,
        title: entry.name,
        label: {
          text: initials(entry.name),
          color: "#ffffff",
          fontSize: "11px",
          fontWeight: "700",
        },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: entry.id === selectedId ? accentColor : "#5b6472",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 3,
          scale: entry.id === selectedId ? 20 : 17,
        },
      });
      marker.addListener("click", () => setSelectedId(entry.id));
      return marker;
    });
    if (entries.length === 1) {
      map.setCenter(bounds.getCenter());
      map.setZoom(15);
    } else {
      map.fitBounds(bounds, 44);
    }
  }, [entries, selectedId, status]);

  const selected = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? entries[0],
    [entries, selectedId],
  );

  if (!entries.length) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center bg-black/[0.035] px-8 text-center dark:bg-white/[0.04]">
        <div>
          <MapPin className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-3 text-[15px] font-semibold text-foreground">
            No connections are sharing right now
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Friends appear here automatically when they become visible to
            connections.
          </p>
        </div>
      </div>
    );
  }

  const freshness = selected
    ? liveFreshness(selected.point.capturedAt, Date.now(), LIVE_THRESHOLD_MS)
    : null;

  return (
    <div>
      <div className="relative aspect-[4/3] overflow-hidden bg-[#e8edf2] dark:bg-[#15171a]">
        {status === "ready" ? (
          <div key={colorScheme} ref={containerRef} className="h-full w-full" />
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center">
            <p className="text-[13px] font-medium text-muted-foreground">
              Map unavailable. Live connections remain available below.
            </p>
          </div>
        )}
      </div>
      <div className="flex gap-2 overflow-x-auto p-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {entries.map((entry) => {
          const active = entry.id === selected?.id;
          const entryFreshness = liveFreshness(
            entry.point.capturedAt,
            Date.now(),
            LIVE_THRESHOLD_MS,
          );
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSelectedId(entry.id)}
              className={cn(
                "flex min-w-[150px] items-center gap-2 rounded-xl border px-3 py-2 text-left",
                active
                  ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)]/[0.06]"
                  : "border-border/70",
              )}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent)] text-[11px] font-bold text-[color:var(--app-accent-fg)]">
                {initials(entry.name)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-foreground">
                  {entry.name}
                </span>
                <span
                  className={cn(
                    "block text-[11px]",
                    entryFreshness.state === "live"
                      ? "text-emerald-600"
                      : "text-amber-600",
                  )}
                >
                  {entryFreshness.state === "live"
                    ? `Live - ${entryFreshness.agoLabel}`
                    : `Last seen ${entryFreshness.agoLabel}`}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {freshness?.state === "paused" ? (
        <p className="px-3 pb-3 text-[12px] text-amber-600">
          This is a last known location, not a live position.
        </p>
      ) : null}
    </div>
  );
}
