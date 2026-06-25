import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("AuthStep layout contract", () => {
  it("keeps the login controls centered without page scroll on mobile viewports", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

    expect(source).toContain("h-[100dvh]");
    expect(source).toContain("min-h-[100svh]");
    expect(source).toContain("overflow-hidden");
    expect(source).toContain("justify-center");
    expect(source).toContain("bottom-[calc(20px+var(--app-screen-footer-pad))]");
    expect(source).not.toContain("mt-auto flex-none pt-8");
    expect(source).not.toContain("min-h-[100dvh]");
  });
});
