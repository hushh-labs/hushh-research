"use client";

import { useEffect, useState } from "react";
import { ApiService } from "@/lib/services/api-service";
import { ownerCloudProvider } from "@/lib/one/owner-cloud";

/** Placement is a current owner observation, never inferred from a saved AI label. */
export function useAiPlacement(
  captureOwnerGuard: () => () => boolean,
  resetVerification: (value: false) => void,
) {
  const [placement, setPlacement] = useState<
    "loading" | "unknown" | "shared" | "gcp" | "azure" | "pending"
  >("loading");
  const [ownCloudProject, setOwnCloudProject] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
    setPlacement("loading");
    setOwnCloudProject(null);
    resetVerification(false);
    void ApiService.getPersonalAgentStatus()
      .then((status) => {
        if (cancelled || !ownerIsCurrent()) return;
        const provider = ownerCloudProvider(status.deploymentTarget);
        setPlacement(
          status.hostingMode === "shared"
            ? "shared"
            : status.hostingMode === "byoc" && provider
              ? status.state === "active"
                ? provider
                : "pending"
              : status.hostingMode === "pending"
                ? "pending"
                : "unknown",
        );
        setOwnCloudProject(
          status.hostingMode === "byoc" && provider
            ? (status.cloudProject ?? null)
            : null,
        );
      })
      .catch(() => {
        if (!cancelled && ownerIsCurrent()) setPlacement("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [captureOwnerGuard, resetVerification]);
  return { placement, ownCloudProject };
}
