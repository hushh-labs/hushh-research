/**
 * The person's approximate location for one One chat turn.
 *
 * Sent only when the OS permission is already granted, and never prompts: a
 * chat turn is not the gesture that may spend iOS's one permission prompt.
 * Rounded here to two decimal places (about 1 km) so a precise position never
 * leaves the device for chat. The backend keeps it in memory for the turn only
 * (consent-protocol/hushh_mcp/one_adk/turn_location.py).
 */
import { LocationBus } from "@/lib/one-location/location-bus";
import { isUsableFixAge } from "@/lib/one-location/location-readiness";

export type TurnLocation =
  | { status: "available"; latitude: number; longitude: number }
  | { status: "denied" | "not_granted" | "unavailable" };

/** One shared budget for permission discovery and a fresh position. */
const FRESH_FIX_WAIT_MS = 1_500;

function coarse(value: number): number {
  return Math.round(value * 100) / 100;
}

function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export async function resolveTurnLocation(): Promise<TurnLocation> {
  const startedAt = Date.now();
  try {
    const preSyncState = LocationBus.getState();
    const freshPromptSnapshot =
      preSyncState?.status === "ready" &&
      preSyncState?.snapshotOrigin === "fresh" &&
      preSyncState?.snapshot &&
      isUsableFixAge(preSyncState.snapshot.capturedAt) &&
      Number.isFinite(preSyncState.snapshot.latitude) &&
      Number.isFinite(preSyncState.snapshot.longitude)
        ? preSyncState.snapshot
        : null;

    // Zero-wait fast path: if LocationBus already knows permission and holds a
    // fresh fix in memory, return immediately (0 ms) without blocking chat send.
    const cachedPermission = preSyncState?.permission;
    const cachedSnapshot = preSyncState?.snapshot;
    if (
      cachedPermission === "granted" &&
      cachedSnapshot &&
      isUsableFixAge(cachedSnapshot.capturedAt) &&
      Number.isFinite(cachedSnapshot.latitude) &&
      Number.isFinite(cachedSnapshot.longitude)
    ) {
      return {
        status: "available",
        latitude: coarse(cachedSnapshot.latitude),
        longitude: coarse(cachedSnapshot.longitude),
      };
    }
    if (cachedPermission === "denied" || cachedPermission === "restricted") {
      return { status: "denied" };
    }
    if (cachedPermission === "prompt") {
      if (freshPromptSnapshot) {
        return {
          status: "available",
          latitude: coarse(freshPromptSnapshot.latitude),
          longitude: coarse(freshPromptSnapshot.longitude),
        };
      }
      return { status: "not_granted" };
    }
    const permission = await withinDeadline(LocationBus.syncPermission(), FRESH_FIX_WAIT_MS);
    if (permission === "denied" || permission === "restricted") return { status: "denied" };
    // Safari/WebKit cannot query the geolocation descriptor in the Permissions
    // API and reports `prompt` even right after an owner-initiated capture in
    // this session succeeded. Reuse that fresh session measurement without
    // prompting, while still treating an unmeasured `prompt` as `not_granted`.
    if (permission === "prompt") {
      const heldFresh =
        preSyncState.status === "ready" &&
        preSyncState.snapshotOrigin === "fresh" &&
        preSyncState.snapshot &&
        isUsableFixAge(preSyncState.snapshot.capturedAt)
          ? preSyncState.snapshot
          : null;
      if (
        heldFresh &&
        Number.isFinite(heldFresh.latitude) &&
        Number.isFinite(heldFresh.longitude)
      ) {
        return {
          status: "available",
          latitude: coarse(heldFresh.latitude),
          longitude: coarse(heldFresh.longitude),
        };
      }
      return { status: "not_granted" };
    }
    if (permission !== "granted") return { status: "unavailable" };
    const held = LocationBus.getState().snapshot;
    const remainingMs = Math.max(0, FRESH_FIX_WAIT_MS - (Date.now() - startedAt));
    const fix =
      held && isUsableFixAge(held.capturedAt)
        ? held
        : remainingMs > 0 ? await withinDeadline(LocationBus.ensure(), remainingMs) : null;
    if (!fix || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) {
      return { status: "unavailable" };
    }
    return { status: "available", latitude: coarse(fix.latitude), longitude: coarse(fix.longitude) };
  } catch {
    return { status: "unavailable" };
  }
}
