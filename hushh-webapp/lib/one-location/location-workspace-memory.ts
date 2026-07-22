import type { PlainLocationPoint } from "@/lib/one-location/types";

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
