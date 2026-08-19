"use client";

import {
  addToPKM,
  isReservedPkmCard,
  previewAgentPkmMemory,
  type AgentPkmSaveResult,
} from "@/lib/agent/agent-pkm-memory";

type KycIdentityNarrativeParams = {
  userId: string;
  narrative: string;
  vaultKey: string;
  vaultOwnerToken: string;
};

/**
 * Converts a person-approved KYC onboarding narrative into encrypted PKM
 * facts after the UI has progressed. The Continue action is the individual
 * owner confirmation receipt; no raw narrative is persisted by this service.
 */
export async function saveKycIdentityNarrativeInBackground(
  params: KycIdentityNarrativeParams,
): Promise<AgentPkmSaveResult | null> {
  const narrative = params.narrative.trim();
  if (!narrative) return null;

  const preview = await previewAgentPkmMemory({
    userId: params.userId,
    message: narrative,
    // Identity was already initialized by the deterministic KYC profile
    // write. The shared structure agent can additionally route explicitly
    // stated non-identity facts into their canonical domains.
    currentDomains: ["identity"],
    vaultOwnerToken: params.vaultOwnerToken,
  });
  const cards = preview.cards.filter(
    (card) =>
      !isReservedPkmCard(card) &&
      (card.write_mode === "can_save" || card.write_mode === "confirm_first") &&
      (card.sharing_impact?.active_recipient_count || 0) === 0,
  );

  if (cards.length === 0) return null;

  return addToPKM({
    userId: params.userId,
    cards,
    sourceMessage: narrative,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    source: "kyc_identity_background_intake",
    confirmation: {
      confirmedByUser: true,
      surface: "web",
      source: "kyc_identity_continue",
    },
  });
}
