"use client";

/**
 * Resilient client-side geofence monitor for One Location (US-027, US-034).
 *
 * Design:
 * - Armed rules live durably in Postgres (`one_location_geofence_rules`) and
 *   automatically re-arm across browser reloads.
 * - `saved_home` rules have NULL coordinates on the server; this monitor reads
 *   Home coordinates strictly inside client memory from encrypted PKM
 *   (`loadSavedLocations`) and never sends them to the server.
 * - Accuracy-aware haversine check with dwell debounce (2 consecutive fixes or
 *   1 high-confidence fix inside the radius, or immediate manual check).
 * - Instant catch-up GPS re-check on `visibilitychange` (visible), `window.focus`,
 *   and `window.online` resume so returning to the app after arriving triggers
 *   immediately without waiting for a movement delta.
 * - Atomic server CAS (`POST /api/one/location/geofences/{id}/trigger`
 *   `WHERE status = 'armed'`) guarantees multi-tab idempotency.
 * - Optional Capacitor native plugin hooks (`registerGeofence`/`clearGeofence`)
 *   with safe web no-op fallback.
 */

import { Capacitor } from "@capacitor/core";

import {
  coarsenPoint,
  type LocationPublishPrecision,
} from "@/lib/location/coarsen";
import { indexRecipientsByUserId } from "@/lib/location/publisher";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
import { haversineMeters } from "@/lib/one-location/marker-interpolation";
import { dispatchOneLocationStateChanged } from "@/lib/one-location/one-location-state-events";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationEncryptedEnvelope,
  OneLocationGeofenceRule,
  PlainLocationPoint,
  TriggerGeofenceResponse,
} from "@/lib/one-location/types";

export type GeofenceTargetCoords = {
  latitude: number;
  longitude: number;
};

export type GeofenceProximityCheck = {
  inside: boolean;
  distanceMeters: number;
  effectiveRadiusMeters: number;
  highConfidence: boolean;
};

/** Cap GPS accuracy slack so a noisy cell-tower fix never false-fires miles away. */
const MAX_ACCURACY_SLACK_METERS = 150;
const HIGH_CONFIDENCE_ACCURACY_METERS = 75;
const DWELL_HITS_REQUIRED = 2;

export function evaluateGeofenceProximity(params: {
  point: Pick<PlainLocationPoint, "latitude" | "longitude" | "accuracyM">;
  target: GeofenceTargetCoords;
  radiusMeters: number;
}): GeofenceProximityCheck {
  const distanceMeters = haversineMeters(
    { lat: params.point.latitude, lng: params.point.longitude },
    { lat: params.target.latitude, lng: params.target.longitude },
  );
  const accuracy =
    typeof params.point.accuracyM === "number" &&
    Number.isFinite(params.point.accuracyM) &&
    params.point.accuracyM > 0
      ? params.point.accuracyM
      : 0;
  const slack = Math.min(accuracy, MAX_ACCURACY_SLACK_METERS);
  const effectiveRadiusMeters = params.radiusMeters + slack;
  const inside = distanceMeters <= effectiveRadiusMeters;
  const highConfidence =
    distanceMeters <= params.radiusMeters &&
    (accuracy === 0 || accuracy <= HIGH_CONFIDENCE_ACCURACY_METERS);
  return {
    inside,
    distanceMeters,
    effectiveRadiusMeters,
    highConfidence,
  };
}

/** Optional Capacitor native geofence bridge (graceful no-op on web or older native builds). */
export async function registerNativeGeofence(params: {
  ruleId: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  triggerType: OneLocationGeofenceRule["triggerType"];
}): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const { HushhLocation } = await import("@/lib/capacitor");
    const plugin = HushhLocation as unknown as {
      registerGeofence?: (args: typeof params) => Promise<unknown>;
    };
    if (typeof plugin?.registerGeofence !== "function") return false;
    await plugin.registerGeofence(params);
    return true;
  } catch {
    return false;
  }
}

