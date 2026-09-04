import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("AuthStep layout contract", () => {
  it("returns to the canonical onboarding parent instead of browser history", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

    expect(source).toContain("buildWelcomeRoute");
    expect(source).toContain("router.replace(");
    expect(source).not.toContain("router.back()");
  });

  it("keeps the login controls centered without page scroll on mobile viewports", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

    expect(source).toContain("h-[100dvh]");
    expect(source).toContain("min-h-[100svh]");
    expect(source).toContain("overflow-hidden");
    expect(source).toContain("justify-center");
    expect(source).toContain(
      "bottom-[calc(20px+56px+env(safe-area-inset-bottom,0px)+var(--app-screen-footer-pad))]",
    );
    expect(source).not.toContain("mt-auto flex-none pt-8");
    expect(source).not.toContain("min-h-[100dvh]");
  });
});

describe("AuthStep enterprise SSO contract", () => {
  const source = () =>
    readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

  it("routes non-social providers through the SSO sign-in path", () => {
    // google/apple keep their platform paths; everything else federates.
    expect(source()).toContain("AuthService.signInWithSso(provider)");
  });

  it("only offers enterprise providers that are enabled for this environment", () => {
    // Guards against rendering a button that dead-ends in "ask your admin".
    expect(source()).toContain("enabledEnterpriseProviders()");
  });

  it("names the provider a person actually tapped in status and error copy", () => {
    const text = source();
    expect(text).toContain("authProviderLabel(");
    // The old ternary would have called Okta "Google".
    expect(text).not.toContain('? "Apple" : "Google"');
  });

  it("gives every enterprise button a governed voice control id", () => {
    // Must match app/login/page.voice-action-contract.json (auth_sso_<slug>).
    expect(source()).toContain("`auth_sso_${ssoSlug(provider.id)}`");
  });

  it("reports enterprise sign-in as a single low-cardinality analytics method", () => {
    expect(source()).toContain("authMethodFor(provider)");
  });
});
