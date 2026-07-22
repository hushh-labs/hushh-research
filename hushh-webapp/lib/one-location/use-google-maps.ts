"use client";

import { useEffect, useState } from "react";
import { Loader } from "@googlemaps/js-api-loader";

import { getBrowserMapsApiKey } from "@/lib/one-location/maps-config";

export type MapsLoadStatus = "loading" | "ready" | "error";

declare global {
  interface Window {
    gm_authFailure?: () => void;
  }
}

// Module-level singleton so the Maps script is requested at most once per page,
// no matter how many <LiveMap> instances mount.
let loadPromise: Promise<void> | null = null;

// Google Maps JS calls window.gm_authFailure when the key is rejected AFTER the
// script has already loaded (e.g. RefererNotAllowedMapError inside the iOS
// `App://` WebView, billing disabled, invalid key). The script load itself
// succeeds, so this is the ONLY signal for that failure class. We flip a module
// flag and notify hooks so every <LiveMap> degrades to the iframe fallback
// instead of showing Google's gray error overlay.
let authFailed = false;
const authListeners = new Set<() => void>();

function installAuthFailureHandler(): void {
  if (typeof window === "undefined") return;
  const previous = window.gm_authFailure;
  window.gm_authFailure = () => {
    authFailed = true;
    authListeners.forEach((listener) => listener());
    previous?.();
  };
}

function loadGoogleMaps(): Promise<void> {
  if (loadPromise) return loadPromise;
  const apiKey = getBrowserMapsApiKey();
  if (!apiKey) {
    loadPromise = Promise.reject(new Error("maps-not-configured"));
    return loadPromise;
  }
  installAuthFailureHandler();
  const loader = new Loader({ apiKey, version: "weekly" });
  loadPromise = Promise.all([
    loader.importLibrary("maps"),
    loader.importLibrary("marker"),
  ]).then(() => undefined);
  return loadPromise;
}

export function useGoogleMaps({ enabled = true }: { enabled?: boolean } = {}): {
  status: MapsLoadStatus;
} {
  const [status, setStatus] = useState<MapsLoadStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    if (!enabled) return;

    // A prior map instance may have already tripped auth failure.
    if (authFailed) {
      setStatus("error");
      return;
    }

    const onAuthFailure = () => {
      if (!cancelled) setStatus("error");
    };
    authListeners.add(onAuthFailure);

    loadGoogleMaps()
      .then(() => {
        if (!cancelled && !authFailed) setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      authListeners.delete(onAuthFailure);
    };
  }, [enabled]);

  return { status };
}

/** Test-only: clears the module singleton + auth state so each case starts fresh. */
export function __resetGoogleMapsLoaderForTests(): void {
  loadPromise = null;
  authFailed = false;
  authListeners.clear();
  if (typeof window !== "undefined") {
    delete window.gm_authFailure;
  }
}
