"use client";

import { useSyncExternalStore } from "react";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

export type PersonConnectorAvailability =
  | { status: "checking" | "locked" | "error" }
  | { status: "ready"; documentSharing: boolean; agentPackages: boolean };

/** A small owner-scoped hint; each mutation still enforces server authority. */
export function usePersonConnectorFeatures(userId: string | undefined, token: string | null, unlocked: boolean) {
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const resource = useStaleResource({
    cacheKey: CACHE_KEYS.CONNECTOR_FEATURES(userId ?? "signed-out"),
    requestScope: `${getAuthSessionGeneration()}:${epoch}`,
    enabled: Boolean(userId && token && unlocked),
    cacheTtlMs: CACHE_TTL.SHORT,
    resourceLabel: "person_connector_features",
    load: () => ExternalConnectorService.featureReadiness(token!),
  });
  const availability: PersonConnectorAvailability = !unlocked ? { status: "locked" }
    : resource.error ? { status: "error" }
    : resource.data ? { status: "ready", documentSharing: resource.data.features?.drive_document_sharing === true,
      agentPackages: resource.data.driveAgentPackagesEnabled === true || resource.data.features?.drive_period_packets === true }
    : { status: "checking" };
  return { availability, retry: () => resource.refresh({ force: true }) };
}
