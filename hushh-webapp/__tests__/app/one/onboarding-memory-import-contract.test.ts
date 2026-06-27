import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const onboardingSource = readFileSync(
  join(process.cwd(), "app/one/onboarding/page.tsx"),
  "utf8",
);

describe("One onboarding memory import card", () => {
  it("shows ChatGPT and Claude import as coming soon only", () => {
    expect(onboardingSource).toContain("MemoryImportComingSoonCard");
    expect(onboardingSource).toContain("Import memory");
    expect(onboardingSource).toContain("Import memory as a whole");
    expect(onboardingSource).toContain("Continue with ChatGPT");
    expect(onboardingSource).toContain("Continue with Claude");
    expect(onboardingSource).toContain("Coming soon");
  });
});