export async function clearNativeGeofence(ruleId: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const { HushhLocation } = await import("@/lib/capacitor");
    const plugin = HushhLocation as unknown as {
      clearGeofence?: (args: { ruleId: string }) => Promise<unknown>;
    };
    if (typeof plugin?.clearGeofence !== "function") return false;
    await plugin.clearGeofence({ ruleId });
    return true;
  } catch {
    return false;
  }
}

function sendBrowserArrivalNotification(title: string, body: string): void {
  if (typeof window === "undefined") return;
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch {
    // Ignore browser notification errors in restricted contexts.
  }
}

export async function resolveTargetCoordsForRule(params: {
  rule: OneLocationGeofenceRule;
  userId: string;
  vaultKey: string | null;
  vaultOwnerToken: string;
}): Promise<GeofenceTargetCoords | null> {
  const { rule } = params;
  if (rule.placeKind === "public_place") {
    if (
      typeof rule.publicLat === "number" &&
      typeof rule.publicLng === "number" &&
      Number.isFinite(rule.publicLat) &&
      Number.isFinite(rule.publicLng)
    ) {
      return { latitude: rule.publicLat, longitude: rule.publicLng };
    }
    return null;
  }
  // saved_home: read strictly from client-encrypted PKM (zero server coords).
  if (!params.vaultKey) return null;
  try {
    const { loadSavedLocations } = await import(
      "@/lib/one-location/saved-locations"
    );
    const saved = await loadSavedLocations({
      userId: params.userId,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
    });
    const home = saved.find((loc) => loc.category === "home");
    if (!home) return null;
    return { latitude: home.latitude, longitude: home.longitude };
  } catch {
    return null;
  }
}

async function buildInitialEnvelopesForShareRule(params: {
  rule: OneLocationGeofenceRule;
  point: PlainLocationPoint;
  vaultOwnerToken: string;
  defaultPrecision: LocationPublishPrecision;
}): Promise<Record<string, OneLocationEncryptedEnvelope>> {
  const envelopes: Record<string, OneLocationEncryptedEnvelope> = {};
  if (
    params.rule.triggerType !== "share_on_arrival" ||
    params.rule.recipientUserIds.length === 0
  ) {
    return envelopes;
  }
  const state = await OneLocationService.getState(params.vaultOwnerToken);
  const byUserId = indexRecipientsByUserId(state.recipients);
  const precision: LocationPublishPrecision =
    params.rule.precision ?? params.defaultPrecision ?? "precise";
  const coarsened = coarsenPoint(params.point, precision);

  await Promise.all(
    params.rule.recipientUserIds.map(async (recipientUid) => {
      const rec = byUserId.get(recipientUid);
      if (!rec?.keyId || !rec.publicKeyJwk) return;
      try {
        const encrypted = await encryptLocationForRecipient({
          point: coarsened as PlainLocationPoint,
          recipientPublicKeyJwk: rec.publicKeyJwk as JsonWebKey,
          recipientKeyId: rec.keyId,
        });
        envelopes[recipientUid] = {
          ...encrypted,
          publicationContext: "foreground_map_visible",
          metadata: {
            ...(encrypted.metadata ?? {}),
            precision,
          },
        };
      } catch {
        // Server still creates the grant; continuous bridge publishes on next fix.
      }
    }),
  );
  return envelopes;
}

export type GeofenceArrivalCheckResult = {
  triggered: boolean;
  alreadyTriggered?: boolean;
  inside: boolean;
  distanceMeters: number | null;
  reason?: string;
  response?: TriggerGeofenceResponse;
};

/**
 * Manual or catch-up arrival check for a single armed geofence rule.
 * Used both by the in-chat `"Check arrival now"` button and background resume catch-up.
 */
