"use client";

import { useCallback, useEffect, useState } from "react";

import { InlineLoadingState } from "@/components/app-ui/inline-loading-state";
import { RiaProfileSection } from "@/components/ria/profile/ria-profile-section";
import { RiaPageShell } from "@/components/ria/ria-page-shell";
import { useAuth } from "@/hooks/use-auth";
import { RiaService, type RiaOnboardingStatus } from "@/lib/services/ria-service";

/**
 * Canonical RIA profile management surface. The profile is deliberately owned
 * by the RIA workspace rather than duplicated under the general Profile hub.
 */
export default function RiaProfilePage() {
  const { user, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<RiaOnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshStatus = useCallback(
    async (force = false) => {
      if (!user) {
        setStatus(null);
        setLoading(false);
        return null;
      }

      setLoading(true);
      try {
        const idToken = await user.getIdToken();
        const nextStatus = await RiaService.getOnboardingStatus(idToken, {
          userId: user.uid,
          force,
        });
        setStatus(nextStatus);
        return nextStatus;
      } finally {
        setLoading(false);
      }
    },
    [user],
  );

  useEffect(() => {
    if (authLoading) return;
    void refreshStatus();
  }, [authLoading, refreshStatus]);

  return (
    <RiaPageShell
      eyebrow="RIA"
      title="Profile"
      description="Manage your advisor profile and verification details."
      nativeTest={{
        routeId: "ria-profile",
        marker: "ria-profile-page",
        authState: authLoading ? "pending" : user ? "authenticated" : "anonymous",
        dataState: authLoading || loading ? "loading" : "loaded",
      }}
    >
      {authLoading || loading ? (
        <InlineLoadingState label="Loading profile…" />
      ) : (
        <RiaProfileSection status={status} onRefresh={refreshStatus} />
      )}
    </RiaPageShell>
  );
}
