import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("IntroStep responsive layout contract", () => {
  it("keeps one concise privacy assurance", () => {
    const source = readFileSync(join(process.cwd(), "components/onboarding/IntroStep.tsx"), "utf8");
    expect(source).toContain("You choose what to share.");
    expect(source).not.toContain("Your data. Your rules.");
  });
  it("uses one stable small-viewport canvas instead of growing with mobile browser chrome", () => {
    const styles = readFileSync(
      join(process.cwd(), "components/onboarding/IntroStep.module.css"),
      "utf8",
    );

    expect(styles).toContain(
      "block-size: calc(100svh - var(--app-scroll-bottom-pad, 0px));",
    );
    expect(styles).not.toContain(
      "min-height: calc(100dvh - var(--app-scroll-bottom-pad, 0px));",
    );
  });

});
