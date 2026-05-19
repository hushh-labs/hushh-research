"use client";

import { ApiService } from "@/lib/services/api-service";

import { createLocationPointFromPosition } from "./contract";
import type {
  LocationAccessRequest,
  LocationAccessRequestResponse,
  LocationContact,
  LocationContactTier,
  LocationCreateShareResponse,
  LocationHeartbeatResult,
  LocationLatestPoint,
  LocationOwnerState,
  LocationPublicView,
  LocationShare,
  LocationUpdateSession,
} from "./types";

const DEFAULT_WATCH_INTERVAL_MS = 30_000;
export const DEFAULT_PUBLIC_LIVE_POLL_INTERVAL_MS = 10_000;
let activeWatchId: number | null = null;
let activeLastSentAt = 0;

export class LocationSharingApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status: number; code: string }) {
    super(message);
    this.name = "LocationSharingApiError";
    this.status = options.status;
    this.code = options.code;
  }
}

function authHeaders(vaultOwnerToken: string): HeadersInit {
  return {
    ...ApiService.getAuthHeaders(vaultOwnerToken),
    "Content-Type": "application/json",
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "detail" in payload
        ? (payload as { detail?: unknown }).detail
        : null;
    const detailText = typeof detail === "string" ? detail : null;
    const topLevelMessage =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message || "")
        : "";
    const plainBackendNotFound =
      response.status === 404 && detailText?.trim().toLowerCase() === "not found";
    const code =
      plainBackendNotFound
        ? "LOCATION_API_NOT_DEPLOYED"
        : detailText
          ? "LOCATION_REQUEST_FAILED"
          : topLevelMessage
            ? "LOCATION_UPSTREAM_UNAVAILABLE"
            : detail && typeof detail === "object" && "code" in detail
              ? String((detail as { code?: unknown }).code || "LOCATION_REQUEST_FAILED")
              : "LOCATION_REQUEST_FAILED";
    const message =
      plainBackendNotFound
        ? "KAI live location API is not available on the configured backend yet. Deploy the consent-protocol location routes and migration 060, then retry."
        : detailText ||
          topLevelMessage ||
          (detail && typeof detail === "object" && "message" in detail
            ? String((detail as { message?: unknown }).message || "Location request failed.")
            : "Location request failed.");
    throw new LocationSharingApiError(message, { status: response.status, code });
  }
  return payload as T;
}

export function getLocationSharingErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof LocationSharingApiError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

export function isLocationApiUnavailable(error: unknown): boolean {
  return (
    error instanceof LocationSharingApiError &&
    (error.code === "LOCATION_API_NOT_DEPLOYED" ||
      error.code === "LOCATION_UPSTREAM_UNAVAILABLE" ||
      error.status === 502 ||
      error.status === 504)
  );
}

export function buildSharedLocationUrl(token: string): string {
  const base =
    typeof window !== "undefined"
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  const path = `/location/shared?token=${encodeURIComponent(token)}`;
  return base ? `${base}${path}` : path;
}

export function buildLocationShareMessage(url: string): string {
  return `Here is my KAI live location link. It expires within 24 hours: ${url}`;
}

export function buildWhatsAppShareUrl(url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(buildLocationShareMessage(url))}`;
}

export async function copyLocationUrl(url: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }
  throw new LocationSharingApiError("Could not copy this location link.", {
    status: 0,
    code: "LOCATION_COPY_UNAVAILABLE",
  });
}

export function buildMapsUrls(point: Pick<LocationLatestPoint, "latitude" | "longitude">) {
  const coordinate = `${point.latitude},${point.longitude}`;
  return {
    google: `https://www.google.com/maps?q=${encodeURIComponent(coordinate)}`,
    apple: `https://maps.apple.com/?ll=${encodeURIComponent(coordinate)}&q=${encodeURIComponent(
      "KAI shared location"
    )}`,
    osmEmbed: buildOpenStreetMapEmbedUrl(point),
  };
}

