import verifiedMerchantsContract from "@/contracts/receipts/verified-merchants.v1.json";

export type VerifiedReceiptMerchant = {
  merchantId: string;
  displayName: string;
  logoDomain: string;
};

type VerifiedMerchantDomainRule = VerifiedReceiptMerchant & {
  senderDomains: readonly string[];
  includeSubdomains: boolean;
};

type ContractMerchant = {
  id: string;
  name: string;
  logo_domain: string;
  sender_domains: readonly string[];
};

/**
 * Reviewed sender-domain mappings are the only source of receipt branding.
 * Sender display names, local-parts, subjects, snippets, and extracted labels
 * are untrusted input and must never select a merchant or logo.
 *
 * The list is the authored contract `contracts/receipts/verified-merchants.v1.json`,
 * shared byte for byte with the backend, so adding a merchant is one reviewed
 * edit rather than two lists that can drift.
 */
const VERIFIED_MERCHANT_DOMAIN_RULES: readonly VerifiedMerchantDomainRule[] = (
  verifiedMerchantsContract.merchants as readonly ContractMerchant[]
).map((merchant) => ({
  merchantId: merchant.id,
  displayName: merchant.name,
  senderDomains: merchant.sender_domains,
  logoDomain: merchant.logo_domain,
  includeSubdomains: true,
}));

const VERIFIED_LOGO_DOMAINS = new Set(
  VERIFIED_MERCHANT_DOMAIN_RULES.map((rule) => rule.logoDomain),
);

export function normalizeReceiptSenderDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !domain ||
    domain.length > 253 ||
    domain.includes("..") ||
    !/^[a-z0-9.-]+$/.test(domain) ||
    domain
      .split(".")
      .some(
        (label) =>
          !label ||
          label.length > 63 ||
          label.startsWith("-") ||
          label.endsWith("-"),
      )
  ) {
    return null;
  }
  return domain;
}

export function extractReceiptSenderDomain(
  fromEmail: string | null | undefined,
): string | null {
  const source = String(fromEmail || "").trim();
  if (!source) return null;

  const bracketedAddress = source.match(/<([^<>]+)>/)?.[1]?.trim();
  const address = bracketedAddress || source;
  const atIndex = address.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === address.length - 1) return null;

  const rawDomain = address
    .slice(atIndex + 1)
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  return normalizeReceiptSenderDomain(rawDomain);
}

function matchesVerifiedDomain(
  senderDomain: string,
  verifiedDomain: string,
  includeSubdomains: boolean,
): boolean {
  return (
    senderDomain === verifiedDomain ||
    (includeSubdomains && senderDomain.endsWith(`.${verifiedDomain}`))
  );
}

export function resolveVerifiedReceiptMerchant(
  senderDomain: string | null | undefined,
): VerifiedReceiptMerchant | null {
  const normalizedDomain = normalizeReceiptSenderDomain(
    String(senderDomain || ""),
  );
  if (!normalizedDomain) return null;

  const rule = VERIFIED_MERCHANT_DOMAIN_RULES.find((candidate) =>
    candidate.senderDomains.some((verifiedDomain) =>
      matchesVerifiedDomain(
        normalizedDomain,
        verifiedDomain,
        candidate.includeSubdomains,
      ),
    ),
  );
  if (!rule) return null;
  return {
    merchantId: rule.merchantId,
    displayName: rule.displayName,
    logoDomain: rule.logoDomain,
  };
}

export function isVerifiedReceiptLogoDomain(
  domain: string | null | undefined,
): boolean {
  const normalized = normalizeReceiptSenderDomain(String(domain || ""));
  return Boolean(normalized && VERIFIED_LOGO_DOMAINS.has(normalized));
}
