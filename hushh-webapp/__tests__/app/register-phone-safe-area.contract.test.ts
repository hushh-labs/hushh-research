import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("/register-phone safe-area shell contract", () => {
  it("uses centered dynamic viewport height and native safe-area padding variables", () => {
    const source = readFileSync(
      join(process.cwd(), "app/register-phone/page.tsx"),
      "utf8",
    );

    expect(source).toContain("--phone-mandate-safe-pt");
    expect(source).toContain("--phone-mandate-safe-pb");
    expect(source).toContain("var(--app-safe-area-top-effective");
    expect(source).toContain("var(--app-safe-area-bottom-effective");
    expect(source).toContain("h-[100dvh]");
    expect(source).toContain("min-h-[100svh]");
    expect(source).toContain("justify-center");
    expect(source).toContain("overflow-hidden");
    expect(source).toContain("pt-[var(--phone-mandate-safe-pt)]");
    expect(source).toContain("pb-[var(--phone-mandate-safe-pb)]");
    expect(source).not.toContain("min-h-[24rem]");
    expect(source).not.toContain("4vh");
  });

  it("exposes a signed-in sign-out escape without account deletion", () => {
    const source = readFileSync(
      join(process.cwd(), "app/register-phone/page.tsx"),
      "utf8",
    );

    expect(source).toContain('aria-label="Account actions"');
    expect(source).toContain("Sign out");
    expect(source).toContain("signOut({ redirectTo: ROUTES.HOME })");
    expect(source).toContain("setOnboardingRequiredCookie(false)");
    expect(source).toContain("setOnboardingFlowActiveCookie(false)");
    expect(source).not.toContain("Delete account");
  });
});
