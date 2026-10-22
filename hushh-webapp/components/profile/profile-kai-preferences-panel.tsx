"use client";

import { useRef } from "react";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { SurfaceCard, SurfaceCardContent, SurfaceCardDescription, SurfaceCardHeader, SurfaceCardTitle } from "@/components/app-ui/surfaces";
import { KaiPreferencesWizard } from "@/components/kai/onboarding/KaiPreferencesWizard";
import { useProfileFinancePreferences, type ProfileFinancePreferencesModel } from "./use-profile-finance-preferences";
import { useFadeInOnReady } from "@/lib/morphy-ux/hooks/use-fade-in-on-ready";

export function ProfileKaiPreferencesPanel({
  userId,
  vaultKey,
  vaultOwnerToken,
  canEdit,
  onRequestUnlock,
  model,
}: {
  userId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  canEdit: boolean;
  onRequestUnlock: () => void;
  model?: ProfileFinancePreferencesModel;
}) {
  const owned = useProfileFinancePreferences({ userId, vaultKey, vaultOwnerToken, canEdit, active: !model });
  const current = model ?? owned;
  const { profile, loading, wizard } = current;
  const contentRef = useRef<HTMLDivElement | null>(null);
  useFadeInOnReady(contentRef, !loading && !!profile, { fromY: 10 });

  if (!canEdit) {
    return (
      <SurfaceCard>
        <SurfaceCardHeader>
          <SurfaceCardTitle>Unlock to edit Finance preferences</SurfaceCardTitle>
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
            We could not load your saved Finance preferences. Reopen this screen to retry.
          </SurfaceCardDescription>
        </SurfaceCardHeader>
      </SurfaceCard>
    );
  }

  return (
    <div ref={contentRef} className="rounded-[var(--app-card-radius-feature)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]">
      <KaiPreferencesWizard mode="edit" layout="sheet" controller={wizard} onComplete={() => undefined}
      />
    </div>
  );
}
