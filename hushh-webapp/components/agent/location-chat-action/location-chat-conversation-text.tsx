import { OneChatBubble } from "@/components/agent/chat-message-styles";
import type { AgentMessage } from "@/components/agent/workspace/agent-message-transforms";

export function LocationChatConversationText({ message, text }: {
  message: Pick<AgentMessage, "id" | "status" | "sentAtMs">;
  text: string;
}) {
  if (!text) return null;
  return (
    <div
      data-message-role="assistant"
      data-message-id={message.id}
      data-message-status={message.status}
      data-agent-settled-row={message.status !== "streaming" ? "true" : undefined}
      data-message-sent-at={message.sentAtMs ? new Date(message.sentAtMs).toISOString() : undefined}
      className="motion-step-enter flex w-full items-start justify-start"
    >
      <OneChatBubble tone="assistant" className="w-fit min-w-0 max-w-[90%] [overflow-wrap:anywhere] sm:max-w-[min(82%,48rem)]">
        <p className="whitespace-pre-line">{text}</p>
      </OneChatBubble>
    </div>
  );
}
