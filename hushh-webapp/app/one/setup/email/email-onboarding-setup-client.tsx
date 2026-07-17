"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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
import { isApplePrivateRelayEmail } from "@/lib/auth/private-relay";
import { ROUTES } from "@/lib/navigation/routes";
import {
  loadEmailDraftingEnabled,
  saveEmailDraftingEnabled,
} from "@/lib/onboarding/email-drafting-preference";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

export function EmailOnboardingSetupClient() {
  const { user } = useAuth();
  const isPrivateRelay = isApplePrivateRelayEmail(user?.email);
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user?.uid) return;
    if (isPrivateRelay) {
      setEnabled(false);
      setLoaded(true);
      return;
    }
    loadEmailDraftingEnabled(user.uid).then((val) => {
      setEnabled(val);
      setLoaded(true);
    });
  }, [isPrivateRelay, user?.uid]);

  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "email",
    isOperationallyReady: loaded,
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
              label: "Let One draft replies",
              type: "toggle",
              actionId: "setup.toggle_email_drafting",
              purpose: "Enable or disable One's response drafting.",
            },
          ],
          availableActions: ["Let One draft replies"],
        }
      : null,
  );

  if (!coordinator.isReady) return <SetupCapabilityLoading label="Preparing KYC setup…" />;

  const handleToggle = (checked: boolean) => {
    if (isPrivateRelay) return;
    setEnabled(checked);
    if (user?.uid) void saveEmailDraftingEnabled(user.uid, checked);
  };

  return (
    <div className="space-y-4 pb-[calc(var(--app-bottom-inset)+1rem)]">
      <SettingsGroup
        eyebrow="KYC"
        title="Prepare replies with One"
        description={
          isPrivateRelay
            ? "We can't verify replies for a private relay address yet. We're working on support for private relay addresses."
            : "One prepares replies you approve before anything sends. You stay in control."
        }
      >
        <SettingsRow
          title="Let One draft replies"
          description={enabled ? "On" : "Off"}
          trailing={
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              disabled={isPrivateRelay}
              aria-label="Let One draft replies"
              data-voice-control-id="one-setup-email-drafting-toggle"
            />
          }
        />
      </SettingsGroup>

      <Link
        href={ROUTES.ONE_KYC}
        className="type-footnote block text-center text-[color:var(--app-accent-deep)] transition-opacity hover:opacity-70"
      >
        Open KYC
      </Link>

      <SetupCapabilityTerminalFooter
        capabilityId="email"
        isOperationallyReady={loaded}
        coordinator={coordinator}
      />
    </div>
  );
}
