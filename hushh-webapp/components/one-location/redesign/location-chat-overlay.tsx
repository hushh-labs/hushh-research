"use client";

import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ChatComposer } from "./location-chat-composer";
import { ChatMessageList } from "./location-chat-message-list";
import type { ChatMessage } from "./use-location-chat";

export function LocationChatOverlay(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: ChatMessage[];
  busy: boolean;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onRetry?: () => void;
}) {
  const { open, onOpenChange, messages, busy, value, onChange, onSend, onRetry } =
    props;
  return (
    <KaiControlSurface
      open={open}
      onOpenChange={onOpenChange}
      eyebrow="One Location"
      title="Location assistant"
      description="Ask who can see you, or make changes by typing."
      footer={
        <ChatComposer
          value={value}
          onChange={onChange}
          onSend={onSend}
          busy={busy}
        />
      }
    >
      <ChatMessageList messages={messages} busy={busy} onRetry={onRetry} />
    </KaiControlSurface>
  );
}
