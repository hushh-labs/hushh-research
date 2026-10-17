"use client";

import { useEffect, useState } from "react";
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
export function WorldModelClaimInvitation({
  ownerId,
  vaultKey,
  vaultOwnerToken,
  onClaimed,
}: {
  ownerId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  onClaimed?: () => void;
}) {
  const router = useRouter();
  const query = useSearchParams();
  const [claimToken, setClaimToken] = useState<string | null>(null);
  const [accountSwitchHandoff, setAccountSwitchHandoff] = useState<string | null>(null);
  const [receivedPreview, setReceivedPreview] = useState<
    Awaited<ReturnType<typeof WorldModelInvitationsService.preview>> | null
  >(null);
  const [researchConsent, setResearchConsent] = useState(false);
  const { reload: reloadResearch, preferences } = useWorldModelResearch();
  // The invitation checkbox belongs only to the existing Google research
  // choice. Azure/Bing needs its own disclosure in Personal World Model settings.
  const offerResearch = preferences?.enabled === false &&
    preferences.research_provider === "vertex_google_search";
  const azureResearchOff = preferences?.enabled === false &&
    preferences.research_provider === "azure_openai_web_search";
  const { busy, message, setMessage, guard, run, lifetime } = useWorldModelOwnerAction({
    ownerId,
    vaultKey,
    vaultOwnerToken,
  });
  const session = { vaultKey, vaultOwnerToken };
  useEffect(() => {
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
  }, [ownerId, query]);
  useEffect(() => {
    let active = true;
    setReceivedPreview(null);
    if (claimToken)
      void WorldModelInvitationsService.preview(claimToken)
        .then((row) => {
          if (active) setReceivedPreview(row);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [claimToken]);
  if (!accountSwitchHandoff && !claimToken && !message) return null;
  return (
    <SettingsGroup title="Invitation">
      <div className="space-y-3 px-4 py-3">
        {accountSwitchHandoff && (
          <div className="space-y-2">
            <RowDescription>This invitation was opened with another account.</RowDescription>
            <Button
              size="compact"
              onClick={() =>
                router.replace(worldModelInvitationHandoffRoute(accountSwitchHandoff))
              }
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
                Azure public research stays off after claiming. Open Research and email in your Personal World Model to review Bing search use before turning it on.
              </RowDescription>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                data-voice-control-id="pwm_claim"
                size="compact"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const capture = guard();
                    const actionSession = {
                      ...session,
                      isCurrent: capture.isCurrent,
                      signal: lifetime.current.signal,
                    };
                    const claimed = await WorldModelInvitationsService.claim(
                      actionSession,
                      claimToken,
                      // Only a shown, checked box is a research request.
                      offerResearch && researchConsent,
                    );
                    await capture.assertCurrent();
                    clearWorldModelInvitationHandoffsForToken(claimToken);
                    setMessage(
                      claimed.research_started || claimed.draft_id
                        ? "Claimed. Your model is preparing or ready to review. Nothing was shared back."
                        : azureResearchOff
                          ? "Claimed. Azure public research remains off. Open Research and email in your model to review Bing search use and turn it on. Nothing was shared back."
                        : offerResearch && !researchConsent
                          ? "Claimed. Public research remains off. You can turn it on in your model. Nothing was shared back."
                          : "Claimed. Open your model to check its research status. Nothing was shared back.",
                    );
                    setClaimToken(null);
                    reloadResearch();
                    onClaimed?.();
                    router.replace(ROUTES.PROFILE_WORLD_MODEL);
                    router.refresh();
                  })
                }
              >
                Claim my model
              </Button>
              <Button
                size="compact"
                variant="none"
                disabled={busy}
                data-voice-control-id="pwm_reject"
                onClick={() =>
                  void run(async () => {
                    const capture = guard();
                    const actionSession = {
                      ...session,
                      isCurrent: capture.isCurrent,
                      signal: lifetime.current.signal,
                    };
                    await WorldModelInvitationsService.reject(
                      actionSession,
                      claimToken,
                    );
                    await capture.assertCurrent();
                    clearWorldModelInvitationHandoffsForToken(claimToken);
                    setClaimToken(null);
                    setReceivedPreview(null);
                    router.replace(ROUTES.PROFILE_WORLD_MODEL);
                    setMessage("Invitation declined.");
                  })
                }
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
