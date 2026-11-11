import { resolveAppEnvironment } from "@/lib/app-env";
import { cn } from "@/lib/utils";

/**
 * Vertex research is enrolled after setup. Azure/Bing research in UAT requires
 * a separate owner opt-in in Personal World Model. Every surface that completes
 * setup renders the matching disclosure directly above its final action.
 */
export const PWM_RESEARCH_DISCLOSURE =
  "Agent One will look up public information about you to prepare your Personal World Model, and email you when it's ready. You review everything before it's saved, and you can turn either off anytime in Personal World Model.";

export const PWM_RESEARCH_DISCLOSURE_COMPACT =
  "One uses public info for your Personal World Model and emails you when ready. Review before saving; turn either off anytime.";

export const PWM_AZURE_RESEARCH_DISCLOSURE =
  "Public research for your Personal World Model is off until you turn it on there. If you do, GPT-5 mini on Microsoft Azure AI plans searches and prepares your draft from public pages. Bing receives search terms that can include your name and verified email or phone outside Azure's compliance and data residency boundary. You review findings before anything is saved, and can turn research and ready email off anytime.";

export const PWM_AZURE_RESEARCH_DISCLOSURE_COMPACT =
  "Azure public research is off until you turn it on in Personal World Model. Bing may receive your name and verified email or phone in search terms outside Azure's compliance and data residency boundary. Review findings before saving; control research and ready email there.";

export const PWM_TAVILY_RESEARCH_DISCLOSURE =
  "Turning this on lets GPT-5 mini on Microsoft Azure AI prepare findings from public pages using Tavily Search. Tavily receives search terms that can include your name and verified email or phone, and may retain and use them to improve its services. Findings stay encrypted for your review until you discard them or delete your account. Only details you accept become confirmed by you. You can turn research and ready email off anytime.";

export function usesAzurePwm(provider: string | null | undefined) {
  return provider === "azure_openai_web_search" || provider === "azure_openai_tavily";
}

export function pwmProviderDisclosure(provider: string | null | undefined) {
  return provider === "azure_openai_tavily"
    ? PWM_TAVILY_RESEARCH_DISCLOSURE
    : PWM_AZURE_RESEARCH_DISCLOSURE;
}

export function PwmResearchDisclosure({ className, compact = false }: { className?: string; compact?: boolean }) {
  const azureResearch = resolveAppEnvironment() === "uat";
  return (
    <p
      className={cn("text-xs text-muted-foreground", className)}
      data-testid="pwm-research-disclosure"
    >
      {azureResearch
        ? compact
          ? "Public research is off until you turn it on in Personal World Model. Review the search provider and information use there before starting."
          : "Public research is off until you turn it on in Personal World Model. Research and email settings explain which services receive your search terms and how your findings are kept before you choose."
        : compact
          ? PWM_RESEARCH_DISCLOSURE_COMPACT
          : PWM_RESEARCH_DISCLOSURE}
    </p>
  );
}
