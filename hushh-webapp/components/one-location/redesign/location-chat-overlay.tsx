"use client";

import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import type { ClientAction } from "@/lib/one-location/types";
import { ActionConfirmCard } from "./action-confirm-card";
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
  pendingAction?: ClientAction | null;
  confirmAction?: () => Promise<void>;
  cancelAction?: () => Promise<void>;
}) {
  const {
    open,
    onOpenChange,
    messages,
    busy,
    value,
    onChange,
    onSend,
    onRetry,
    pendingAction,
    confirmAction,
    cancelAction,
  } = props;
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
      {pendingAction && confirmAction && cancelAction ? (
        <div className="px-4 pb-2 pt-1">
          <ActionConfirmCard
            action={pendingAction}
            busy={busy}
            onConfirm={confirmAction}
            onCancel={cancelAction}
          />
        </div>
      ) : null}
    </KaiControlSurface>
  );
}
