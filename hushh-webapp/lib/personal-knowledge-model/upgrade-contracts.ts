export const CURRENT_PKM_MODEL_VERSION = 3;
export const CURRENT_READABLE_SUMMARY_VERSION = 1;
export const DEFAULT_DOMAIN_CONTRACT_VERSION = 1;
export const DOMAIN_CONTRACT_VERSION_MAP: Record<string, number> = {
  financial: 2,
  ria: 1,
};

export function currentDomainContractVersion(domain: string): number {
  const normalized = String(domain || "").trim().toLowerCase();
  return DOMAIN_CONTRACT_VERSION_MAP[normalized] || DEFAULT_DOMAIN_CONTRACT_VERSION;
}
