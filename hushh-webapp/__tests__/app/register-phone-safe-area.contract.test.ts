import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("/register-phone safe-area shell contract", () => {
  it("owns a full viewport without persistent Talk to One chrome and keeps the form above the native keyboard", () => {
    const source = readFileSync(
      join(process.cwd(), "app/register-phone/page.tsx"),
      "utf8",
    );
    const routeContract = readFileSync(
      join(process.cwd(), "lib/navigation/app-route-layout.contract.json"),
      "utf8",
    );
    const styles = readFileSync(
      join(process.cwd(), "app/register-phone/page.module.css"),
      "utf8",
    );

    // This is an immersive verification route, not a hidden-shell route that
    // still carries the persistent Agent Bar. The route contract makes the
    // provider unmount that chrome and clears its reserved scroll padding.
    expect(routeContract).toContain('"route": "/register-phone"');
    expect(routeContract).toContain('"persistentChrome": "none"');
    expect(source).not.toContain("var(--onboarding-agent-bar-clearance)");
    expect(source).not.toContain("--app-scroll-bottom-pad");
    expect(source).not.toContain("--phone-mandate-agent-bar-clearance");
    expect(source).toContain('data-phone-mandate-input-region="true"');
    expect(styles).toContain("block-size: 100dvh");
    expect(styles).toContain("min-block-size: 100svh");
    expect(styles).toContain("bottom: var(--kb-height, 0px)");
    expect(styles).toContain("overflow-y: auto");
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

  it("uses the measured Figma phone composition and shared primary CTA", () => {
    const source = readFileSync(
      join(process.cwd(), "app/register-phone/page.tsx"),
      "utf8",
    );
    const styles = readFileSync(
      join(process.cwd(), "app/register-phone/page.module.css"),
      "utf8",
    );

    expect(source).not.toContain("🤫");
    expect(source).not.toContain("one-quiet-emoji.png");
    expect(source).toContain('sendCodeLabel="Send a verification code"');
    expect(source).toContain("primaryActionClassName={styles.primaryAction}");
    expect(styles).toContain("max-inline-size: 402px");
    expect(styles).toContain("inline-size: min(357px");
    expect(styles).toContain("top: clamp(406px, 105.97vw, 426px)");
    expect(styles).toContain("max-inline-size: 330px");
    expect(styles).toContain("min-block-size: clamp(48px, 12.935vw, 52px)");
  });
});
