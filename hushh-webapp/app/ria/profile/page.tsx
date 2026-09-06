"use client";

import { useCallback, useEffect, useState } from "react";

import { InlineLoadingState } from "@/components/app-ui/inline-loading-state";
import { RiaProfileSection } from "@/components/ria/profile/ria-profile-section";
import { RiaPageShell } from "@/components/ria/ria-page-shell";
import { Button } from "@/components/ui/button";
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
  const [loadError, setLoadError] = useState(false);

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
        setLoadError(false);
        return nextStatus;
      } catch {
        // A failed status read left `status` null with no error surface and an
        // unhandled rejection. Say it failed and offer the retry instead.
        setLoadError(true);
        return null;
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
      titleRole="agent"
      nativeTest={{
        routeId: "ria-profile",
        marker: "ria-profile-page",
        authState: authLoading ? "pending" : user ? "authenticated" : "anonymous",
        dataState: authLoading || loading ? "loading" : "loaded",
      }}
    >
      {authLoading || loading ? (
        <InlineLoadingState label="Loading profile…" />
      ) : loadError && !status ? (
        <div className="space-y-4 rounded-[22px] border border-[color:var(--border)] bg-[color:var(--card)] p-5">
          <div>
            <p className="text-[16px] font-semibold">We couldn&apos;t load your profile</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Check your connection and try again.
            </p>
          </div>
          <Button
            onClick={() => void refreshStatus(true)}
            data-testid="ria-profile-load-retry"
          >
            Try again
          </Button>
        </div>
      ) : (
        <RiaProfileSection
          status={status}
          loading={loading}
          onRefresh={refreshStatus}
        />
      )}
    </RiaPageShell>
  );
}
