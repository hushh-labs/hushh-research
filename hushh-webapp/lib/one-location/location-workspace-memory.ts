import type {
  DriveSharePayload,
  PlainLocationPoint,
} from "@/lib/one-location/types";

/**
 * Volatile presentation state shared by the Location hub and nested Map. It is
 * process-memory only: coordinates are never serialized or persisted.
 */
export type LocationWorkspaceMemory = {
  myLocationPoint: PlainLocationPoint | null;
  decryptedPoints: Record<string, PlainLocationPoint>;
};

const EMPTY_WORKSPACE: LocationWorkspaceMemory = {
  myLocationPoint: null,
  decryptedPoints: {},
};

const workspaceByUser = new Map<string, LocationWorkspaceMemory>();

function cloneWorkspace(workspace: LocationWorkspaceMemory): LocationWorkspaceMemory {
  return {
    myLocationPoint: workspace.myLocationPoint
      ? { ...workspace.myLocationPoint }
      : null,
    decryptedPoints: Object.fromEntries(
      Object.entries(workspace.decryptedPoints).map(([grantId, point]) => [
        grantId,
        { ...point },
      ]),
    ),
  };
}

function sameDrivePayload(
  a: DriveSharePayload | null | undefined,
  b: DriveSharePayload | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.etaSeconds === b.etaSeconds &&
    a.distanceMeters === b.distanceMeters &&
    a.etaComputedAt === b.etaComputedAt &&
    a.destination.label === b.destination.label &&
    a.destination.latitude === b.destination.latitude &&
    a.destination.longitude === b.destination.longitude &&
    (a.destination.placeId ?? null) === (b.destination.placeId ?? null)
  );
}

/**
 * Exact value equality for a decrypted point.
 *
 * A recipient's live-view poll re-decrypts every visible grant on a fixed
 * cadence, and a stationary owner republishes the same coordinates — so most
 * ticks carry a point identical to the one already on screen. Storing it anyway
 * allocates a new workspace object, which defeats React's bail-out and
 * re-renders the whole Location surface every few seconds for no visible
 * change.
 *
 * Every field is compared, not just the coordinates. `drive` carries an ETA
 * that is recomputed on its own schedule and `checkIn` carries the author's
 * note; a coordinates-only check would freeze both at their first value while
 * the point still looked "unchanged".
 */
export function samePlainLocationPoint(
  a: PlainLocationPoint | null | undefined,
  b: PlainLocationPoint | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    (a.accuracyM ?? null) === (b.accuracyM ?? null) &&
    a.capturedAt === b.capturedAt &&
    a.sourcePlatform === b.sourcePlatform &&
    (a.checkIn?.message ?? null) === (b.checkIn?.message ?? null) &&
    sameDrivePayload(a.drive, b.drive)
  );
}

export function readLocationWorkspaceMemory(
  userId: string | null | undefined,
): LocationWorkspaceMemory {
  if (!userId) return cloneWorkspace(EMPTY_WORKSPACE);
  return cloneWorkspace(workspaceByUser.get(userId) ?? EMPTY_WORKSPACE);
}

export function writeLocationWorkspaceMemory(
  userId: string | null | undefined,
  workspace: LocationWorkspaceMemory,
): void {
  if (userId) workspaceByUser.set(userId, cloneWorkspace(workspace));
}

export function clearLocationWorkspaceMemory(
  userId: string | null | undefined,
): void {
  if (userId) workspaceByUser.delete(userId);
}

/** Clear all volatile coordinates when auth no longer identifies an owner. */
export function clearAllLocationWorkspaceMemory(): void {
  workspaceByUser.clear();
}
