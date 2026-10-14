import type { ReceiptCategory } from "@/lib/services/gmail-receipts-service";

type ReviewedReceiptMerchant = {
  merchantId: string;
  displayName: string;
  logoDomain: string;
  homepageUrl: string;
  aliases: readonly string[];
  senderDomains: readonly string[];
  includeSubdomains: boolean;
  canRelaySellerReceipts: boolean;
  categoryFallback?: ReceiptCategory;
};

/**
 * Single reviewed source for render-time branding and stable snapshot keys.
 * Aliases match the already-extracted seller label exactly; arbitrary text,
 * sender local-parts, subjects and snippets never generate a logo or homepage.
 * Homepages and logo domains were reviewed against the official sites.
 */
const VERIFIED_MERCHANT_DOMAIN_RULES = [
  {
    merchantId: "myntra",
    displayName: "Myntra",
    senderDomains: ["myntra.com"],
    logoDomain: "myntra.com",
    homepageUrl: "https://www.myntra.com",
    aliases: ["Myntra", "Myntra.com"],
    includeSubdomains: true,
    canRelaySellerReceipts: false,
  },
  {
    merchantId: "amazon",
    displayName: "Amazon",
    senderDomains: ["amazon.com", "amazon.in", "amazon.co.in"],
    logoDomain: "amazon.com",
    homepageUrl: "https://www.amazon.com",
    aliases: ["Amazon", "Amazon.com", "Amazon.in", "Amazon India"],
    includeSubdomains: true,
    canRelaySellerReceipts: true,
  },
  {
    merchantId: "apple",
    displayName: "Apple",
    senderDomains: ["apple.com"],
    logoDomain: "apple.com",
    homepageUrl: "https://www.apple.com",
    aliases: ["Apple", "Apple.com"],
    includeSubdomains: true,
    canRelaySellerReceipts: false,
  },
  {
    merchantId: "paypal",
    displayName: "PayPal",
    senderDomains: ["paypal.com"],
    logoDomain: "paypal.com",
    homepageUrl: "https://www.paypal.com",
    aliases: ["PayPal"],
    includeSubdomains: true,
    canRelaySellerReceipts: true,
  },
  {
    merchantId: "plaid",
    displayName: "Plaid",
    senderDomains: ["plaid.com"],
    logoDomain: "plaid.com",
    homepageUrl: "https://plaid.com",
    aliases: ["Plaid", "Plaid Inc", "Plaid Inc."],
    includeSubdomains: true,
    canRelaySellerReceipts: false,
  },
  {
    merchantId: "supabase",
    displayName: "Supabase",
    senderDomains: ["supabase.com", "supabase.io"],
    logoDomain: "supabase.com",
    homepageUrl: "https://supabase.com",
    aliases: ["Supabase", "Supabase Inc", "Supabase Inc."],
    includeSubdomains: true,
    canRelaySellerReceipts: false,
  },
  {
    merchantId: "kyari",
    displayName: "Kyari",
    senderDomains: ["kyari.co"],
    logoDomain: "kyari.co",
    homepageUrl: "https://kyari.co",
    aliases: ["Kyari", "Kyari.co", "Kyari Pune"],
    includeSubdomains: true,
    canRelaySellerReceipts: false,
  },
  {
    merchantId: "anthropic",
    displayName: "Anthropic",
    senderDomains: ["anthropic.com"],
    logoDomain: "anthropic.com",
    homepageUrl: "https://www.anthropic.com",
    aliases: ["Anthropic", "Anthropic PBC", "Anthropic, PBC", "Claude"],
    includeSubdomains: true,
    canRelaySellerReceipts: false,
  },
  {
    merchantId: "google-play",
    displayName: "Google Play",
    senderDomains: ["google.com"],
    logoDomain: "play.google.com",
    homepageUrl: "https://play.google.com",
    aliases: ["Google Play"],
    includeSubdomains: true,
    canRelaySellerReceipts: false,
  },
  {
    merchantId: "indigo",
    displayName: "IndiGo",
    senderDomains: ["goindigo.in"],
    logoDomain: "goindigo.in",
    homepageUrl: "https://www.goindigo.in",
    aliases: ["IndiGo", "IndiGo Airlines", "InterGlobe Aviation Limited"],
    includeSubdomains: true,
    canRelaySellerReceipts: false,
  },
  {
    // Official contact trainings@internshala.com is published on:
    // trainings.internshala.com/human-resource-management-launchpad/
    merchantId: "internshala-trainings",
    displayName: "Internshala Trainings",
    senderDomains: ["internshala.com"],
    logoDomain: "trainings.internshala.com",
    homepageUrl: "https://trainings.internshala.com",
    aliases: ["Internshala Trainings"],
    includeSubdomains: false,
    canRelaySellerReceipts: false,
    categoryFallback: "Software & Subscriptions",
  },
  {
    // Official sender guidance: support.udemy.com/hc/en-us/articles/1500010880021
    // and /37094869867415. Do not approve the whole udemymail.com namespace.
    merchantId: "udemy",
    displayName: "Udemy",
    senderDomains: ["udemy.com", "email.udemy.com", "e.udemymail.com"],
    logoDomain: "udemy.com",
    homepageUrl: "https://www.udemy.com",
    aliases: ["Udemy"],
    includeSubdomains: false,
    canRelaySellerReceipts: false,
    categoryFallback: "Software & Subscriptions",
  },
] as const satisfies readonly ReviewedReceiptMerchant[];

