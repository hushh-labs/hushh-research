"use client";

import type { ReactNode } from "react";
import { BusinessProfileSuggestion } from "@/components/agent/business-profile-suggestion";
import { ProfileResearchCard } from "@/components/agent/profile-research-card";

type Props = {
  ownerId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  tokenExpiresAt: number | null;
  enabled: boolean;
  pathname: string;
  renderMessage: (id: string, text: string, card: ReactNode) => ReactNode;
  onBusinessVisibleChange?: (visible: boolean) => void;
  dismissedBusinessUids?: ReadonlySet<string>;
  onBusinessSaved?: (businessUid: string) => void;
};

/** Independent ephemeral capabilities share the chat's owner and vault readiness. */
export function OneBackgroundCards(props: Props) {
  return (
    <>
      <ProfileResearchCard
        ownerId={props.ownerId}
        vaultKey={props.vaultKey}
        vaultOwnerToken={props.vaultOwnerToken}
        enabled={props.enabled}
        pathname={props.pathname}
        renderMessage={(card) =>
          props.renderMessage(
            "profile-research",
            "Let’s review your Magic Intelligence.",
            card,
          )
        }
      />
      <BusinessProfileSuggestion
        ownerId={props.ownerId}
        vaultKey={props.vaultKey}
        vaultOwnerToken={props.vaultOwnerToken}
        tokenExpiresAt={props.tokenExpiresAt}
        enabled={props.enabled}
        onVisibleChange={props.onBusinessVisibleChange}
        dismissedBusinessUids={props.dismissedBusinessUids}
        onSaved={props.onBusinessSaved}
        renderMessage={(id, text, card) =>
          props.renderMessage(`business-suggestion:${id}`, text, card)
        }
      />
    </>
  );
}
