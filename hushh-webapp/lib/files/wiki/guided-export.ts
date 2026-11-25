import type { ComputerUseSnapshot } from "@/lib/computer-use/contracts";
import type { ComputerUseCapability } from "@/lib/services/computer-use-client";

export type ExternalAiExportProvider = "chatgpt" | "claude";

export type GuidedAiExportPhase =
  | "idle"
  | "checking_browser"
  | "browser_active"
  | "manual_steps"
  | "waiting_for_emailed_export"
  | "importing_archive"
  | "completed";

export type ExternalAiExportProviderDescriptor = {
  id: ExternalAiExportProvider;
  label: string;
  origin: string;
  allowedOrigins: string[];
  settingsPathLabel: string;
  manualSteps: readonly string[];
};

export const EXTERNAL_AI_EXPORT_PROVIDERS: Record<
  ExternalAiExportProvider,
  ExternalAiExportProviderDescriptor
> = {
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT",
    origin: "https://chatgpt.com",
    allowedOrigins: ["https://chatgpt.com"],
    settingsPathLabel: "Settings → Data controls → Export data",
    manualSteps: [
      "Open ChatGPT Settings → Data controls → Export data.",
      "Confirm Export. ChatGPT emails a download link when ready.",
      "Select the downloaded .zip or conversations.json file below.",
    ],
  },
  claude: {
    id: "claude",
    label: "Claude",
    origin: "https://claude.ai",
    allowedOrigins: ["https://claude.ai"],
    settingsPathLabel: "Settings → Privacy → Export data",
    manualSteps: [
      "Open Claude Settings → Privacy → Export data.",
      "Confirm Export data. Claude emails an archive link when ready.",
      "Select the downloaded .zip or .json file below.",
    ],
  },
};

export type GuidedBrowserEligibility = {
  eligible: boolean;
  reasonCode: string;
  fallbackMessage: string;
};

export function resolveGuidedBrowserEligibility(
  capability: ComputerUseCapability,
): GuidedBrowserEligibility {
  if (!capability.available) {
    return {
      eligible: false,
      reasonCode: capability.code || "BROWSER_CLOUD_GATE_UNAVAILABLE",
      fallbackMessage:
        "Guided Browser sign-in requires a Browser-qualified private pod. Request your export directly and upload the .zip or .json archive below.",
    };
  }
  if (capability.publicResearchOnly) {
    return {
      eligible: false,
      reasonCode: "BROWSER_PUBLIC_RESEARCH_ONLY",
      fallbackMessage:
        "This pod is currently configured for public research only. Request your export directly and upload the .zip or .json archive below.",
    };
  }
  return {
    eligible: true,
    reasonCode: capability.code || "BROWSER_QUALIFIED",
    fallbackMessage: "",
  };
}

export function buildGuidedExportGoal(
  provider: ExternalAiExportProvider,
): string {
  const descriptor = EXTERNAL_AI_EXPORT_PROVIDERS[provider];
  return (
    `Open ${descriptor.origin} and pause for the owner to sign in privately using Take control. ` +
    `After the owner resumes the agent, navigate to ${descriptor.settingsPathLabel} and pause ` +
    `before final export confirmation or report if the provider queued an emailed export archive.`
  );
}

/**
 * Determine the next guided handoff phase when a Browser task reaches a
 * terminal snapshot without having saved a direct `<= 4 MiB` attachment yet.
 */
export function reduceGuidedExportTerminalSnapshot(
  currentPhase: GuidedAiExportPhase,
  snapshot: Pick<ComputerUseSnapshot, "phase" | "downloads">,
): GuidedAiExportPhase {
  if (
    currentPhase === "completed" ||
    currentPhase === "importing_archive" ||
    currentPhase === "waiting_for_emailed_export"
  ) {
    return currentPhase;
  }
  if (snapshot.phase === "completed") {
    const hasDirectAttachment = Boolean(
      snapshot.downloads && snapshot.downloads.length > 0,
    );
    if (!hasDirectAttachment) {
      return "waiting_for_emailed_export";
    }
  }
  if (
    snapshot.phase === "cancelled" ||
    snapshot.phase === "unavailable" ||
    snapshot.phase === "outcome_uncertain"
  ) {
    return "manual_steps";
  }
  return currentPhase;
}