export type VerifiedReceiptMerchantKey =
  (typeof VERIFIED_MERCHANT_DOMAIN_RULES)[number]["merchantId"];

export type VerifiedReceiptMerchant = {
  categoryFallback?: ReceiptCategory;
  merchantId: VerifiedReceiptMerchantKey;
  displayName: string;
  logoDomain: string;
  homepageUrl: string;
};

type VerifiedMerchantDomainRule = (typeof VERIFIED_MERCHANT_DOMAIN_RULES)[number];

const VERIFIED_LOGO_DOMAINS = new Set<string>(
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

  const bracketedAddress = source.match(/^[^<>]*<([^<>]+)>\s*$/)?.[1]?.trim();
  const address = bracketedAddress || source;
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address)) return null;
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

function findVerifiedMerchantDomainRule(
  senderDomain: string | null | undefined,
): VerifiedMerchantDomainRule | null {
  const normalizedDomain = normalizeReceiptSenderDomain(
    String(senderDomain || ""),
  );
  if (!normalizedDomain) return null;

  return VERIFIED_MERCHANT_DOMAIN_RULES.find((candidate) =>
    candidate.senderDomains.some((verifiedDomain) =>
      matchesVerifiedDomain(
        normalizedDomain,
        verifiedDomain,
        candidate.includeSubdomains,
      ),
    ),
  ) || null;
}

function merchantBrand(rule: VerifiedMerchantDomainRule): VerifiedReceiptMerchant {
  return {
    merchantId: rule.merchantId,
    displayName: rule.displayName,
    logoDomain: rule.logoDomain,
    homepageUrl: rule.homepageUrl,
    ...("categoryFallback" in rule ? { categoryFallback: rule.categoryFallback } : {}),
  };
}

export function resolveVerifiedReceiptMerchant(
  senderDomain: string | null | undefined,
): VerifiedReceiptMerchant | null {
  const rule = findVerifiedMerchantDomainRule(senderDomain);
  return rule ? merchantBrand(rule) : null;
}

export function isVerifiedReceiptMerchantKey(
  key: unknown,
): key is VerifiedReceiptMerchantKey {
  return VERIFIED_MERCHANT_DOMAIN_RULES.some((rule) => rule.merchantId === key);
}

/** Only stable reviewed keys may restore branding from a saved snapshot. */
export function getVerifiedReceiptMerchant(
  key: string | null | undefined,
): VerifiedReceiptMerchant | null {
  const rule = VERIFIED_MERCHANT_DOMAIN_RULES.find((candidate) => candidate.merchantId === key);
  return rule ? merchantBrand(rule) : null;
}

/**
 * Brand the extracted seller/service, never a carrier or payment sender by
 * default. A reviewed relay may corroborate another exact reviewed seller
 * alias. An explicit unreviewed or look-alike domain always fails closed.
 */
export function resolveVerifiedReceiptMerchantBrand(input: {
  merchantName: string | null | undefined;
  merchantDomain?: string | null;
  senderDomain?: string | null;
  senderDomainIsInvalid?: boolean;
}): VerifiedReceiptMerchant | null {
  if (input.senderDomainIsInvalid) return null;
  const name = String(input.merchantName || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!name) return null;
  const seller = VERIFIED_MERCHANT_DOMAIN_RULES.find((candidate) =>
    candidate.aliases.some((alias) => alias.toLowerCase() === name),
  );
  if (!seller) return null;

  const domain = String(input.merchantDomain || input.senderDomain || "").trim();
  if (domain) {
    // A reviewed site/logo host is merchant evidence, not proof of an email sender.
    const reviewedMerchantDomain = Boolean(input.merchantDomain &&
      normalizeReceiptSenderDomain(input.merchantDomain) === seller.logoDomain);
    if (!reviewedMerchantDomain) {
      const domainRule = findVerifiedMerchantDomainRule(domain);
      if (!domainRule || (domainRule.merchantId !== seller.merchantId && !domainRule.canRelaySellerReceipts)) return null;
    }
  }
  return merchantBrand(seller);
}

/** Reconcile legacy platform keys without granting branding to saved null keys. */
export function resolveSavedReceiptMerchantBrand(
  key: string | null | undefined,
  merchantName: string | null | undefined,
): VerifiedReceiptMerchant | null {
  const storedBrand = getVerifiedReceiptMerchant(key);
  return storedBrand ? resolveVerifiedReceiptMerchantBrand({
    merchantName,
    merchantDomain: storedBrand.logoDomain,
  }) : null;
}

export function isVerifiedReceiptLogoDomain(
  domain: string | null | undefined,
): boolean {
  const normalized = normalizeReceiptSenderDomain(String(domain || ""));
  return Boolean(normalized && VERIFIED_LOGO_DOMAINS.has(normalized));
}
