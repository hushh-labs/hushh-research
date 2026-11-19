"use client";

import { useCallback, useMemo, useState } from "react";
import { isLocationRequestPending } from "./request-expiry";
import type { OneLocationAccessRequest } from "./types";

/** A rejected review stays closed until a new authoritative revision arrives. */
export function useLocationRequestReviews(requests: OneLocationAccessRequest[] | undefined, owner: string | null | undefined, now: number) {
  const [invalid, setInvalid] = useState<{ owner: typeof owner; revisions: Record<string, string> }>({ owner, revisions: {} });
  const invalidate = useCallback((request: OneLocationAccessRequest) => setInvalid(previous => ({
    owner, revisions: { ...(previous.owner === owner ? previous.revisions : {}), [request.id]: reviewBinding(request) },
  })), [owner]);
  const pending = useMemo(() => (requests ?? []).filter(request =>
    request.ownerUserId === owner && isLocationRequestPending(request, now) &&
    (invalid.owner !== owner || invalid.revisions[request.id] !== reviewBinding(request))),
  [requests, owner, now, invalid]);
  return { pending, invalidate };
}

function reviewBinding(request: OneLocationAccessRequest): string {
  return JSON.stringify([request.requestRevision ?? 1, request.extendsGrantId, request.extendsGrantExpiresAt]);
}
