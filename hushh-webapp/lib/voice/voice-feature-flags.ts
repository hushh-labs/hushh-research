"use client";

function isTruthyEnvFlag(raw: string | undefined): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(
    String(raw || "").trim().toLowerCase()
  );
}

function isFalseyEnvFlag(raw: string | undefined): boolean {
  return ["0", "false", "no", "off", "disabled"].includes(
    String(raw || "").trim().toLowerCase()
  );
}

function resolveFlag(raw: string | undefined, defaultValue: boolean): boolean {
  if (isTruthyEnvFlag(raw)) return true;
  if (isFalseyEnvFlag(raw)) return false;
  return defaultValue;
}

export type VoiceV2Flags = {
  enabled: boolean;
  autoturnEnabled: boolean;
  submitDebugVisible: boolean;
  clientVadFallbackEnabled: boolean;
  ttsBackendFallbackEnabled: boolean;
  groundedActionResolutionEnabled: boolean;
  groundedActionPolicyEnforcementEnabled: boolean;
  groundedActionExecutionEnabled: boolean;
};

export function getVoiceV2Flags(): VoiceV2Flags {
  const enabled = resolveFlag(process.env.NEXT_PUBLIC_VOICE_V2_ENABLED, true);
  const groundedActionResolutionEnabled = resolveFlag(
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_RESOLUTION_ENABLED,
    enabled
  );
  return {
    enabled,
    autoturnEnabled: resolveFlag(process.env.NEXT_PUBLIC_VOICE_V2_AUTOTURN_ENABLED, enabled),
    submitDebugVisible: resolveFlag(process.env.NEXT_PUBLIC_VOICE_V2_SUBMIT_DEBUG_VISIBLE, false),
    clientVadFallbackEnabled: resolveFlag(
      process.env.NEXT_PUBLIC_VOICE_V2_CLIENT_VAD_FALLBACK_ENABLED,
      false
    ),
    ttsBackendFallbackEnabled: false,
    groundedActionResolutionEnabled,
    groundedActionPolicyEnforcementEnabled: resolveFlag(
      process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_POLICY_ENFORCEMENT_ENABLED,
      groundedActionResolutionEnabled
    ),
    groundedActionExecutionEnabled: resolveFlag(
      process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED,
      groundedActionResolutionEnabled
    ),
  };
}
