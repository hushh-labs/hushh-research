"use client";

import { useEffect, useState } from "react";
import { ApiService } from "@/lib/services/api-service";
import { ownerCloudProvider } from "@/lib/one/owner-cloud";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

type AiPlacement = "loading" | "unknown" | "shared" | "gcp" | "azure" | "pending";
type PlacementObservation = {
  visit: () => () => boolean;
  revision: number;
  placement: AiPlacement;
  ownCloudProject: string | null;
};

/** Placement is a current owner observation, never inferred from a saved AI label. */
export function useAiPlacement(
  captureOwnerGuard: () => () => boolean,
  resetVerification: (value: false) => void,
) {
  const [observation, setObservation] = useState<PlacementObservation | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  // Hide an earlier visit or refresh during the render before effects run.
  const currentObservation = observation?.visit === captureOwnerGuard && observation.revision === refreshRevision
    ? observation : null;
  const placement = currentObservation?.placement ?? "loading";
  const ownCloudProject = currentObservation?.ownCloudProject ?? null;
  useEffect(() => {
    let cancelled = false;
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
    setObservation({ visit: captureOwnerGuard, revision: refreshRevision, placement: "loading", ownCloudProject: null });
    resetVerification(false);
    void ApiService.getPersonalAgentStatus()
      .then((status) => {
        if (cancelled || !ownerIsCurrent()) return;
        const provider = ownerCloudProvider(status.deploymentTarget);
        const nextPlacement: AiPlacement = status.hostingMode === "shared"
            ? "shared"
            : status.hostingMode === "byoc" && provider
              ? status.state === "active"
                ? provider
                : "pending"
              : status.hostingMode === "pending"
                ? "pending"
                : "unknown";
        setObservation({
          visit: captureOwnerGuard,
          revision: refreshRevision,
          placement: nextPlacement,
          ownCloudProject: status.hostingMode === "byoc" && provider
            ? (status.cloudProject ?? null)
            : null,
        });
      })
      .catch(() => {
        if (!cancelled && ownerIsCurrent()) {
          setObservation({ visit: captureOwnerGuard, revision: refreshRevision, placement: "unknown", ownCloudProject: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [captureOwnerGuard, resetVerification, refreshRevision]);
  useEffect(() => {
    const ownerIsCurrent = captureOwnerGuard();
    const owner = snapshotValidatedAuthSessionOwner();
    if (!owner || !ownerIsCurrent()) return;
    return CacheService.getInstance().subscribe((event) => {
      if (ownerIsCurrent() && event.type === "set" &&
        event.key === CACHE_KEYS.PRE_VAULT_BOOTSTRAP(owner.userId)) {
        setRefreshRevision((value) => value + 1);
      }
    });
  }, [captureOwnerGuard]);
  return { placement, ownCloudProject, refreshPlacement: () => setRefreshRevision((value) => value + 1) };
}