export async function checkGeofenceArrivalNow(params: {
  rule: OneLocationGeofenceRule;
  userId: string;
  vaultKey: string | null;
  vaultOwnerToken: string;
  defaultPrecision?: LocationPublishPrecision;
  point?: PlainLocationPoint | null;
}): Promise<GeofenceArrivalCheckResult> {
  const target = await resolveTargetCoordsForRule({
    rule: params.rule,
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
  });
  if (!target) {
    return {
      triggered: false,
      inside: false,
      distanceMeters: null,
      reason:
        params.rule.placeKind === "saved_home"
          ? "saved_home_not_configured"
          : "target_coordinates_unavailable",
    };
  }
  const point =
    params.point ??
    (await OneLocationService.captureCurrentPosition({ maxAgeMs: 15_000 }));
  const proximity = evaluateGeofenceProximity({
    point,
    target,
    radiusMeters: params.rule.radiusMeters,
  });
  if (!proximity.inside) {
    return {
      triggered: false,
      inside: false,
      distanceMeters: Math.round(proximity.distanceMeters),
      reason: "outside_radius",
    };
  }

  let initialEnvelopes: Record<string, OneLocationEncryptedEnvelope> | undefined;
  if (params.rule.triggerType === "share_on_arrival") {
    initialEnvelopes = await buildInitialEnvelopesForShareRule({
      rule: params.rule,
      point,
      vaultOwnerToken: params.vaultOwnerToken,
      defaultPrecision: params.defaultPrecision ?? "precise",
    });
  }

  const response = await OneLocationService.triggerGeofence({
    vaultOwnerToken: params.vaultOwnerToken,
    ruleId: params.rule.id,
    initialEnvelopes,
  });
  void clearNativeGeofence(params.rule.id);

  if (!response.alreadyTriggered) {
    OneLocationStateResource.invalidate(params.userId);
    dispatchOneLocationStateChanged(params.userId, ["workspace"]);
    const title =
      params.rule.triggerType === "stop_on_arrival"
        ? `Reached ${params.rule.placeLabel} — location sharing stopped`
        : `Reached ${params.rule.placeLabel} — location sharing started`;
    const body =
      params.rule.triggerType === "stop_on_arrival"
        ? `Stopped ${response.revokedCount} active location ${response.revokedCount === 1 ? "share" : "shares"}.`
        : `Now sharing with ${params.rule.recipientNames.join(", ") || "your contacts"}.`;
    morphyToast.success(title, { description: body });
    sendBrowserArrivalNotification(title, body);
  }

  return {
    triggered: true,
    alreadyTriggered: response.alreadyTriggered,
    inside: true,
    distanceMeters: Math.round(proximity.distanceMeters),
    response,
  };
}

export type GeofenceMonitorController = {
  evaluatePoint: (point: PlainLocationPoint) => Promise<void>;
  refreshRules: () => Promise<OneLocationGeofenceRule[]>;
  checkNow: () => Promise<void>;
  dispose: () => void;
};

/**
 * Create a live geofence monitor bound to an authenticated owner session.
 * Handles rule loading, dwell debounce, visibility/focus/online catch-up checks,
 * native Capacitor registration, and atomic server CAS trigger execution.
 */
