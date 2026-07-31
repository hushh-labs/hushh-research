/**
 * Mount the Nearby surface in every lane so it can ask the backend for the
 * authoritative capability before collecting location. Authorization remains
 * server-side and fail-closed; this helper controls placement only.
 */
export function isOneLocationNearbyCheckInAvailable(): boolean {
  return true;
}
