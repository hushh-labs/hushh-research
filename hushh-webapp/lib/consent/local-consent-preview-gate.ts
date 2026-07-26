"use client";

import { resolveAppEnvironment } from "@/lib/app-env";

const LOCAL_PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PREVIEW_QUERY_VALUE = "consent";
const PREVIEW_DISABLE_QUERY_VALUE = "live";
const PREVIEW_SESSION_KEY = "hushh.local-consent-preview.v2";
const CONSENT_CENTER_PATH = "/one/consent";
const CONNECTION_SURFACE_ALIASES = new Set(["connections", "relationships"]);

interface SearchParamsLike {
  get(name: string): string | null;
}

export interface LocalConsentPreviewRequest {
  searchParams?: SearchParamsLike | null;
  hostname?: string | null;
  pathname?: string | null;
  protocol?: string | null;
  appEnvironment?: "development" | "uat" | "production";
  nodeEnvironment?: string | null;
  sessionPreview?: string | null;
}

function normalizeHost(hostname?: string | null) {
  const unwrapped = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return unwrapped.includes(":") ? unwrapped : unwrapped.replace(/:\d+$/, "");
}

function targetsPreviewSurface(searchParams?: SearchParamsLike | null) {
  if (searchParams?.get("mode") === "connections") return false;
  if (CONNECTION_SURFACE_ALIASES.has(searchParams?.get("tab") || ""))
    return false;
  return !CONNECTION_SURFACE_ALIASES.has(searchParams?.get("view") || "");
}

/**
 * Fail-closed boundary for the deterministic Consent Center layout fixture.
 *
 * The fixture must never replace real network calls outside the exact local
 * Consent Center route, on native Capacitor origins, in production bundles, or
 * while the Connections tab is active.
 */
export function isLocalConsentPreviewRequest({
  searchParams,
  hostname,
  pathname,
  protocol,
  appEnvironment = resolveAppEnvironment(),
  nodeEnvironment = process.env.NODE_ENV,
  sessionPreview,
}: LocalConsentPreviewRequest): boolean {
  if (nodeEnvironment !== "development") return false;
  if (appEnvironment !== "development") return false;
  if (protocol !== "http:" && protocol !== "https:") return false;
  if (!LOCAL_PREVIEW_HOSTS.has(normalizeHost(hostname))) return false;
  if (pathname !== CONSENT_CENTER_PATH) return false;
  if (!targetsPreviewSurface(searchParams)) return false;

  const requestedPreview = searchParams?.get("preview");
  if (requestedPreview === PREVIEW_DISABLE_QUERY_VALUE) return false;
  return (
    requestedPreview === PREVIEW_QUERY_VALUE ||
    sessionPreview === PREVIEW_QUERY_VALUE
  );
}

export function isLocalConsentPreviewRuntime(): boolean {
  if (typeof window === "undefined") return false;
  let sessionPreview: string | null = null;
  try {
    sessionPreview = window.sessionStorage.getItem(PREVIEW_SESSION_KEY);
  } catch {
    // The explicit query remains sufficient in hardened browser contexts.
  }

  return isLocalConsentPreviewRequest({
    searchParams: new URLSearchParams(window.location.search),
    hostname: window.location.hostname,
    pathname: window.location.pathname,
    protocol: window.location.protocol,
    sessionPreview,
  });
}

export function syncLocalConsentPreviewSession(): boolean {
  if (typeof window === "undefined") return false;
  const searchParams = new URLSearchParams(window.location.search);
  const requestedPreview = searchParams.get("preview");

  if (requestedPreview === PREVIEW_DISABLE_QUERY_VALUE) {
    try {
      window.sessionStorage.removeItem(PREVIEW_SESSION_KEY);
    } catch {
      // The explicit live-data query remains authoritative without storage.
    }
    return false;
  }

  let sessionPreview: string | null = null;
  try {
    sessionPreview = window.sessionStorage.getItem(PREVIEW_SESSION_KEY);
  } catch {
    // Query-based preview still works when sessionStorage is unavailable.
  }

  const enabled = isLocalConsentPreviewRequest({
    searchParams,
    hostname: window.location.hostname,
    pathname: window.location.pathname,
    protocol: window.location.protocol,
    sessionPreview,
  });
  if (!enabled) return false;

  try {
    window.sessionStorage.setItem(PREVIEW_SESSION_KEY, PREVIEW_QUERY_VALUE);
  } catch {
    // Query-based preview still works when sessionStorage is unavailable.
  }
  return true;
}

export async function loadLocalConsentPreviewModule() {
  // Keep the large fixture off the production execution and initial-loading
  // paths. It remains a separate lazy chunk and is never fetched unless the
  // strict development-only runtime gate below succeeds.
  if (process.env.NODE_ENV !== "development") return null;
  if (!isLocalConsentPreviewRuntime()) return null;
  return import("@/lib/consent/local-consent-preview");
}