export function buildOpenStreetMapEmbedUrl(
  point: Pick<LocationLatestPoint, "latitude" | "longitude">
): string {
  const delta = 0.01;
  const minLng = point.longitude - delta;
  const minLat = point.latitude - delta;
  const maxLng = point.longitude + delta;
  const maxLat = point.latitude + delta;
  const bbox = `${minLng},${minLat},${maxLng},${maxLat}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(
    bbox
  )}&layer=mapnik&marker=${encodeURIComponent(`${point.latitude},${point.longitude}`)}`;
}

export async function getFreshLocationPoint(): Promise<LocationLatestPoint> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    throw new LocationSharingApiError("This device does not expose browser GPS.", {
      status: 0,
      code: "GEOLOCATION_UNAVAILABLE",
    });
  }

  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15_000,
    });
  });

  return createLocationPointFromPosition(position, "web");
}

export async function shareOrCopyLocationUrl(url: string): Promise<"shared" | "copied"> {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      await navigator.share({
        title: "KAI live location",
        text: buildLocationShareMessage(url),
        url,
      });
      return "shared";
    }
  } catch {
    // Clipboard fallback below keeps restricted browser surfaces usable.
  }

  try {
    await copyLocationUrl(url);
    return "copied";
  } catch {
    throw new LocationSharingApiError("Could not share or copy this location link.", {
      status: 0,
      code: "LOCATION_SHARE_UNAVAILABLE",
    });
  }
}

