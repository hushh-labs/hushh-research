import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("AuthStep layout contract", () => {
  it("shows only the quiet brand mark above sign-in, without the floating agents", () => {
    const source = readFileSync(join(process.cwd(), "components/onboarding/AuthStep.tsx"), "utf8");
    expect(source).toContain("lightStyles.brandMark");
    expect(source).toContain("HushhMark");
    expect(source).not.toContain("hushh-auth-mark-light.png");
    expect(source).not.toContain("hushh-auth-mark-dark.png");
    expect(source).not.toContain("brandEmoji");
    expect(source).not.toContain("OneArcIllustration");
    expect(source).not.toContain("screen-3-art.png");
    expect(source).not.toContain("screen-7-art.png");
  });
  it("returns to the canonical onboarding parent instead of browser history", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

    expect(source).toContain("buildWelcomeRoute");
    expect(source).toContain("router.replace(");
    expect(source).not.toContain("router.back()");
  });

  it("canonicalizes the post-auth target before every navigation branch", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

    expect(source).toContain(
      "const explicitTargetPath = normalizeInternalRouteHref(",
    );
    expect(source).toContain("const targetPath = explicitTargetPath ?? ROUTES.HOME;");
    expect(source).toContain("redirectPath: explicitTargetPath ?? undefined,");
    expect(source).not.toContain("ROUTES.KAI_HOME;");
    expect(source).not.toContain("const fallbackPath = targetPath ||");
    expect(source).not.toContain(
      "lastResolvedNavigationPathRef.current || targetPath ||",
    );
  });

  it("keeps the reviewer fixture out of normal sign-in UI", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

    expect(source).toContain(
      "const showReviewer = nativeTestConfig.enabled && nativeReviewerVisible;",
    );
    expect(source).not.toContain("isLocalReviewerSurface");
  });

  it("scopes the Figma presentation by theme and keeps recovery controls reachable", () => {
    const source = readFileSync(join(process.cwd(), "components/onboarding/AuthStep.tsx"), "utf8");
    const css = readFileSync(join(process.cwd(), "components/onboarding/AuthStepLight.module.css"), "utf8");

    // Presentation must not activate the dormant stylesheet or scale the
    // whole page (which also shrinks hit targets on smaller native screens).
    expect(source).toContain('from "./AuthStepLight.module.css"');
    expect(source).not.toContain('from "./AuthStep.module.css"');
    expect(css).toContain(":global(html:not(.dark)) .shell");
    expect(css).toContain(":global(html.dark) .shell");
    expect(css).not.toContain("scale(");
    expect(css).toContain("overflow-y: auto");
    expect(source).toContain('providerAttempt?.phase === "attention_required"');
    expect(source).toContain("disabled={providerBusy}");
    expect(source).toContain("data-auth-provider-actions");
    expect(source).toContain("data-auth-supporting-content");
  });

  it("keeps the legal footer centered on every platform, including 360px Android", () => {
    const source = readFileSync(join(process.cwd(), "components/onboarding/AuthStep.tsx"), "utf8");
    const css = readFileSync(join(process.cwd(), "components/onboarding/AuthStepLight.module.css"), "utf8");
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf("}", start));
    };

    for (const theme of [":global(html:not(.dark))", ":global(html.dark)"]) {
      // The footer centers its content with symmetric insets. A one-sided
      // left offset is what pushed the group off-center on Android phones.
      const footer = rule(`${theme} .footer`);
      expect(footer).toMatch(/justify-content:\s*center/);
      expect(footer).not.toMatch(/padding-left:/);
      const row = rule(`${theme} .legalRow`);
      expect(row).toMatch(/justify-content:\s*center/);
      expect(row).toMatch(/text-align:\s*center/);
      expect(row).not.toMatch(/width:\s*\d+(\.\d+)?px/);
    }
    // No narrow-viewport override re-introduces a fixed left offset.
    expect(css).not.toMatch(/\.footer\s*\{\s*padding-left:/);
    // One layout for all platforms: no platform-only footer class needed.
    expect(source).not.toContain("androidFooter");
    expect(source).toContain("lightStyles.footer)");

    // Terms and Privacy stay real, tappable controls.
    expect(source).toContain('data-voice-control-id="auth_terms"');
    expect(source).toContain('data-voice-control-id="auth_privacy"');
    // The footer links are styled as links, not buttons.
    expect(css).toContain(":global(html:not(.dark)) .legalRow a");
    expect(css).toContain(":global(html.dark) .legalRow a");
    expect(css).not.toContain(".legalRow button");
  });

  it("links Terms and Privacy to their full pages instead of opening a popup", () => {
    const source = readFileSync(join(process.cwd(), "components/onboarding/AuthStep.tsx"), "utf8");

    // Same-tab navigation through next/link: the pre-auth screen holds no
    // state worth keeping, Back returns to sign-in, and in the native static
    // export the route is bundled so the link never leaves the app.
    expect(source).toContain('import Link from "next/link";');
    expect(source).toMatch(/<Link\s+href=\{ROUTES\.TERMS\}\s+data-voice-control-id="auth_terms"/);
    expect(source).toMatch(/<Link\s+href=\{ROUTES\.PRIVACY\}\s+data-voice-control-id="auth_privacy"/);
    expect(source).not.toContain('target="_blank"');
    // Voice takes the same route as a tap.
    expect(source).toContain("router.push(ROUTES.TERMS)");
    expect(source).toContain("router.push(ROUTES.PRIVACY)");

    // No inline legal document: no dialog, no sheet, no overlay to close.
    expect(source).not.toContain("AuthLegalDialog");
    expect(source).not.toContain("openLegalDoc");
    expect(source).not.toContain("activeLegalDoc");
    expect(source).not.toContain("auth.close_legal");
    expect(source).not.toContain("legal_document");
  });
});
