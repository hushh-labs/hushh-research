import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("/register-phone safe-area shell contract", () => {
  it("sizes the page to exactly one viewport and keeps the compact OTP step above the native keyboard", () => {
    const source = readFileSync(
      join(process.cwd(), "app/register-phone/page.tsx"),
      "utf8",
    );

    // The outer app scroll root (app/providers.tsx) already reserves
    // --app-scroll-bottom-pad for the fixed onboarding Agent Bar on every
    // hidden-shell route, including /register-phone. Reserving it a second
    // time (or via --onboarding-agent-bar-clearance directly) doubled the
    // bottom clearance and caused visible excess scroll on mobile.
    expect(source).not.toContain("var(--onboarding-agent-bar-clearance)");
    expect(source).toContain("var(--app-safe-area-top-effective");
    expect(source).not.toContain("--phone-mandate-agent-bar-clearance");
    // Height/offsets are inline styles, not Tailwind arbitrary-value
    // classes: Tailwind's arbitrary calc() parser requires escaped
    // whitespace around +/- operators ("100dvh_-_var(...)"); without it the
    // declaration is invalid CSS and silently dropped, which is what
    // produced 0px paddings/heights and forced full-page scroll here.
    expect(source).toContain(
      "calc(100dvh - var(--app-scroll-bottom-pad, 0px))",
    );
    expect(source).toContain(
      "calc(100svh - var(--app-scroll-bottom-pad, 0px))",
    );
    expect(source).toContain(
      "calc(18px + var(--app-safe-area-top-effective, 0px))",
    );
    expect(source).toContain('data-phone-mandate-input-region="true"');
    expect(source).toContain("var(--kb-height, 0px)");
    expect(source).not.toContain("mt-auto");
    // The active field region owns keyboard clearance; it can scroll only as a
    // compact-screen fallback instead of letting fields slip beneath iOS.
    expect(source).toContain("overflow-y-auto overscroll-contain");
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

  it("keeps phone verification focused without decorative artwork", () => {
    const source = readFileSync(
      join(process.cwd(), "app/register-phone/page.tsx"),
      "utf8",
    );

    expect(source).not.toContain("🤫");
    expect(source).not.toContain("one-quiet-emoji.png");
    expect(source).toContain("Verification is a focused task, not a hero");
  });
});
