"use client";

import { useEffect, useState } from "react";
import { Loader } from "@googlemaps/js-api-loader";

import { getBrowserMapsApiKey } from "@/lib/one-location/maps-config";

export type MapsLoadStatus = "loading" | "ready" | "error";

// Module-level singleton so the Maps script is requested at most once per page,
// no matter how many <LiveMap> instances mount.
let loadPromise: Promise<void> | null = null;

function loadGoogleMaps(): Promise<void> {
  if (loadPromise) return loadPromise;
  const apiKey = getBrowserMapsApiKey();
  if (!apiKey) {
    loadPromise = Promise.reject(new Error("maps-not-configured"));
    return loadPromise;
  }
  const loader = new Loader({ apiKey, version: "weekly" });
  loadPromise = Promise.all([
    loader.importLibrary("maps"),
    loader.importLibrary("marker"),
  ]).then(() => undefined);
  return loadPromise;
}

export function useGoogleMaps(): { status: MapsLoadStatus } {
  const [status, setStatus] = useState<MapsLoadStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (!cancelled) setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { status };
}

/** Test-only: clears the module singleton so each case starts fresh. */
export function __resetGoogleMapsLoaderForTests(): void {
  loadPromise = null;
}
