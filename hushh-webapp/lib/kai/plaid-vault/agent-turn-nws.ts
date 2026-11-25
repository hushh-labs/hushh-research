import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { readFinancialNws } from "./nws-financial-report";
import { buildAgentTurnPlaidPosture } from "./plaid-chat-client-tools";
import type { FinancialDomain } from "./types";

export async function loadAgentTurnFinancialProjection(
  owner: { userId: string; vaultKey: string; vaultOwnerToken: string },
  isCurrent: () => boolean,
): Promise<{
  nwsReport: ReturnType<typeof readFinancialNws>;
  plaidPosture: string;
}> {
  if (!isCurrent()) return { nwsReport: null, plaidPosture: "" };
  if (PersonalKnowledgeModelService.isDomainAbsentInCachedMetadata?.(owner.userId, "financial")) {
    return { nwsReport: null, plaidPosture: "" };
  }
  try {
    const snapshot = await PkmDomainResourceService.getStaleFirst({
      userId: owner.userId, vaultKey: owner.vaultKey, vaultOwnerToken: owner.vaultOwnerToken,
      domain: "financial", backgroundRefresh: false,
    });
    if (!isCurrent() || snapshot?.key.userId !== owner.userId || !snapshot.data) {
      return { nwsReport: null, plaidPosture: "" };
    }
    const domain = snapshot.data as FinancialDomain;
    return {
      nwsReport: readFinancialNws(domain),
      plaidPosture: buildAgentTurnPlaidPosture(domain),
    };
  } catch {
    return { nwsReport: null, plaidPosture: "" };
  }
}

export async function loadAgentTurnNws(
  owner: { userId: string; vaultKey: string; vaultOwnerToken: string },
  isCurrent: () => boolean,
) {
  const { nwsReport } = await loadAgentTurnFinancialProjection(owner, isCurrent);
  return nwsReport;
}
