export type VerifiedReceiptMerchant = {
  merchantId: string;
  displayName: string;
  logoDomain: string;
};

type VerifiedMerchantDomainRule = VerifiedReceiptMerchant & {
  senderDomains: readonly string[];
  includeSubdomains: boolean;
};

/**
 * Reviewed sender-domain mappings are the only source of receipt branding.
 * Sender display names, local-parts, subjects, snippets, and extracted labels
 * are untrusted input and must never select a merchant or logo.
 */
const VERIFIED_MERCHANT_DOMAIN_RULES: readonly VerifiedMerchantDomainRule[] = [
  {
    merchantId: "myntra",
    displayName: "Myntra",
    senderDomains: ["myntra.com"],
    logoDomain: "myntra.com",
    includeSubdomains: true,
  },
  {
    merchantId: "amazon",
    displayName: "Amazon",
    senderDomains: ["amazon.com", "amazon.in", "amazon.co.in"],
    logoDomain: "amazon.com",
    includeSubdomains: true,
  },
  {
    merchantId: "apple",
    displayName: "Apple",
    senderDomains: ["apple.com"],
    logoDomain: "apple.com",
    includeSubdomains: true,
  },
  {
    merchantId: "paypal",
    displayName: "PayPal",
    senderDomains: ["paypal.com"],
    logoDomain: "paypal.com",
    includeSubdomains: true,
  },
] as const;

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
