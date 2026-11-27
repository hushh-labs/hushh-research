import { OneChatBubble } from "@/components/agent/chat-message-styles";

export function LocationChatConversationText({ text }: { text: string }) {
  if (!text) return null;
  return (
    <OneChatBubble tone="assistant" data-message-role="assistant" className="w-fit min-w-0 max-w-full [overflow-wrap:anywhere]">
      <p className="whitespace-pre-line">{text}</p>
    </OneChatBubble>
  );
}
