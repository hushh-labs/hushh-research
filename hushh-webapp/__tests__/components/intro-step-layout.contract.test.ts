import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("IntroStep responsive layout contract", () => {
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

  it("caps the hidden-shell top gutter at the real native status-bar range", () => {
    const styles = readFileSync(
      join(process.cwd(), "components/onboarding/IntroStep.module.css"),
      "utf8",
    );

    expect(styles).toContain(
      "clamp(28px, var(--app-safe-area-top-effective, 0px), 64px)",
    );
  });
});
