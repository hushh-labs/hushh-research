"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  SettingsGroup,
  SettingsRow,
} from "@/components/app-ui/settings-ui";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  loadEmailDraftingEnabled,
  saveEmailDraftingEnabled,
} from "@/lib/onboarding/email-drafting-preference";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

export function EmailOnboardingSetupClient() {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user?.uid || !vaultOwnerToken) {
      setEnabled(false);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    void loadEmailDraftingEnabled({
      userId: user.uid,
      vaultOwnerToken,
    })
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => {
        if (!cancelled) {
          setEnabled(false);
          toast.error("KYC preference could not be loaded. Please try again.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid, vaultOwnerToken]);

  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "email",
    isOperationallyReady: loaded,
    settlementBlocked: saving,
    finishActionId: "setup.finish_email",
    skipActionId: "setup.skip_email",
  });

  usePublishVoiceSurfaceMetadata(
    coordinator.isReady
      ? {
          screenId: "one_setup_email_toggle",
          title: "KYC setup",
          purpose: "Choose whether One can prepare responses for your approval.",
          controls: [
            {
              id: "one-setup-email-drafting-toggle",
              label: "Prepare KYC responses automatically",
              type: "toggle",
              state: enabled ? "enabled" : "disabled",
              purpose: "Choose whether One may automatically prepare KYC responses for review.",
            },
          ],
          availableActions: [],
        }
      : null,
  );

  if (!coordinator.isReady) return <SetupCapabilityLoading label="Preparing KYC setup…" />;

  const handleToggle = async (checked: boolean) => {
    const previous = enabled;
    setEnabled(checked);
    if (!user?.uid || !vaultOwnerToken) {
      setEnabled(previous);
      return;
    }
    setSaving(true);
    try {
      const saved = await saveEmailDraftingEnabled({
        userId: user.uid,
        vaultOwnerToken,
        enabled: checked,
      });
      if (!saved) {
        setEnabled(previous);
        toast.error("KYC preference could not be saved. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="space-y-4 pb-[calc(var(--app-bottom-inset)+1rem)]"
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="KYC"
          description="Choose whether One may prepare a response when you send a request to one@hushh.ai."
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SettingsGroup
          title="Response preparation"
          description="This is off by default. When enabled, One recognizes requests sent from your verified email to one@hushh.ai. You still approve every response before it is sent."
          separatorInset
        >
          <SettingsRow
            title="Prepare automatically"
            description={
              enabled
                ? "Enabled for one@hushh.ai"
                : "No email requests will trigger One"
            }
            trailing={
              <Switch
                checked={enabled}
                onCheckedChange={(checked) => void handleToggle(checked)}
                disabled={saving}
                aria-label="Prepare KYC responses automatically"
                data-voice-control-id="one-setup-email-drafting-toggle"
              />
            }
          />
        </SettingsGroup>
      </AppPageContentRegion>
      <SetupCapabilityTerminalFooter
        capabilityId="email"
        isOperationallyReady={loaded}
        coordinator={coordinator}
        pending={saving}
      />
    </AppPageShell>
  );
}
