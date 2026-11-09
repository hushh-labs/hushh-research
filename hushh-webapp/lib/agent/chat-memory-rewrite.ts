/** Stateless preparation on the owner's admitted runtime. Storage stays in the app. */
import { ApiService } from "@/lib/services/api-service";
import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";
import { assertNoUnguardedSecrets } from "@/lib/pkm/secret-span-guard";
import type { ChatMemoryMessage, ChatMemorySession } from "./chat-memory-runtime";

export async function rewriteChatMemory(
  session: ChatMemorySession,
  input: { currentMarkdown: string; messages: ChatMemoryMessage[]; maxTokens: number; signal?: AbortSignal },
): Promise<{ markdown: string }> {
  if (session.isCurrent && !session.isCurrent()) throw new Error("MEMORY_OWNER_CHANGED");
  assertNoUnguardedSecrets([input.currentMarkdown, ...input.messages.map(message => message.content)], { allowIdentifierProcessing: true });
  const privateOwner = await ownerContentIsPrivate();
  const init = {
    method: "POST",
    signal: input.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: session.userId,
      current_markdown: input.currentMarkdown,
      messages: input.messages.map(({ id, conversationId, role, content }) => ({ id, conversationId, role, content })),
      max_tokens: input.maxTokens,
    }),
  };
  const response = privateOwner
    ? await ApiService.ownerPodRequest("memory/rewrite", init, false, undefined, undefined, session.isCurrent)
    : await ApiService.apiFetch("/api/pkm/memory/rewrite", {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${session.vaultOwnerToken}` },
        isEffectCurrent: session.isCurrent,
      });
  if (!response.ok) throw new Error(`MEMORY_REWRITE_FAILED_${response.status}`);
  if (session.isCurrent && !session.isCurrent()) throw new Error("MEMORY_OWNER_CHANGED");
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("markdown" in result) || typeof result.markdown !== "string") {
    throw new Error("INVALID_MEMORY_DOCUMENT");
  }
  return { markdown: result.markdown };
}
