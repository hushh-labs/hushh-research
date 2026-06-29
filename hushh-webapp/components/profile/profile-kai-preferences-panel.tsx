"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { SurfaceCard, SurfaceCardContent, SurfaceCardDescription, SurfaceCardHeader, SurfaceCardTitle } from "@/components/app-ui/surfaces";
import { KaiPreferencesWizard } from "@/components/kai/onboarding/KaiPreferencesWizard";
import { KaiProfileService, type KaiProfileV2 } from "@/lib/services/kai-profile-service";
import { useFadeInOnReady } from "@/lib/morphy-ux/hooks/use-fade-in-on-ready";

export function ProfileKaiPreferencesPanel({
  userId,
  vaultKey,
  vaultOwnerToken,
  canEdit,
  onRequestUnlock,
}: {
  userId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  canEdit: boolean;
  onRequestUnlock: () => void;
}) {
  const [profile, setProfile] = useState<KaiProfileV2 | null>(null);
  const [loading, setLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useFadeInOnReady(contentRef, !loading && !!profile, { fromY: 10 });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!userId || !vaultKey || !vaultOwnerToken || !canEdit) return;
      setLoading(true);
      try {
        const nextProfile = await KaiProfileService.getProfile({
          userId,
          vaultKey,
          vaultOwnerToken,
        });
        if (!cancelled) {
          setProfile(nextProfile);
        }
      } catch (error) {
        console.warn("[ProfileKaiPreferencesPanel] Failed to load profile:", error);
        if (!cancelled) {
          setProfile(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [canEdit, userId, vaultKey, vaultOwnerToken]);

  if (!canEdit) {
    return (
      <SurfaceCard>
        <SurfaceCardHeader>
          <SurfaceCardTitle>Unlock to edit Kai preferences</SurfaceCardTitle>
          <SurfaceCardDescription>
            Risk profile and horizon preferences are stored securely in your vault.
          </SurfaceCardDescription>
        </SurfaceCardHeader>
        <SurfaceCardContent>
          <button
            type="button"
            onClick={onRequestUnlock}
            className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--app-card-border-standard)] px-4 text-sm font-medium text-foreground transition-[background-color,border-color] hover:bg-muted/80"
          >
            Unlock vault
          </button>
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  if (loading) {
    return (
      <SurfaceCard>
        <SurfaceCardContent className="p-6">
          <HushhLoader label="Loading preferences..." />
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  if (!profile) {
    return (
      <SurfaceCard>
        <SurfaceCardHeader>
          <SurfaceCardTitle>Preferences unavailable</SurfaceCardTitle>
          <SurfaceCardDescription>
            We could not load your saved Kai preferences. Reopen this screen to retry.
          </SurfaceCardDescription>
        </SurfaceCardHeader>
      </SurfaceCard>
    );
  }

  return (
    <div ref={contentRef} className="rounded-[var(--app-card-radius-feature)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]">
      <KaiPreferencesWizard
        mode="edit"
        layout="sheet"
        initialAnswers={{
          investment_horizon: profile.preferences.investment_horizon,
          drawdown_response: profile.preferences.drawdown_response,
          volatility_preference: profile.preferences.volatility_preference,
        }}
        onComplete={async (payload) => {
          if (!userId || !vaultKey || !vaultOwnerToken) return;
          try {
            setLoading(true);
            await KaiProfileService.savePreferences({
              userId,
              vaultKey,
              vaultOwnerToken,
              updates: {
                investment_horizon: payload.investment_horizon,
                drawdown_response: payload.drawdown_response,
                volatility_preference: payload.volatility_preference,
              },
              mode: "edit",
              horizonAnchorChoice: payload.horizonAnchorChoice,
            });
            const refreshed = await KaiProfileService.getProfile({
              userId,
              vaultKey,
              vaultOwnerToken,
            });
            setProfile(refreshed);
            toast.success("Preferences updated");
          } catch (error) {
            console.error("[ProfileKaiPreferencesPanel] Save failed:", error);
            toast.error("Couldn't save preferences. Please retry.");
          } finally {
            setLoading(false);
          }
        }}
      />
    </div>
  );
}
