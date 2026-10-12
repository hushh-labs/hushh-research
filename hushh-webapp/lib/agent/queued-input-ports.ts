import { ApiService } from "@/lib/services/api-service";
import { assertNoUnguardedSecrets } from "@/lib/pkm/secret-span-guard";
import { parseQueuedInputStatus, type QueuedInputPorts, type QueuedInputStatus } from "./agent-chat-live-turn-queue";

export function queuedInputPorts(getVaultOwnerToken: () => string | null, readError: (response: Response) => Promise<string>, isCurrent?: () => boolean): QueuedInputPorts {
  const call = async (path: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
    const token = getVaultOwnerToken();
    if (!token) throw new Error("Vault access expired.");
    // Own-cloud owners reach their agent; only a Shared owner's queue is on the hub.
    const response = await ApiService.agentChatRequest(path, { ...init, cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) } }, false, undefined, isCurrent);
    if (!response.ok) throw new Error(await readError(response));
    return ((await response.json()) ?? {}) as Record<string, unknown>;
  };
  const base = (conversationId: string) =>
    `/api/one/agent-chat/runs/${encodeURIComponent(conversationId)}`;
  return {
    enqueue: async (conversationId, clientMessageId, text) => {
      // The same last line as streamAgentChat: a raw secret never leaves.
      assertNoUnguardedSecrets([text]);
      return parseQueuedInputStatus((await call(`${base(conversationId)}/queue`, {
        method: "POST",
        body: JSON.stringify({ client_message_id: clientMessageId, text }),
      })).status);
    },
    withdraw: async (conversationId, clientMessageId) =>
      parseQueuedInputStatus((await call(
        `${base(conversationId)}/queue/${encodeURIComponent(clientMessageId)}`,
        { method: "DELETE" },
      )).status),
    status: async (conversationId, clientMessageIds) => {
      const query = clientMessageIds.map((id) => `ids=${encodeURIComponent(id)}`).join("&");
      const payload = await call(`${base(conversationId)}/queue?${query}`);
      const statuses: Record<string, QueuedInputStatus> = {};
      for (const receipt of Array.isArray(payload.receipts) ? payload.receipts : []) {
        const record = receipt && typeof receipt === "object" ? receipt as Record<string, unknown> : null;
        const id = typeof record?.clientMessageId === "string" ? record.clientMessageId : "";
        if (id) statuses[id] = parseQueuedInputStatus(record?.status);
      }
      return statuses;
    },
    stop: async (conversationId) => {
      const payload = await call(`${base(conversationId)}/stop`, {
        method: "POST", signal: AbortSignal.timeout(10_000),
      });
      const returned = Array.isArray(payload.returned)
        ? payload.returned.filter((id): id is string => typeof id === "string")
        : [];
      return { stopped: payload.stopped === true, returned };
    },
  };
}
