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
    const permission = await withinDeadline(LocationBus.syncPermission(), FRESH_FIX_WAIT_MS);
    if (permission === "denied" || permission === "restricted") return { status: "denied" };
    if (permission === "prompt") return { status: "not_granted" };
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
