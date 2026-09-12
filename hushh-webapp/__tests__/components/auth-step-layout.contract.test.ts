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
      "normalizeInternalRouteHref(resumeTarget || redirectPath) ??",
    );
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

  it("keeps short-screen content in normal flow instead of a clipped viewport", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );
    const css = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.module.css"),
      "utf8",
    );
    expect(source).not.toContain('height: "calc(100dvh');
    expect(css).toContain("min-block-size: 100svh");
    expect(css).not.toMatch(/overflow:\s*hidden|transform:\s*scale/);
    for (const hook of [
      "data-auth-content-block",
      "data-auth-signin-clusters",
      "data-auth-provider-actions",
      "data-auth-supporting-content",
    ]) {
      expect(source).toContain(hook);
    }
  });
});
