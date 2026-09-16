"use client";

function isTruthyEnvFlag(raw: string | undefined): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(
    String(raw || "")
      .trim()
      .toLowerCase(),
  );
}

/** Remaining presentation flag for the shared Morphy AX surface. */
export type VoiceV2Flags = {
  morphyAxEnabled: boolean;
};

export function getVoiceV2Flags(): VoiceV2Flags {
  return {
    morphyAxEnabled: isTruthyEnvFlag(process.env.NEXT_PUBLIC_MORPHY_AX_ENABLED),
  };
}
