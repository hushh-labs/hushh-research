"use client";

import { useCallback, useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { isAgentAsleep, isAgentNotAnswering } from "@/lib/feed/agent-presence-policy";
import { useAgentDeploymentFollow } from "@/lib/feed/use-agent-deployment-follow";
import { ApiService } from "@/lib/services/api-service";

/**
 * Ask for your own private agent, and watch it being built.
 *
 * This card exists because the backend for it has been complete for some time and
 * nothing in the product could reach it: `ApiService.provisionPersonalAgent` had zero
 * callers, and the only path that could ever create a pod was a fire-and-forget hook
 * off phone verification whose exceptions are swallowed. That is the whole reason a
 * fully-configured dev environment had every flag on and zero pods.
 *
 * It lives beside the AI-connection card because a pod is EARNED by a working AI
 * connection — the pod runs on the person's own model key, so offering to build one
 * before that key exists would promise compute that cannot answer.
 *
 * State comes from the same poll the dashboard chip uses, so the two can never
 * disagree about what is happening.
 */
export function PrivateAgentCard({
  vaultOwnerToken,
  needsUnlock,
  onRequestVaultUnlock,
}: {
  vaultOwnerToken?: string | null;
  needsUnlock?: boolean;
  onRequestVaultUnlock?: () => void;
}) {
  const { state, hushhId, health } = useAgentDeploymentFollow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlight = state === "provisioning" || state === "connecting";
  const live = state === "active";

  const request = useCallback(async () => {
    if (!vaultOwnerToken) {
      // Creating compute that will hold this person's sealed holdings is an owner
      // act, and the backend gates it on the vault-owner token. Sending them to
      // unlock is the honest response, not a generic failure.
      onRequestVaultUnlock?.();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await ApiService.provisionPersonalAgent({ vaultOwnerToken });
      if (result?.capped) {
        // A ceiling reached is not a failure, and must not read as one. The person
        // did nothing wrong and there is nothing for them to retry.
        setError(
          "We are at capacity for new agents right now. Yours is reserved and will be built shortly.",
        );
      }
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : "";
      // The backend names what a person can act on; pass that through rather than
      // flattening every refusal into one unhelpful sentence.
      setError(
        code.startsWith("PHONE_NOT_VERIFIED")
          ? "Verify your phone number first — that is how your agent is bound to you."
          : "Could not start your agent just now. Please try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  }, [vaultOwnerToken, onRequestVaultUnlock]);

  const description = live
    ? // An allowlist, not `health !== "healthy"`. That test swept up `sleeping`,
      // which `pod_liveness_service` documents as emphatically not a fault, so an
      // economy pod resting between turns was described as failing health checks.
      isAgentNotAnswering(health)
      ? "Running, but not answering health checks right now."
      : isAgentAsleep(health)
        ? "Live and yours. Resting right now, and it wakes the moment you use it."
        : "Live and yours, running on your own compute, isolated to you alone."
    : inFlight
      ? "Being built in the background. Nothing for you to do."
      : state === "failed"
        ? "Setup did not finish. You can ask for it again."
        : "A private agent that runs on compute you own, holding your records where only you can reach them.";

  return (
    <SettingsGroup title="Your private agent">
      <SettingsRow
        title={live ? "Live" : inFlight ? "Being built" : "Not yet built"}
        description={description}
        trailing={
          live ? null : (
            <Button
              size="sm"
              variant={inFlight ? "secondary" : "default"}
              disabled={busy || inFlight}
              onClick={request}
            >
              {busy ? "Starting…" : inFlight ? "Building…" : "Build my agent"}
            </Button>
          )
        }
      />
      {needsUnlock ? (
        <SettingsRow
          title="Vault locked"
          description="Unlock your vault first — your agent is created under your own key."
        />
      ) : null}
      {error ? <SettingsRow title="Something went wrong" description={error} /> : null}
      {live && hushhId ? (
        // Shown so a person can quote it when asking for help, and so an operator
        // has the one identifier that correlates their pod's logs. It is an opaque
        // derived id, never a phone number or an email.
        <SettingsRow title="Agent id" description={hushhId} />
      ) : null}
    </SettingsGroup>
  );
}
