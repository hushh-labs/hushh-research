"use client";

import { usesAzurePwm } from "@/components/onboarding/setup/pwm-research-disclosure";

import { useEffect } from "react";
import { useWorldModelOwnerState } from "./world-model-owner-state";
import { useRouter, useSearchParams } from "next/navigation";
import { SettingsGroup } from "@/components/profile/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText, RowDescription } from "@/components/app-ui/typography";
import { Checkbox } from "@/components/ui/checkbox";
import { useWorldModelResearch } from "./world-model-provider";
import { useWorldModelOwnerAction } from "./world-model-invitations";
import { WorldModelInvitationsService } from "@/lib/services/world-model-invitations-service";
import { ROUTES } from "@/lib/navigation/routes";
import {
  clearWorldModelInvitationHandoffsForToken,
  needsWorldModelInvitationAccountSwitch,
  readWorldModelInvitationHandoff,
  worldModelInvitationHandoffRoute,
} from "@/lib/world-model/invitation-handoff";

/** Recipient side of an invitation: claim or decline a handoff addressed to their verified contact. */
type ClaimProps = { ownerId: string; vaultKey: string; vaultOwnerToken: string; enabled?: boolean; onClaimed?: () => void; onCompleted?: () => void };
export function useWorldModelClaimInvitation({
  ownerId,
  vaultKey,
  vaultOwnerToken,
  onClaimed,
  onCompleted,
  enabled = true,
}: ClaimProps) {
  const router = useRouter();
  const query = useSearchParams();
  const { busy, message, setMessage, guard, run, ownerSession } = useWorldModelOwnerAction({ ownerId, vaultKey, vaultOwnerToken, enabled });
  const [claimToken, setClaimToken] = useWorldModelOwnerState<string | null>(ownerSession, null);
  const [accountSwitchHandoff, setAccountSwitchHandoff] = useWorldModelOwnerState<string | null>(ownerSession, null);
  const [receivedPreview, setReceivedPreview] = useWorldModelOwnerState<
    Awaited<ReturnType<typeof WorldModelInvitationsService.preview>> | null
  >(ownerSession, null);
  const [researchConsent, setResearchConsent] = useWorldModelOwnerState(ownerSession, false);
  const { reload: reloadResearch, preferences } = useWorldModelResearch(enabled);
  // The invitation checkbox belongs only to the existing Google research
  // choice. Azure/Bing needs its own disclosure in Personal World Model settings.
  const offerResearch = preferences?.enabled === false &&
    preferences.research_provider === "vertex_google_search";
  const azureResearchOff = preferences?.enabled === false &&
    usesAzurePwm(preferences.research_provider);
  const session = { vaultKey, vaultOwnerToken };
  useEffect(() => {
    if (!enabled) return;
    const syncToken = () => {
      const handoff = query.get("handoff");
      const recovered = handoff
        ? readWorldModelInvitationHandoff(handoff, ownerId)
        : null;
      setAccountSwitchHandoff(
        handoff && !recovered && needsWorldModelInvitationAccountSwitch(handoff, ownerId)
          ? handoff
          : null,
      );
      setClaimToken(
        recovered ||
          new URLSearchParams(window.location.hash.slice(1)).get("claim"),
      );
    };
    syncToken();
    window.addEventListener("hashchange", syncToken);
    return () => window.removeEventListener("hashchange", syncToken);
  }, [ownerId, query, enabled, setAccountSwitchHandoff, setClaimToken]);
  useEffect(() => {
    let active = true;
    setReceivedPreview(null);
    if (enabled && claimToken)
      void WorldModelInvitationsService.preview(claimToken)
        .then((row) => {
          if (active) setReceivedPreview(row);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [claimToken, enabled, setReceivedPreview]);
  const complete = () => {
    if (onCompleted) onCompleted();
    else { router.replace(ROUTES.PROFILE_WORLD_MODEL); router.refresh(); }
  };
  const claim = () => run(async () => {
    if (!claimToken) return;
    const capture = guard();
    const claimed = await WorldModelInvitationsService.claim({ ...session, isCurrent: capture.isCurrent, signal: ownerSession.controller.signal }, claimToken, offerResearch && researchConsent);
    await capture.assertCurrent();
    clearWorldModelInvitationHandoffsForToken(claimToken);
    setMessage(claimed.research_started || claimed.draft_id
      ? "Claimed. Your model is preparing or ready to review. Nothing was shared back."
      : azureResearchOff
        ? "Claimed. Azure public research remains off. Open Research and email in your model to review search-provider use and turn it on. Nothing was shared back."
        : offerResearch && !researchConsent
          ? "Claimed. Public research remains off. You can turn it on in your model. Nothing was shared back."
          : "Claimed. Open your model to check its research status. Nothing was shared back.");
    setClaimToken(null); reloadResearch(); onClaimed?.(); complete();
  });
  const decline = () => run(async () => {
    if (!claimToken) return;
    const capture = guard(); await WorldModelInvitationsService.reject({ ...session, isCurrent: capture.isCurrent, signal: ownerSession.controller.signal }, claimToken); await capture.assertCurrent();
    clearWorldModelInvitationHandoffsForToken(claimToken); setClaimToken(null); setReceivedPreview(null);
    setMessage("Invitation declined."); complete();
  });
  return { claimToken, accountSwitchHandoff, receivedPreview, researchConsent, setResearchConsent, offerResearch, azureResearchOff,
    busy, message, claim, decline, reviewOtherAccount: () => {
      if (accountSwitchHandoff) router.replace(worldModelInvitationHandoffRoute(accountSwitchHandoff));
    } };
}

export function WorldModelClaimInvitation(props: ClaimProps) {
  const { claimToken, accountSwitchHandoff, receivedPreview, researchConsent, setResearchConsent, offerResearch, azureResearchOff,
    busy, message, claim, decline, reviewOtherAccount } = useWorldModelClaimInvitation(props);
  if (!accountSwitchHandoff && !claimToken && !message) return null;
  return (
    <SettingsGroup title="Invitation">
      <div className="space-y-3 px-4 py-3">
        {accountSwitchHandoff && (
          <div className="space-y-2">
            <RowDescription>This invitation was opened with another account.</RowDescription>
            <Button
              size="compact"
              onClick={reviewOtherAccount}
            >
              Review invitation with this account
            </Button>
          </div>
        )}
        {claimToken && (
          <div className="space-y-2">
            <RowDescription className="break-words [overflow-wrap:anywhere]">
              Someone invited you to prepare your Personal World Model. Claim
              it to review your own research here, or decline. Nothing is shared
              back with them.
            </RowDescription>
            {receivedPreview && "subject_name" in receivedPreview && receivedPreview.subject_name ? (
              <RowDescription>Invitation for {receivedPreview.subject_name}</RowDescription>
            ) : null}
            {receivedPreview && "report" in receivedPreview && (
              <div className="space-y-2 break-words [overflow-wrap:anywhere]">
                <RowDescription>{receivedPreview.introduction}</RowDescription>
                <RowDescription>Prepared by the person who invited you</RowDescription>
                {receivedPreview.report.sections.map((section) => (
                  <ul key={section.kind} className="space-y-2">
                    {section.facts.map((fact, index) => (
                      <RowDescription as="li" key={index}>
                        {fact.statement}
                        <div>
                          {fact.sources.map((source) => (
                            <a
                              key={source.url}
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex min-h-11 items-center underline"
                            >
                              {source.title}
                            </a>
                          ))}
                        </div>
                      </RowDescription>
                    ))}
                  </ul>
                ))}
              </div>
            )}
            {offerResearch ? (
              <label className="flex min-h-11 items-center gap-3">
                <Checkbox
                  checked={researchConsent}
                  onCheckedChange={(v) => setResearchConsent(v === true)}
                />
                <RowDescription as="span">
                  Turn public research back on after claiming
                </RowDescription>
              </label>
            ) : null}
            {azureResearchOff ? (
              <RowDescription>
                Azure public research stays off after claiming. Open Research and email in your Personal World Model to review search-provider use before turning it on.
              </RowDescription>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                data-voice-control-id="pwm_claim"
                size="compact"
                disabled={busy}
                onClick={() => void claim()}
              >
                Claim my model
              </Button>
              <Button
                size="compact"
                variant="none"
                disabled={busy}
                data-voice-control-id="pwm_reject"
                onClick={() => void decline()}
              >
                Decline
              </Button>
            </div>
          </div>
        )}
        {message && <HelperText role="status">{message}</HelperText>}
      </div>
    </SettingsGroup>
  );
}
