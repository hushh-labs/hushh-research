import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";
import type { PkmDomainAccessPresentation, PkmDomainPresentation } from "./pkm-profile-presentation";

export type PkmAccessConnectionPresentation = {
  id: string;
  personUserId?: string | null;
  requesterLabel: string;
  requesterImageUrl?: string | null;
  counterpartType: ConsentCenterEntry["counterpart_type"];
  domains: string[];
  grants: PkmDomainAccessPresentation[];
  broadAccessCount: number;
  accessCount: number;
};

export function buildPkmAccessConnections(
  domains: PkmDomainPresentation[]
): PkmAccessConnectionPresentation[] {
  const grouped = new Map<string, PkmAccessConnectionPresentation>();
  for (const domain of domains) {
    for (const grant of domain.accessEntries) {
      const key = `${grant.counterpartType}:${grant.requesterLabel}`;
      const current = grouped.get(key);
      if (current) {
        if (current.personUserId !== grant.counterpartUserId) current.personUserId = null;
        current.grants.push(grant);
        if (!current.domains.includes(domain.title)) current.domains.push(domain.title);
        current.accessCount += 1;
        if (grant.coverageKind === "broad") current.broadAccessCount += 1;
        continue;
      }
      grouped.set(key, {
        id: key,
        personUserId: ["person", "investor", "ria"].includes(grant.counterpartType) ? grant.counterpartUserId : null,
        requesterLabel: grant.requesterLabel,
        requesterImageUrl: grant.requesterImageUrl,
        counterpartType: grant.counterpartType,
        domains: [domain.title],
        grants: [grant],
        broadAccessCount: grant.coverageKind === "broad" ? 1 : 0,
        accessCount: 1,
      });
    }
  }

  return Array.from(grouped.values()).sort((left, right) => {
    if (right.accessCount !== left.accessCount) return right.accessCount - left.accessCount;
    return left.requesterLabel.localeCompare(right.requesterLabel);
  });
}
