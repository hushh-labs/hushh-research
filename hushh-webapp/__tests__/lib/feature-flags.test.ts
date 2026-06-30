import { afterEach, describe, expect, it } from "vitest";

import { getVoiceV2Flags } from "@/lib/voice/voice-feature-flags";

describe("feature flags", () => {
  const ORIGINAL_SUBMIT_DEBUG_VISIBLE =
    process.env.NEXT_PUBLIC_VOICE_V2_SUBMIT_DEBUG_VISIBLE;

  afterEach(() => {
    if (ORIGINAL_SUBMIT_DEBUG_VISIBLE === undefined) {
      delete process.env.NEXT_PUBLIC_VOICE_V2_SUBMIT_DEBUG_VISIBLE;
    } else {
      process.env.NEXT_PUBLIC_VOICE_V2_SUBMIT_DEBUG_VISIBLE =
        ORIGINAL_SUBMIT_DEBUG_VISIBLE;
    }
  });

  it("keeps submit debug flag disabled by default when env is missing", () => {
    delete process.env.NEXT_PUBLIC_VOICE_V2_SUBMIT_DEBUG_VISIBLE;

    expect(getVoiceV2Flags().submitDebugVisible).toBe(false);
  });
});
