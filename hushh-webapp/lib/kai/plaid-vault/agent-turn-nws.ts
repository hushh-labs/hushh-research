import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { readFinancialNws } from "./nws-financial-report";
import type { FinancialDomain } from "./types";

export async function loadAgentTurnNws(
  owner: { userId: string; vaultKey: string; vaultOwnerToken: string },
  isCurrent: () => boolean,
) {
  if (!isCurrent()) return null;
  try {
    const snapshot = await PkmDomainResourceService.getStaleFirst({
      userId: owner.userId, vaultKey: owner.vaultKey, vaultOwnerToken: owner.vaultOwnerToken,
      domain: "financial", backgroundRefresh: false,
    });
    return isCurrent() && snapshot?.key.userId === owner.userId
      ? readFinancialNws(snapshot.data as FinancialDomain) : null;
  } catch {
    return null;
  }
}
