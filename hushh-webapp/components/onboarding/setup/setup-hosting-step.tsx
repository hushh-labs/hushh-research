"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import { ApiService } from "@/lib/services/api-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { buildOneSetupCloudRoute, buildOneSetupConnectionsRoute } from "@/lib/navigation/routes";
import { Cloud } from "@/components/icons";
import { SetupNavigationTile } from "./capability-setup-tile";
import { lucideCapabilityIcon } from "@/lib/onboarding/one-capabilities";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";

/** An owner click, never an automatic placement fallback or a navigation side effect. */
function SharedRecoveryChoice({ ownerId, returnTo }: {
  ownerId: string;
  returnTo: string | null;
}) {
  const router = useRouter();
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function continueSetup() {
    const owner = snapshotValidatedAuthSessionOwner();
    if (!owner || owner.userId !== ownerId || inFlight.current) return;
    const current = () => mounted.current && isValidatedAuthSessionOwnerCurrent(owner);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const status = await ApiService.getPersonalAgentStatus();
      if (!current()) return;
      if (status.sharedExperienceRecoveryEnabled !== true ||
          !["shared", "unplaced"].includes(status.hostingMode ?? "unknown")) {
        throw new Error("SETUP_CHANGED");
      }
      await ApiService.selectSharedHosting({ recovery: true, expectedOwnerId: ownerId });
      if (!current()) return;
      const state = await PreVaultUserStateService.bootstrapState(ownerId, { force: true });
      if (!current()) return;
      if (!PreVaultUserStateService.hasOneCloudProject(state)) throw new Error("SETUP_UNCONFIRMED");
      router.push(buildOneSetupConnectionsRoute(returnTo));
    } catch {
      if (current()) setError("We couldn't confirm your setup. Try again; nothing was moved.");
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  }

  return <div data-testid="shared-recovery-choice">
    <SettingsRow title="Start with Hussh" description="One runs on Hussh. Your private information stays locked to you."
      trailing={<Button disabled={busy} onClick={() => void continueSetup()} aria-busy={busy}>
        {busy ? "Getting ready…" : "Continue with Hussh"}
      </Button>} trailingInteractive />
    {error ? <p role="alert" className="px-4 pb-3 text-sm text-destructive">{error}</p> : null}
  </div>;
}


export function SetupHostingStep({ ownerId, returnTo, sharedRecovery, cloudComplete,
  runtimeChoiceComplete, cloudSetupRunning, cloudSetupStageLabel }: {
  ownerId: string | null; returnTo: string | null; sharedRecovery: boolean;
  cloudComplete: boolean; runtimeChoiceComplete: boolean;
  cloudSetupRunning: boolean; cloudSetupStageLabel: string;
}) {
  if (sharedRecovery && ownerId) return cloudComplete ? <SetupNavigationTile
    id="connections" title="Choose your AI"
    description={runtimeChoiceComplete ? "Your AI connection is ready." : "Use Hussh AI or connect your own key."}
    href={buildOneSetupConnectionsRoute(returnTo)} voiceControlId="one_setup_tile_connections"
    icon={lucideCapabilityIcon(Cloud)} tone="connected"
    statusLabel={runtimeChoiceComplete ? "Connected" : "Continue"}
    isComplete={runtimeChoiceComplete} isCurrent={!runtimeChoiceComplete}
  /> : <SharedRecoveryChoice key={ownerId} ownerId={ownerId} returnTo={returnTo} />;
  return <SetupNavigationTile
    id="cloud" title={cloudComplete && runtimeChoiceComplete ? "Agent home" : "Set up your private agent"}
    description={cloudComplete ? runtimeChoiceComplete ? "Your hosting and AI choices are saved."
      : "Finish choosing AI access in your agent setup." : cloudSetupRunning
        ? "Being set up in the background. Keep going; this finishes on its own."
        : "Choose Hussh Shared, your own cloud, or Hussh Pods when available."}
    href={buildOneSetupCloudRoute(returnTo)} voiceControlId="one_setup_tile_cloud"
    icon={lucideCapabilityIcon(Cloud)} tone="connected"
    statusLabel={cloudComplete ? runtimeChoiceComplete ? "Connected" : "Continue"
      : cloudSetupRunning ? cloudSetupStageLabel : "Required"}
    statusTone={cloudComplete && runtimeChoiceComplete ? undefined : "required"}
    isCurrent={!cloudComplete || !runtimeChoiceComplete} isComplete={cloudComplete && runtimeChoiceComplete}
  />;
}
