import { Sparkle } from "@/components/icons";
import type { ModelPreference } from "@/lib/services/model-preference-service";

const INTERNAL_DEPLOYMENT_SLUGS = new Set([
  "one-chat",
  "default",
  "model",
  "chat",
]);

export function formatOwnerModelDisplayLabel(
  providerKey?: string,
  rawModel?: string,
): string {
  const labels: Record<string, string> = {
    azure_openai: "Azure AI",
    gemini: "Gemini",
    openai: "OpenAI",
  };
  const provider = labels[providerKey ?? ""] ?? "Private AI";
  const trimmed = String(rawModel ?? "").trim();
  if (!trimmed) return provider;
  const lower = trimmed.toLowerCase();
  if (
    INTERNAL_DEPLOYMENT_SLUGS.has(lower) ||
    lower === provider.toLowerCase()
  ) {
    return provider;
  }
  const geminiMatch = /^gemini[-_ ]+(\d+(?:\.\d+)?)(?:[-_ ]+(pro|flash(?:[-_ ]+lite)?|ultra|nano))?/i.exec(
    trimmed,
  );
  if (geminiMatch && providerKey === "gemini") {
    const version = geminiMatch[1];
    const tier = geminiMatch[2]
      ? geminiMatch[2]
          .split(/[-_ ]+/)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
          .join(" ")
      : "";
    return tier ? `${provider} · ${version} ${tier}` : `${provider} ${version}`;
  }
  const gptMatch = /^(gpt[-_ ]*[0-9][a-z0-9.-]*)/i.exec(trimmed);
  if (gptMatch) {
    const normalizedGpt = gptMatch[1]!
      .replace(/^gpt[-_ ]*/i, "GPT-")
      .replace(/-(mini|nano)$/i, (_, s: string) => ` ${s.charAt(0).toUpperCase()}${s.slice(1).toLowerCase()}`);
    return `${provider} · ${normalizedGpt}`;
  }
  return `${provider} · ${trimmed}`;
}

/** A configured connection is a calm consumer label; only an admitted catalog is a picker. */
export function OneModelConnection({
  connection,
  fullWidth = false,
}: {
  connection: ModelPreference;
  fullWidth?: boolean;
}) {
  const displayLabel = formatOwnerModelDisplayLabel(
    connection.effective_provider,
    connection.effective_model,
  );
  return (
    <span
      data-testid="agent-chat-model-connection"
      role="group"
      aria-label={`One's AI: ${displayLabel}`}
      title={displayLabel}
      className={`flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-[color:var(--app-card-surface-default-solid)]/85 px-3 text-[12px] font-medium tracking-[-0.01em] text-foreground/85 shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-md dark:border-white/[0.11] dark:bg-white/[0.06] dark:text-foreground/90 dark:shadow-none ${fullWidth ? "min-h-10 w-full py-2" : "h-9 max-w-[7.5rem] shrink-0 sm:max-w-[9.5rem]"}`}
    >
      <Sparkle aria-hidden="true" className="size-3.5 shrink-0 text-foreground/60 dark:text-foreground/70" />
      <span className={`min-w-0 leading-4 ${fullWidth ? "break-all" : "truncate"}`}>
        {displayLabel}
      </span>
    </span>
  );
}