export function createGeofenceMonitor(params: {
  userId: string;
  getVaultOwnerToken: () => string | null;
  getVaultKey: () => string | null;
  getDefaultPrecision: () => LocationPublishPrecision;
}): GeofenceMonitorController {
  let disposed = false;
  let armedRules: OneLocationGeofenceRule[] = [];
  const targetCache = new Map<string, GeofenceTargetCoords>();
  const dwellCounts = new Map<string, number>();
  const firingIds = new Set<string>();
  let catchUpInFlight = false;

  const syncTargets = async (rules: OneLocationGeofenceRule[]) => {
    const token = params.getVaultOwnerToken();
    if (!token) return;
    const activeIds = new Set(rules.map((r) => r.id));
    for (const cachedId of Array.from(targetCache.keys())) {
      if (!activeIds.has(cachedId)) {
        targetCache.delete(cachedId);
        dwellCounts.delete(cachedId);
        void clearNativeGeofence(cachedId);
      }
    }
    await Promise.all(
      rules.map(async (rule) => {
        if (targetCache.has(rule.id)) return;
        const coords = await resolveTargetCoordsForRule({
          rule,
          userId: params.userId,
          vaultKey: params.getVaultKey(),
          vaultOwnerToken: token,
        });
        if (coords && !disposed) {
          targetCache.set(rule.id, coords);
          void registerNativeGeofence({
            ruleId: rule.id,
            latitude: coords.latitude,
            longitude: coords.longitude,
            radiusMeters: rule.radiusMeters,
            triggerType: rule.triggerType,
          });
        }
      }),
    );
  };

  const refreshRules = async (): Promise<OneLocationGeofenceRule[]> => {
    const token = params.getVaultOwnerToken();
    if (!token || disposed) return [];
    try {
      const res = await OneLocationService.listGeofences({
        vaultOwnerToken: token,
        status: "armed",
      });
      if (disposed) return [];
      armedRules = res.rules ?? [];
      await syncTargets(armedRules);
      return armedRules;
    } catch {
      return armedRules;
    }
  };

  const evaluatePoint = async (
    point: PlainLocationPoint,
    immediate = false,
  ): Promise<void> => {
    const token = params.getVaultOwnerToken();
    if (!token || disposed || armedRules.length === 0) return;

    for (const rule of [...armedRules]) {
      if (firingIds.has(rule.id)) continue;
      const target = targetCache.get(rule.id);
      if (!target) continue;
      const check = evaluateGeofenceProximity({
        point,
        target,
        radiusMeters: rule.radiusMeters,
      });
      if (!check.inside) {
        dwellCounts.set(rule.id, 0);
        continue;
      }
      const hits = (dwellCounts.get(rule.id) ?? 0) + 1;
      dwellCounts.set(rule.id, hits);
      const shouldTrigger =
        immediate || check.highConfidence || hits >= DWELL_HITS_REQUIRED;
      if (!shouldTrigger) continue;

      firingIds.add(rule.id);
      try {
        const result = await checkGeofenceArrivalNow({
          rule,
          userId: params.userId,
          vaultKey: params.getVaultKey(),
          vaultOwnerToken: token,
          defaultPrecision: params.getDefaultPrecision(),
          point,
        });
        if (result.triggered) {
          armedRules = armedRules.filter((r) => r.id !== rule.id);
          targetCache.delete(rule.id);
          dwellCounts.delete(rule.id);
        }
      } catch (error) {
        console.warn("[GeofenceMonitor] Trigger failed:", error);
      } finally {
        firingIds.delete(rule.id);
      }
    }
  };

  const checkNow = async (): Promise<void> => {
    if (disposed || catchUpInFlight || armedRules.length === 0) return;
    catchUpInFlight = true;
    try {
      const point = await OneLocationService.captureCurrentPosition({
        maxAgeMs: 15_000,
      });
      await evaluatePoint(point, true);
    } catch {
      // No fix available on resume; watch loop or next resume will retry.
    } finally {
      catchUpInFlight = false;
    }
  };

  const onVisibilityOrFocus = () => {
    if (disposed) return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    void refreshRules().then(() => checkNow());
  };

  const onOnline = () => {
    if (disposed) return;
    void refreshRules().then(() => checkNow());
  };

  if (typeof window !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityOrFocus);
    window.addEventListener("focus", onVisibilityOrFocus);
    window.addEventListener("online", onOnline);
  }

  return {
    evaluatePoint: (point) => evaluatePoint(point, false),
    refreshRules,
    checkNow,
    dispose: () => {
      disposed = true;
      if (typeof window !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityOrFocus);
        window.removeEventListener("focus", onVisibilityOrFocus);
        window.removeEventListener("online", onOnline);
      }
    },
  };
}