export const KaiLocationSharingService = {
  async getOwnerState(vaultOwnerToken: string): Promise<LocationOwnerState> {
    const response = await ApiService.apiFetch("/api/kai/location/state", {
      headers: authHeaders(vaultOwnerToken),
    });
    return readJson<LocationOwnerState>(response);
  },

  async createContact(options: {
    vaultOwnerToken: string;
    displayName: string;
    tier: LocationContactTier;
    autoApprove: boolean;
  }): Promise<LocationContact> {
    const response = await ApiService.apiFetch("/api/kai/location/contacts", {
      method: "POST",
      headers: authHeaders(options.vaultOwnerToken),
      body: JSON.stringify({
        displayName: options.displayName,
        tier: options.tier,
        autoApprove: options.tier === "family" && options.autoApprove,
      }),
    });
    const payload = await readJson<{ contact: LocationContact }>(response);
    return payload.contact;
  },

  async updateContact(options: {
    vaultOwnerToken: string;
    contactId: string;
    displayName?: string;
    autoApprove?: boolean;
  }): Promise<LocationContact> {
    const response = await ApiService.apiFetch(
      `/api/kai/location/contacts/${encodeURIComponent(options.contactId)}`,
      {
        method: "PATCH",
        headers: authHeaders(options.vaultOwnerToken),
        body: JSON.stringify({
          displayName: options.displayName,
          autoApprove: options.autoApprove,
        }),
      }
    );
    const payload = await readJson<{ contact: LocationContact }>(response);
    return payload.contact;
  },

  async revokeContact(options: {
    vaultOwnerToken: string;
    contactId: string;
  }): Promise<LocationContact> {
    const response = await ApiService.apiFetch(
      `/api/kai/location/contacts/${encodeURIComponent(options.contactId)}`,
      {
        method: "DELETE",
        headers: authHeaders(options.vaultOwnerToken),
      }
    );
    const payload = await readJson<{ contact: LocationContact }>(response);
    return payload.contact;
  },

  async createShare(options: {
    vaultOwnerToken: string;
    contactId: string;
    point: LocationLatestPoint;
    durationHours?: number;
    liveMode?: boolean;
  }): Promise<LocationCreateShareResponse> {
    const response = await ApiService.apiFetch("/api/kai/location/shares", {
      method: "POST",
      headers: authHeaders(options.vaultOwnerToken),
      body: JSON.stringify({
        contactId: options.contactId,
        point: options.point,
        durationHours: options.durationHours ?? 24,
        liveMode: options.liveMode ?? true,
      }),
    });
    return readJson<LocationCreateShareResponse>(response);
  },

  async revokeShare(options: {
    vaultOwnerToken: string;
    shareId: string;
  }): Promise<LocationShare> {
    const response = await ApiService.apiFetch(
      `/api/kai/location/shares/${encodeURIComponent(options.shareId)}`,
      {
        method: "DELETE",
        headers: authHeaders(options.vaultOwnerToken),
      }
    );
    const payload = await readJson<{ share: LocationShare }>(response);
    return payload.share;
  },

  async stopActiveShares(vaultOwnerToken: string): Promise<{
    shares: LocationShare[];
    stoppedCount: number;
  }> {
    const response = await ApiService.apiFetch("/api/kai/location/shares/stop-active", {
      method: "POST",
      headers: authHeaders(vaultOwnerToken),
    });
    return readJson<{ shares: LocationShare[]; stoppedCount: number }>(response);
  },

  async approveAccessRequest(options: {
    vaultOwnerToken: string;
    requestId: string;
  }): Promise<{ accessRequest: LocationAccessRequest; share: LocationShare }> {
    const response = await ApiService.apiFetch(
      `/api/kai/location/access-requests/${encodeURIComponent(options.requestId)}/approve`,
      {
        method: "POST",
        headers: authHeaders(options.vaultOwnerToken),
      }
    );
    return readJson<{ accessRequest: LocationAccessRequest; share: LocationShare }>(response);
  },

  async denyAccessRequest(options: {
    vaultOwnerToken: string;
    requestId: string;
  }): Promise<LocationAccessRequest> {
    const response = await ApiService.apiFetch(
      `/api/kai/location/access-requests/${encodeURIComponent(options.requestId)}/deny`,
      {
        method: "POST",
        headers: authHeaders(options.vaultOwnerToken),
      }
    );
    const payload = await readJson<{ accessRequest: LocationAccessRequest }>(response);
    return payload.accessRequest;
  },

  async issueUpdateSession(vaultOwnerToken: string): Promise<LocationUpdateSession> {
    const response = await ApiService.apiFetch("/api/kai/location/update-sessions", {
      method: "POST",
      headers: authHeaders(vaultOwnerToken),
    });
    return readJson<LocationUpdateSession>(response);
  },

  async updateLocationWithSession(options: {
    updateToken: string;
    point: LocationLatestPoint;
  }): Promise<LocationHeartbeatResult> {
    const response = await ApiService.apiFetch("/api/kai/location/updates", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.updateToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ point: options.point }),
    });
    return readJson<LocationHeartbeatResult>(response);
  },

  async resolvePublicShare(token: string): Promise<LocationPublicView> {
    const response = await ApiService.apiFetch(
      `/api/kai/location/shared?token=${encodeURIComponent(token)}`
    );
    return readJson<LocationPublicView>(response);
  },

  async requestAccess(options: {
    token: string;
    requesterLabel?: string;
    requesterMessage?: string;
  }): Promise<LocationAccessRequestResponse> {
    const response = await ApiService.apiFetch("/api/kai/location/shared/access-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    return readJson<LocationAccessRequestResponse>(response);
  },

  async startLiveUpdates(options: {
    updateToken: string;
    endpointPath?: string;
    intervalMs?: number;
  }): Promise<{ active: boolean; mode: "web" }> {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      throw new LocationSharingApiError("This browser does not expose GPS updates.", {
        status: 0,
        code: "GEOLOCATION_UNAVAILABLE",
      });
    }

    await this.stopLiveUpdates();

    const intervalMs = Math.max(options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS, 10_000);
    activeLastSentAt = 0;
    activeWatchId = navigator.geolocation.watchPosition(
      (position) => {
        const now = Date.now();
        if (now - activeLastSentAt < intervalMs) return;
        activeLastSentAt = now;
        const point = createLocationPointFromPosition(position, "web");
        void this.updateLocationWithSession({
          updateToken: options.updateToken,
          point,
        }).catch(() => {
          void this.stopLiveUpdates();
        });
      },
      () => {
        void this.stopLiveUpdates();
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20_000,
      }
    );
    return {
      active: true,
      mode: "web",
    };
  },

  async stopLiveUpdates(): Promise<void> {
    if (typeof navigator !== "undefined" && activeWatchId !== null) {
      navigator.geolocation.clearWatch(activeWatchId);
    }
    activeWatchId = null;
    activeLastSentAt = 0;
  },
};
