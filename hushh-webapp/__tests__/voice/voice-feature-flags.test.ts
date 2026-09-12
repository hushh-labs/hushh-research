import { afterEach, describe, expect, it } from "vitest";

import { getVoiceV2Flags } from "@/lib/voice/voice-feature-flags";

const ORIGINAL_ENV = {
  NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
  NEXT_PUBLIC_LOCATION_COMMAND_RUNTIME_ENABLED:
    process.env.NEXT_PUBLIC_LOCATION_COMMAND_RUNTIME_ENABLED,
  NEXT_PUBLIC_VOICE_V2_ENABLED: process.env.NEXT_PUBLIC_VOICE_V2_ENABLED,
  NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_RESOLUTION_ENABLED:
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_RESOLUTION_ENABLED,
  NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_POLICY_ENFORCEMENT_ENABLED:
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_POLICY_ENFORCEMENT_ENABLED,
  NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED:
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED,
  NEXT_PUBLIC_VOICE_V2_CLIENT_VAD_FALLBACK_ENABLED:
    process.env.NEXT_PUBLIC_VOICE_V2_CLIENT_VAD_FALLBACK_ENABLED,
  NEXT_PUBLIC_MORPHY_AX_ENABLED: process.env.NEXT_PUBLIC_MORPHY_AX_ENABLED,
  NEXT_PUBLIC_ONE_VOICE_FLUID_AUDIO_ENABLED:
    process.env.NEXT_PUBLIC_ONE_VOICE_FLUID_AUDIO_ENABLED,
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
    delete process.env
      .NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_POLICY_ENFORCEMENT_ENABLED;
    delete process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED;

    const flags = getVoiceV2Flags();
    expect(flags.enabled).toBe(true);
    expect(flags.groundedActionResolutionEnabled).toBe(true);
    expect(flags.groundedActionPolicyEnforcementEnabled).toBe(true);
    expect(flags.groundedActionExecutionEnabled).toBe(true);
    expect(flags.clientVadFallbackEnabled).toBe(true);
  });

  it("keeps Location command transport dark except for an explicit UAT build opt-in", () => {
    delete process.env.NEXT_PUBLIC_LOCATION_COMMAND_RUNTIME_ENABLED;
    process.env.NEXT_PUBLIC_APP_ENV = "uat";
    expect(getVoiceV2Flags().locationCommandRuntimeEnabled).toBe(false);

    process.env.NEXT_PUBLIC_LOCATION_COMMAND_RUNTIME_ENABLED = "true";
    expect(getVoiceV2Flags().locationCommandRuntimeEnabled).toBe(true);

    process.env.NEXT_PUBLIC_APP_ENV = "development";
    expect(getVoiceV2Flags().locationCommandRuntimeEnabled).toBe(false);

    process.env.NEXT_PUBLIC_APP_ENV = "production";
    expect(getVoiceV2Flags().locationCommandRuntimeEnabled).toBe(false);
  });

  it("allows disabling grounded execution independently for gradual rollout", () => {
    process.env.NEXT_PUBLIC_VOICE_V2_ENABLED = "1";
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_RESOLUTION_ENABLED = "1";
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_POLICY_ENFORCEMENT_ENABLED =
      "1";
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED = "0";

    const flags = getVoiceV2Flags();
    expect(flags.groundedActionResolutionEnabled).toBe(true);
    expect(flags.groundedActionPolicyEnforcementEnabled).toBe(true);
    expect(flags.groundedActionExecutionEnabled).toBe(false);
  });

  it("keeps Morphy AX off by default and independently reversible", () => {
    delete process.env.NEXT_PUBLIC_MORPHY_AX_ENABLED;
    expect(getVoiceV2Flags().morphyAxEnabled).toBe(false);
    process.env.NEXT_PUBLIC_MORPHY_AX_ENABLED = "1";
    expect(getVoiceV2Flags().morphyAxEnabled).toBe(true);
  });

  it("keeps native FluidAudio opt-in and reversible", () => {
    delete process.env.NEXT_PUBLIC_ONE_VOICE_FLUID_AUDIO_ENABLED;
    expect(getVoiceV2Flags().nativeFluidAudioEnabled).toBe(false);

    process.env.NEXT_PUBLIC_ONE_VOICE_FLUID_AUDIO_ENABLED = "1";
    expect(getVoiceV2Flags().nativeFluidAudioEnabled).toBe(true);

    process.env.NEXT_PUBLIC_ONE_VOICE_FLUID_AUDIO_ENABLED = "0";
    expect(getVoiceV2Flags().nativeFluidAudioEnabled).toBe(false);
  });
});
