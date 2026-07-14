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
    // The Terms/Privacy footnote lives inside the glass sheet's own flow
    // (not absolutely positioned outside it), so the sheet's reserved
    // bottom padding is the one place the persistent-agent-bar clearance
    // math must appear, and it must be sized to the sheet's real content
    // rather than pinned to a larger constant that leaves dead scroll space.
    expect(source).toContain(
      "pb-[calc(20px+56px+env(safe-area-inset-bottom,0px)+var(--app-screen-footer-pad))]",
    );
    expect(source).not.toContain(
      "absolute inset-x-6 bottom-[calc(20px+56px",
    );
    expect(source).not.toContain("mt-auto flex-none pt-8");
    expect(source).not.toContain("min-h-[100dvh]");
  });
});
