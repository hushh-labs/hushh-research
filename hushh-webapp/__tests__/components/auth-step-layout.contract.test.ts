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

  it("canonicalizes the post-auth target before every navigation branch", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

    expect(source).toContain(
      "const explicitTargetPath = normalizeInternalRouteHref(",
    );
    expect(source).toContain("const targetPath = explicitTargetPath ?? ROUTES.ONE_HOME;");
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

  it("sizes the page to one viewport without scrolling and vertically centers the complete sign-in block", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

    // Height is set via inline style, not a Tailwind arbitrary-value class:
    // Tailwind's arbitrary calc() parser requires escaped whitespace around
    // +/- operators ("100dvh_-_var(...)"); without it the declaration is
    // invalid CSS and silently dropped, which is what broke this page's
    // sizing and forced full-page scroll on every device.
    expect(source).toContain(
      "calc(100dvh - var(--app-scroll-bottom-pad, 0px))",
    );
    expect(source).toContain(
      "calc(100svh - var(--app-scroll-bottom-pad, 0px))",
    );
    expect(source).toContain("overflow-hidden");
    expect(source).toContain("data-auth-content-block");
    expect(source).toContain(
      'className="relative mx-auto flex w-full max-w-[440px] flex-col justify-center"',
    );
    expect(source).not.toContain("justify-end");
    expect(source).toContain("data-auth-signin-clusters");
    expect(source).toContain("data-auth-provider-actions");
    expect(source).toContain("data-auth-supporting-content");
    expect(source).toContain(
      'className="flex w-full flex-none flex-col items-center gap-6 px-6 pb-6 text-center"',
    );
    expect(source).toContain('className="flex flex-col items-center gap-4"');
    expect(source).toContain('className="flex flex-col items-center gap-3"');
    expect(source).not.toContain("mx-auto mt-1 flex w-fit");
    // The provider buttons sit directly on the shared hero background (no
    // frosted glass card/sheet), matching the welcome ("/") page's
    // direct-on-canvas CTA.
    expect(source).not.toContain(
      "pb-[calc(20px+56px+env(safe-area-inset-bottom,0px)+var(--app-screen-footer-pad))]",
    );
    expect(source).not.toContain("rounded-t-[36px]");
    expect(source).not.toContain("absolute inset-x-6 bottom-[calc(20px+56px");
    expect(source).not.toContain("mt-auto flex-none pt-8");
    expect(source).not.toContain("min-h-[100dvh]");
  });
});
