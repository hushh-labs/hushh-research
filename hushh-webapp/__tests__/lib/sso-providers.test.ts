import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SSO_PROVIDERS,
  SSO_PROVIDER_BY_ID,
  enabledEnterpriseProviders,
  enabledFederalProviders,
  enabledProviderIds,
  isSamlProviderId,
} from "@/lib/auth/sso-providers";

const ENV_KEY = "NEXT_PUBLIC_SSO_ENABLED_PROVIDERS";

describe("SSO provider registry", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("never renders a dead enterprise button when nothing is enabled", () => {
    // Unset env = only the built-in social providers are live. Showing an
    // enterprise button here would dead-end in "ask your admin".
    expect(enabledEnterpriseProviders()).toEqual([]);
    expect(enabledFederalProviders()).toEqual([]);
    expect(enabledProviderIds()).toEqual(new Set(["google.com", "apple.com"]));
  });

  it("keeps built-in social providers available even if omitted from the env", () => {
    process.env[ENV_KEY] = "oidc.okta";
    const ids = enabledProviderIds();

    expect(ids.has("google.com")).toBe(true);
    expect(ids.has("apple.com")).toBe(true);
    expect(ids.has("oidc.okta")).toBe(true);
  });

  it("surfaces only the enterprise providers that are actually enabled", () => {
    process.env[ENV_KEY] = "microsoft.com, oidc.okta";

    const labels = enabledEnterpriseProviders().map((p) => p.label);
    expect(labels).toEqual(["Microsoft Entra", "Okta"]);
    // Salesforce is in the registry but not enabled, so it must not appear.
    expect(labels).not.toContain("Salesforce");
  });

  it("separates government identities for public-sector onboarding", () => {
    process.env[ENV_KEY] = "oidc.okta,oidc.login-gov,oidc.idme";

    expect(enabledFederalProviders().map((p) => p.id)).toEqual([
      "oidc.login-gov",
      "oidc.idme",
    ]);
    // Federal ids are also enterprise, so they remain in the enterprise list.
    expect(enabledEnterpriseProviders().map((p) => p.id)).toContain("oidc.login-gov");
  });

  it("tolerates whitespace and empty entries in the env list", () => {
    process.env[ENV_KEY] = " oidc.okta , , microsoft.com ";

    const ids = enabledProviderIds();
    expect(ids.has("oidc.okta")).toBe(true);
    expect(ids.has("microsoft.com")).toBe(true);
    expect(ids.has("")).toBe(false);
  });

  it("uses Firebase id conventions so ids match the Identity Platform console", () => {
    for (const provider of SSO_PROVIDERS) {
      if (provider.kind === "oidc") {
        expect(provider.id.startsWith("oidc.")).toBe(true);
      }
      if (provider.kind === "saml") {
        expect(provider.id.startsWith("saml.")).toBe(true);
      }
    }
    // Built-in social providers are bare ids.
    expect(SSO_PROVIDER_BY_ID["google.com"].kind).toBe("oauth");
    expect(SSO_PROVIDER_BY_ID["microsoft.com"].kind).toBe("oauth");
  });

  it("routes only saml.* ids through SAML federation", () => {
    expect(isSamlProviderId("saml.some-agency")).toBe(true);
    expect(isSamlProviderId("oidc.okta")).toBe(false);
    expect(isSamlProviderId("microsoft.com")).toBe(false);
  });
});
