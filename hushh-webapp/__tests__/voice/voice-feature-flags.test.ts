import { afterEach, describe, expect, it } from "vitest";

import { getVoiceV2Flags } from "@/lib/voice/voice-feature-flags";

const originalMorphyAx = process.env.NEXT_PUBLIC_MORPHY_AX_ENABLED;

afterEach(() => {
  if (originalMorphyAx === undefined) {
    delete process.env.NEXT_PUBLIC_MORPHY_AX_ENABLED;
  } else {
    process.env.NEXT_PUBLIC_MORPHY_AX_ENABLED = originalMorphyAx;
  }
});

describe("voice feature flags", () => {
  it("keeps Morphy AX off by default and independently reversible", () => {
    delete process.env.NEXT_PUBLIC_MORPHY_AX_ENABLED;
    expect(getVoiceV2Flags().morphyAxEnabled).toBe(false);

    process.env.NEXT_PUBLIC_MORPHY_AX_ENABLED = "1";
    expect(getVoiceV2Flags().morphyAxEnabled).toBe(true);

    process.env.NEXT_PUBLIC_MORPHY_AX_ENABLED = "0";
    expect(getVoiceV2Flags().morphyAxEnabled).toBe(false);
  });
});
