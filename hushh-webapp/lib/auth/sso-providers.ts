// The single source of truth for enterprise sign-in providers in Hussh One.
//
// Agent One supports enterprise SSO on day 0: a person signs in with the
// identity they already carry at work (Microsoft/Entra, Okta, Google Workspace,
// Ping, OneLogin, Duo, Salesforce, Amazon) or with the government (Login.gov,
// ID.me). Google Identity Platform federates all of them; the app needs the
// right provider id and a button.
//
// Ported from the Hussh public front door (hushh-search-console), which proved
// this contract, so both surfaces speak one provider vocabulary.
//
// Two ideas keep this safe to ship before every provider is turned on:
//  1. Provider ids here MUST match the ids configured in the Identity Platform
//     project. Firebase ids: built-in social are bare ("microsoft.com"), OIDC
//     are "oidc.<name>", SAML are "saml.<name>". See AuthService.signInWithSso.
//  2. A provider is only SHOWN once it is actually enabled, via
//     NEXT_PUBLIC_SSO_ENABLED_PROVIDERS (comma-separated ids). We never render a
//     button that dead-ends in "ask your admin".

export type SsoKind = "oauth" | "oidc" | "saml";

export type SsoProvider = {
  /** Firebase / Identity Platform provider id. Must match the console exactly. */
  id: string;
  /** Human label on the button. */
  label: string;
  /** How Firebase federates it (drives which provider class we construct). */
  kind: SsoKind;
  /** An enterprise / workforce identity (vs a consumer social login). */
  enterprise: boolean;
  /** A US government identity (Login.gov / ID.me) for public-sector onboarding. */
  federal?: boolean;
};

/**
 * Every provider Agent One knows how to sign a person in with. Adding a new
 * enterprise IdP is one line here plus the matching Identity Platform config.
 */
export const SSO_PROVIDERS: SsoProvider[] = [
  // Consumer social (built-in, always available).
  { id: "google.com", label: "Google", kind: "oauth", enterprise: false },
  { id: "apple.com", label: "Apple", kind: "oauth", enterprise: false },
  // Workforce IdPs — the identities people already carry at work.
  { id: "microsoft.com", label: "Microsoft Entra", kind: "oauth", enterprise: true },
  { id: "oidc.okta", label: "Okta", kind: "oidc", enterprise: true },
  { id: "oidc.google-workspace", label: "Google Workspace", kind: "oidc", enterprise: true },
  { id: "oidc.ping", label: "Ping Identity", kind: "oidc", enterprise: true },
  { id: "oidc.onelogin", label: "OneLogin", kind: "oidc", enterprise: true },
  { id: "oidc.duo", label: "Cisco Duo", kind: "oidc", enterprise: true },
  { id: "oidc.salesforce", label: "Salesforce", kind: "oidc", enterprise: true },
  { id: "oidc.amazon", label: "Amazon", kind: "oidc", enterprise: true },
  // US government identities for public-sector personnel. Agency workforce IdPs
  // (which front PIV/CAC smartcards and FIDO2) federate as SAML per agency,
  // e.g. saml.<agency>; wire each as it is onboarded.
  { id: "oidc.login-gov", label: "Login.gov", kind: "oidc", enterprise: true, federal: true },
  { id: "oidc.idme", label: "ID.me", kind: "oidc", enterprise: true, federal: true },
];

export const SSO_PROVIDER_BY_ID: Record<string, SsoProvider> = Object.fromEntries(
  SSO_PROVIDERS.map((provider) => [provider.id, provider]),
);

/** Built-in social providers that are always available in any project. */
export const ALWAYS_AVAILABLE_PROVIDER_IDS = ["google.com", "apple.com"] as const;

/**
 * The provider ids actually enabled in the Identity Platform project for this
 * environment, from NEXT_PUBLIC_SSO_ENABLED_PROVIDERS (comma-separated).
 * Unset means only the built-in social providers are live, so we never surface
 * a broken enterprise button in customer-facing onboarding.
 */
export function enabledProviderIds(): Set<string> {
  const raw = process.env.NEXT_PUBLIC_SSO_ENABLED_PROVIDERS?.trim();
  if (!raw) return new Set(ALWAYS_AVAILABLE_PROVIDER_IDS);
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...ALWAYS_AVAILABLE_PROVIDER_IDS, ...ids]);
}

/** Enabled enterprise IdPs to show in onboarding (env-gated). */
export function enabledEnterpriseProviders(): SsoProvider[] {
  const on = enabledProviderIds();
  return SSO_PROVIDERS.filter((provider) => provider.enterprise && on.has(provider.id));
}

/** Enabled US-government IdPs only, for public-sector onboarding surfaces. */
export function enabledFederalProviders(): SsoProvider[] {
  const on = enabledProviderIds();
  return SSO_PROVIDERS.filter((provider) => provider.federal && on.has(provider.id));
}

/** True when the id is a SAML provider (federates via SAMLAuthProvider). */
export function isSamlProviderId(providerId: string): boolean {
  return providerId.startsWith("saml.");
}
