import { Cpu } from "@/components/icons";
import type { ModelPreference } from "@/lib/services/model-preference-service";

/** A configured connection is a label; only an admitted catalog is a picker. */
export function OneModelConnection({ connection, fullWidth = false }: { connection: ModelPreference; fullWidth?: boolean }) {
  const labels: Record<string, string> = { azure_openai: "Azure AI", gemini: "Gemini", openai: "OpenAI" };
  const provider = labels[connection.effective_provider ?? ""] ?? "Your AI";
  const unverified = connection.verification !== "previously_verified";
  const description = `${provider} · ${connection.effective_model}${unverified ? " · Not verified" : ""}`;
  return <span data-testid="agent-chat-model-connection" role="group" aria-label={`One's AI: ${description}`}
    title={description}
    className={`flex min-h-11 items-center gap-1 rounded-full bg-foreground/[0.045] px-2.5 py-1 text-[11px] font-medium text-muted-foreground ${fullWidth ? "w-full" : "h-11 max-w-[7.5rem] sm:max-w-[9.5rem]"}`}>
    <Cpu aria-hidden="true" className="size-4 shrink-0" />
    <span className="flex min-w-0 flex-col leading-3">
      <span className={fullWidth ? "break-all" : "truncate"}>{provider} · {connection.effective_model}</span>
      {unverified ? <span className="whitespace-nowrap">Not verified</span> : null}
    </span>
  </span>;
}
