/**
 * One's chat transport. A sleeping private agent is woken, not failed: the
 * person sees "Waking your agent" and the same turn is sent once it answers
 * (lib/agent/owner-pod-wake.ts). Hosting selection stays in
 * `ApiService.agentChatRequest`; a direct failure never falls back to the hub.
 */
import { sendWhileAgentWakes } from "@/lib/agent/owner-pod-wake";
import { ApiService } from "@/lib/services/api-service";

export function wakingChatTransport(
  init: RequestInit | undefined,
  onWaking: () => void,
  onChatAdmission: (hushhId: string) => void,
): Promise<Response> {
  return sendWhileAgentWakes(
    () => ApiService.agentChatRequest("/api/one/agent-chat", init ?? {}, true, onChatAdmission),
    {
      signal: init?.signal,
      onWaking,
      isOwnerAgent: async () =>
        (await import("@/lib/services/pod-app-access")).usesOwnerPod(() => ApiService.getPersonalAgentStatus()),
    },
  );
}
