import type { OneLocationState, OneLocationGrant, OneLocationAccessRequest } from "./types";

export function selectActiveOwnerGrants(
  state: OneLocationState | null,
): OneLocationGrant[] {
  return (state?.ownerGrants ?? []).filter(
    (grant) => grant.status === "active",
  );
}

export function selectActiveReceivedGrants(
  state: OneLocationState | null,
): OneLocationGrant[] {
  return (state?.receivedGrants ?? []).filter(
    (grant) => grant.status === "active",
  );
}

export function selectPendingIncomingRequests(
  state: OneLocationState | null,
  userId: string | null,
): OneLocationAccessRequest[] {
  if (!userId) return [];
  return (state?.requests ?? []).filter(
    (request) => request.status === "pending" && request.ownerUserId === userId,
  );
}

export function selectPendingOutgoingRequests(
  state: OneLocationState | null,
  userId: string | null,
): OneLocationAccessRequest[] {
  if (!userId) return [];
  return (state?.requests ?? []).filter(
    (request) =>
      request.status === "pending" && request.requesterUserId === userId,
  );
}
