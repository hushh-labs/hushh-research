import type {
  VoiceActionResult,
  VoiceComposedSpeech,
  VoicePlanMode,
  VoicePlanPayload,
  VoiceResponse,
} from "@/lib/voice/voice-types";

export type ComposeVoiceSpeechInput = {
  response: VoiceResponse;
  plan?: VoicePlanPayload;
  actionResult?: VoiceActionResult | null;
  plannerFinalText?: string | null;
  plannerAckText?: string | null;
};

function inferMode(response: VoiceResponse): VoicePlanMode {
  if (response.kind === "clarify") return "clarify";
  if (response.kind === "background_started") return "start_background_and_ack";
  if (response.kind === "execute") return "execute_and_wait";
  return "answer_now";
}

function cleanText(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  return text || null;
}

function getStringData(
  data: Record<string, unknown> | undefined,
  key: string
): string | null {
  const value = data?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function prettifyScreenId(screen: string | null | undefined): string | null {
  const value = cleanText(screen);
  if (!value) return null;
  return value
    .split(/[._-]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function isGenericActionSummary(summary: string | null): boolean {
  const value = String(summary || "").trim().toLowerCase();
  if (!value) return true;
  return (
    value.startsWith("navigated to ") ||
    value.startsWith("opened ") ||
    value.startsWith("opened your ") ||
    value.startsWith("opened the ") ||
    value.startsWith("completed the grounded voice action") ||
    value.startsWith("executed the requested voice action") ||
    value.startsWith("executed the requested kai command") ||
    value.startsWith("opening ") ||
    value.startsWith("open ") ||
    value.startsWith("completed the requested action")
  );
}

function composeNavigationSpeech(actionResult: VoiceActionResult): string | null {
  const data = actionResult.data;
  const surfaceTitle = getStringData(data, "surface_title");
  const surfacePurpose = getStringData(data, "surface_purpose");
  const resolvedTitle = surfaceTitle || prettifyScreenId(actionResult.screen_after);

  if (resolvedTitle && surfacePurpose) {
    return `You're on ${resolvedTitle} now. ${surfacePurpose}`;
  }
  if (resolvedTitle) {
    return `You're on ${resolvedTitle} now.`;
  }
  if (cleanText(actionResult.route_after)) {
    return `Opened ${actionResult.route_after}.`;
  }
  return null;
}

export function composeVoiceSpeechAfterExecution(
  input: ComposeVoiceSpeechInput
): VoiceComposedSpeech | null {
  if (!input.response.speak) return null;

  const mode = input.plan?.mode || inferMode(input.response);
  const actionSummary = cleanText(input.actionResult?.result_summary);
  const actionId = cleanText(input.actionResult?.action_id || input.plan?.action_id);
  const plannerFinalText = cleanText(input.plannerFinalText);
  const plannerAckText = cleanText(input.plannerAckText);
  const fallbackText = cleanText(input.response.message);

  if (mode === "answer_now" || mode === "clarify") {
    const shouldPreferObservedOutcome =
      input.actionResult &&
      input.actionResult.status !== "succeeded" &&
      input.actionResult.status !== "started" &&
      actionSummary;
    return {
      text:
        (shouldPreferObservedOutcome ? actionSummary : null) ||
        plannerFinalText ||
        fallbackText ||
        "",
      segmentType: "final",
    };
  }

  if (mode === "start_background_and_ack") {
    return {
      text: actionSummary || plannerAckText || plannerFinalText || fallbackText || "",
      segmentType: "ack",
    };
  }

  if (input.actionResult) {
    if (input.actionResult.status === "blocked" || input.actionResult.status === "failed") {
      return {
        text: actionSummary || plannerFinalText || fallbackText || "",
        segmentType: "final",
      };
    }

    if (
      input.actionResult.status === "succeeded" &&
      actionId?.startsWith("nav.") &&
      (cleanText(input.actionResult.route_after) || cleanText(input.actionResult.screen_after))
    ) {
      const navigationSpeech = isGenericActionSummary(actionSummary)
        ? composeNavigationSpeech(input.actionResult)
        : null;
      if (navigationSpeech) {
        return {
          text: navigationSpeech,
          segmentType: "final",
        };
      }
    }
  }

  return {
    text: actionSummary || plannerFinalText || fallbackText || "",
    segmentType: "final",
  };
}
