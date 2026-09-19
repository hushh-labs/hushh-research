"use client";

import { useCallback, useState } from "react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import {
  CapabilityDismissDialog,
  type CapabilityDismissTarget,
} from "@/components/onboarding/setup/capability-dismiss-dialog";
import { CapabilityListRow } from "@/components/onboarding/setup/capability-list-row";
import { useAuth } from "@/hooks/use-auth";
import { CAPABILITY_SETUP_COPY } from "@/lib/onboarding/capability-setup-copy";
import { ONE_SETUP_CAPABILITIES } from "@/lib/onboarding/one-capabilities";
import { useCapabilitySetupStates } from "@/lib/onboarding/use-capability-setup-states";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { useOnboardingDismissStore } from "@/lib/stores/onboarding-dismiss-store";

export function OneSetupCapabilitiesScreen() {
  const { user } = useAuth();
  const userId = user?.uid ?? null;
  const { byId, isLoading } = useCapabilitySetupStates({ enrichRia: true });
  const sessionDismissedIds = useOnboardingDismissStore(
    (state) => state.sessionDismissedIds,
  );
  const undoSessionDismiss = useOnboardingDismissStore(
    (state) => state.undoSessionDismiss,
  );
  const [dismissTarget, setDismissTarget] =
    useState<CapabilityDismissTarget | null>(null);
  const [declinedIds, setDeclinedIds] = useState<string[]>(() =>
    userId
      ? (PreVaultUserStateService.getCachedBootstrapState(userId)
          ?.setupCapabilityDeclinedIds ?? [])
      : [],
  );
  const [undoError, setUndoError] = useState<string | null>(null);

  const handleUndo = useCallback(
    async (capabilityId: string) => {
      setUndoError(null);
      if (sessionDismissedIds.has(capabilityId)) {
        undoSessionDismiss(capabilityId);
        return;
      }
      if (!userId) return;
      const next = declinedIds.filter((id) => id !== capabilityId);
      try {
        await PreVaultUserStateService.syncDeclinedCapabilities(userId, next);
        setDeclinedIds(next);
      } catch (err) {
        setUndoError(
          err instanceof Error ? err.message : "Unable to undo that right now.",
        );
      }
    },
    [declinedIds, sessionDismissedIds, undoSessionDismiss, userId],
  );

  const remaining = ONE_SETUP_CAPABILITIES.filter(
    (capability) =>
      byId[capability.id]?.state !== "completed" &&
      !declinedIds.includes(capability.id) &&
      !sessionDismissedIds.has(capability.id),
  );
  const dismissed = ONE_SETUP_CAPABILITIES.filter(
    (capability) =>
      byId[capability.id]?.state !== "completed" &&
      (declinedIds.includes(capability.id) ||
        sessionDismissedIds.has(capability.id)),
  );
  const complete = ONE_SETUP_CAPABILITIES.filter(
    (capability) => byId[capability.id]?.state === "completed",
  );

  const renderRow = (capability: (typeof ONE_SETUP_CAPABILITIES)[number]) => {
    const copy = CAPABILITY_SETUP_COPY.find((c) => c.id === capability.id);
    const status = byId[capability.id];
    if (!copy || !status) return null;
    return (
      <CapabilityListRow
        key={capability.id}
        capability={capability}
        copy={copy}
        status={status}
        isDismissed={
          declinedIds.includes(capability.id) ||
          sessionDismissedIds.has(capability.id)
        }
        onRequestDismiss={() =>
          setDismissTarget({ id: capability.id, title: copy.title })
        }
        onUndoDismiss={() => void handleUndo(capability.id)}
      />
    );
  };

  return (
    <AppPageShell
      as="main"
      width="reading"
      nativeTest={{
        routeId: "/one/setup/capabilities",
        marker: "native-route-setup-capabilities",
        authState: user ? "authenticated" : "pending",
        dataState: isLoading ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="Set up One"
          description="Connect what's useful to you. Dismiss what isn't -- One won't ask again unless you open it yourself."
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <div className="space-y-4">
          {undoError ? (
            <p className="text-sm text-[color:var(--app-destructive)]">
              {undoError}
            </p>
          ) : null}
          {remaining.length > 0 ? (
            <SettingsGroup title="Not set up" testId="one-setup-capabilities-remaining">
              {remaining.map(renderRow)}
            </SettingsGroup>
          ) : null}
          {complete.length > 0 ? (
            <SettingsGroup title="Ready" testId="one-setup-capabilities-complete">
              {complete.map(renderRow)}
            </SettingsGroup>
          ) : null}
          {dismissed.length > 0 ? (
            <SettingsGroup title="Dismissed" testId="one-setup-capabilities-dismissed">
              {dismissed.map(renderRow)}
            </SettingsGroup>
          ) : null}
        </div>
      </AppPageContentRegion>
      <CapabilityDismissDialog
        // Remount on every new dismiss target so stale internal state (an
        // error from a previous attempt, an unchecked "remember my choice")
        // never carries over to a different capability's confirm.
        key={dismissTarget?.id ?? "none"}
        target={dismissTarget}
        userId={userId}
        currentDeclinedIds={declinedIds}
        onOpenChange={(open) => {
          if (!open) setDismissTarget(null);
        }}
        onPermanentDismiss={setDeclinedIds}
      />
    </AppPageShell>
  );
}
