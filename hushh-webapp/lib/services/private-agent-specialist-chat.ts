/**
 * The Email, Location and Information tabs for a person whose agent runs privately.
 *
 * Those tabs post a question and show one reply. For a Shared owner the hub
 * answers it. For anyone else the question is the person's own content and must
 * never reach the hub, so it becomes an ordinary turn on their own agent with a
 * closed `specialistFocus` word (consent-protocol/hushh_mcp/one_adk/specialist_focus.py).
 * The reply keeps the tab's existing shape, so the tab itself does not change.
 *
 * Placement is read once per turn through the same rule chat uses (`usesOwnerPod`):
 * a pinned agent or own cloud goes direct, Shared goes to the hub, and anything
 * else (setup in progress, no placement chosen, paused Hussh Pods, unreadable)
 * refuses with the placement so the copy can say what to do. There is no fallback
 * from the agent to the hub.
 */
import { AuthService } from "./auth-service";

export type SpecialistFocus = "email" | "location" | "information" | "finance";

export type SpecialistChatReply = {
  conversationId: string;
  response: string;
  isComplete: boolean;
  stateChanged: boolean;
};

/**
 * Whether this owner's content belongs to their own agent. False only for a
 * confirmed Shared owner (or no signed-in owner, whom every hub route refuses).
 */
export async function ownerContentIsPrivate(): Promise<boolean> {
  if (!AuthService.getCurrentUser()?.uid) return false;
  const [{ ApiService }, { usesOwnerPod }] = await Promise.all([
    import("./api-service"),
    import("./pod-app-access"),
  ]);
  return usesOwnerPod(() => ApiService.getPersonalAgentStatus());
}

/** One specialist tab turn on the owner's own agent, in the tab's reply shape. */
export async function privateAgentSpecialistTurn(input: {
  focus: SpecialistFocus;
  message?: string | null;
  conversationId?: string | null;
  vaultOwnerToken: string;
  vaultKey: string | null | undefined;
  signal?: AbortSignal;
}): Promise<SpecialistChatReply> {
  const userId = AuthService.getCurrentUser()?.uid;
  if (!userId) throw new Error("PRIVATE_AGENT_SIGN_IN_REQUIRED");
  const message = (input.message ?? "").trim();
  if (!message) throw new Error("Type a message to ask your agent.");
  if (!input.vaultKey) throw new Error("Unlock your vault to chat with your agent.");
  const { streamAgentChat } = await import("./agent-chat-client");
  const result = await streamAgentChat({
    userId,
    message,
    conversationId: input.conversationId ?? null,
    vaultOwnerToken: input.vaultOwnerToken,
    vaultKey: input.vaultKey,
    specialistFocus: input.focus,
    signal: input.signal,
  });
  return {
    conversationId: result.conversationId ?? "",
    response: result.text,
    isComplete: !result.interrupted && !result.detached,
    stateChanged: false,
  };
}
