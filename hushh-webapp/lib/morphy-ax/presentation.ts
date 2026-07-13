import type { OneVoiceUiState } from "@/lib/voice/voice-ui-state-machine";

import type { MorphyAxPresentationState } from "./types";

export function resolveMorphyAxPresentation(
  state: OneVoiceUiState,
): MorphyAxPresentationState {
  switch (state) {
    case "opening":
      return "orienting";
    case "listening":
      return "listening";
    case "understanding":
    case "intent_preview":
      return "understanding";
    case "needs_consent":
      return "confirming";
    case "acting":
      return "acting";
    case "navigation_settling":
      return "settling";
    case "result":
    case "follow_up":
      return "responding";
    case "error_recovery":
      return "recovering";
    default:
      return "idle";
  }
}
