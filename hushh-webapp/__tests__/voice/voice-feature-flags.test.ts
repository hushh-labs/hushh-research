import { afterEach, describe, expect, it } from "vitest";

import { getVoiceV2Flags } from "@/lib/voice/voice-feature-flags";

const ORIGINAL_ENV = {
  NEXT_PUBLIC_VOICE_V2_ENABLED: process.env.NEXT_PUBLIC_VOICE_V2_ENABLED,
  NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_RESOLUTION_ENABLED:
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_RESOLUTION_ENABLED,
  NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_POLICY_ENFORCEMENT_ENABLED:
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_POLICY_ENFORCEMENT_ENABLED,
  NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED:
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("voice-feature-flags", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("defaults grounded action flags from v2 enabled state", () => {
    process.env.NEXT_PUBLIC_VOICE_V2_ENABLED = "1";
    delete process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_RESOLUTION_ENABLED;
    delete process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_POLICY_ENFORCEMENT_ENABLED;
    delete process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED;

    const flags = getVoiceV2Flags();
    expect(flags.enabled).toBe(true);
    expect(flags.groundedActionResolutionEnabled).toBe(true);
    expect(flags.groundedActionPolicyEnforcementEnabled).toBe(true);
    expect(flags.groundedActionExecutionEnabled).toBe(true);
  });

  it("allows disabling grounded execution independently for gradual rollout", () => {
    process.env.NEXT_PUBLIC_VOICE_V2_ENABLED = "1";
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_RESOLUTION_ENABLED = "1";
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_POLICY_ENFORCEMENT_ENABLED = "1";
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED = "0";

    const flags = getVoiceV2Flags();
    expect(flags.groundedActionResolutionEnabled).toBe(true);
    expect(flags.groundedActionPolicyEnforcementEnabled).toBe(true);
    expect(flags.groundedActionExecutionEnabled).toBe(false);
  });
});
