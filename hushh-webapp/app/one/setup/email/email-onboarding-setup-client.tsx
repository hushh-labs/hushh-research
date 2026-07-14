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
    setEnabled(isPrivateRelay ? false : loadEmailDraftingEnabled(user.uid));
    setLoaded(true);
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
          title: "Email setup",
          purpose: "Turn One's email drafting on or off.",
          controls: [
            {
              id: "one-setup-email-drafting-toggle",
              label: "Let One draft replies",
              type: "toggle",
              actionId: "setup.toggle_email_drafting",
              purpose: "Enable or disable One drafting replies from one@hushh.ai.",
            },
          ],
          availableActions: ["Let One draft replies"],
        }
      : null,
  );

  if (!coordinator.isReady) return <SetupCapabilityLoading label="Preparing email setup…" />;

  const handleToggle = (checked: boolean) => {
    if (isPrivateRelay) return;
    setEnabled(checked);
    if (user?.uid) saveEmailDraftingEnabled(user.uid, checked);
  };

  return (
    <div className="space-y-4 pb-[calc(var(--app-bottom-inset)+1rem)]">
      <SettingsGroup
        eyebrow="Email"
        title="Draft replies from one@hushh.ai"
        description={
          isPrivateRelay
            ? "We can't verify replies for a private relay address yet. We're working on support for this."
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
        Manage email replies
      </Link>

      <SetupCapabilityTerminalFooter
        capabilityId="email"
        isOperationallyReady={loaded}
        coordinator={coordinator}
      />
    </div>
  );
}
