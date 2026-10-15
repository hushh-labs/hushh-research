"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SettingsGroup } from "@/components/profile/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText, RowDescription } from "@/components/app-ui/typography";
import { Checkbox } from "@/components/ui/checkbox";
import { useWorldModelResearch } from "./world-model-provider";
import { useWorldModelOwnerAction } from "./world-model-invitations";
import type { ProfileReport } from "@/lib/services/profile-research-service";
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
  const [receivedPreview, setReceivedPreview] = useState<{
    report: ProfileReport;
    introduction: string;
  } | null>(null);
  const [researchConsent, setResearchConsent] = useState(false);
  const { reload: reloadResearch, preferences } = useWorldModelResearch();
  // Research is on by default, so the choice only exists for a recipient who
  // turned it off; anyone else claims without a research request.
  const offerResearch = preferences?.enabled === false;
  const { busy, message, setMessage, guard, run } = useWorldModelOwnerAction({
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
          if (active && "report" in row) setReceivedPreview(row);
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
              Someone prepared a Personal World Model for you. Claim it to
              review it here, or decline. Nothing is shared back with them.
            </RowDescription>
            {receivedPreview && (
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
            <div className="flex flex-wrap gap-2">
              <Button
                data-voice-control-id="pwm_claim"
                size="compact"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const capture = guard();
                    await WorldModelInvitationsService.claim(
                      session,
                      claimToken,
                      // Only a shown, checked box is a research request.
                      offerResearch && researchConsent,
                    );
                    await capture.assertCurrent();
                    clearWorldModelInvitationHandoffsForToken(claimToken);
                    setMessage(
                      "Claimed. Review your model below. Nothing was shared back.",
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
                    await WorldModelInvitationsService.reject(
                      session,
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
