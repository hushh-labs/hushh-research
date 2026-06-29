"use client";

import { useRef, useState } from "react";
import { Maximize2, RotateCcw } from "lucide-react";

import { cn } from "@/lib/utils";
import { BotAvatar } from "./location-chat-atoms";
import { ChatComposer } from "./location-chat-composer";
import { ChatMessageList } from "./location-chat-message-list";
import { LocationChatOverlay } from "./location-chat-overlay";
import { SuggestionChips } from "./location-chat-suggestions";
import { CARD_SURFACE, MUTED_TEXT } from "./tokens";
import { useLocationChat } from "./use-location-chat";

export function LocationChatPanel(props: {
  vaultOwnerToken: string | null;
  onStateChanged?: () => void;
}) {
  const { vaultOwnerToken, onStateChanged } = props;
  const [input, setInput] = useState("");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const chat = useLocationChat({
    vaultOwnerToken: vaultOwnerToken ?? "",
    onStateChanged,
  });

  const submit = () => {
    const message = input.trim();
    if (!message) return;
    setInput("");
    void chat.send(message);
  };

  const sendValue = (value: string) => {
    setInput("");
    void chat.send(value);
  };

  const prefill = (value: string) => {
    setInput(value);
    inputRef.current?.focus();
  };

  if (!vaultOwnerToken) {
    return (
      <section data-testid="location-chat-panel" className={cn(CARD_SURFACE, "p-4")}>
        <div className="flex items-center gap-3">
          <BotAvatar />
          <div>
            <p className="text-sm font-semibold text-foreground">One Location</p>
            <p className={MUTED_TEXT}>Unlock your vault to use the assistant.</p>
          </div>
        </div>
      </section>
    );
  }

  const hasMessages = chat.messages.length > 0;

  return (
    <section data-testid="location-chat-panel" className={cn(CARD_SURFACE, "p-4")}>
      <header className="mb-3 flex items-center gap-3">
        <BotAvatar />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">One Location</p>
          <p className={MUTED_TEXT}>
            Ask who can see you — or make changes by typing.
          </p>
        </div>
        {hasMessages ? (
          <button
            type="button"
            onClick={chat.clear}
            aria-label="Clear conversation"
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setOverlayOpen(true)}
          aria-label="Open focused chat"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </header>

      {hasMessages || chat.busy ? (
        <div className="mb-3">
          <ChatMessageList
            messages={chat.messages}
            busy={chat.busy}
            onRetry={chat.retry}
          />
        </div>
      ) : (
        <div className="mb-3">
          <SuggestionChips onSend={sendValue} onPrefill={prefill} />
        </div>
      )}

      <ChatComposer
        value={input}
        onChange={setInput}
        onSend={submit}
        busy={chat.busy}
        inputRef={inputRef}
      />

      <LocationChatOverlay
        open={overlayOpen}
        onOpenChange={setOverlayOpen}
        messages={chat.messages}
        busy={chat.busy}
        value={input}
        onChange={setInput}
        onSend={submit}
        onRetry={chat.retry}
      />
    </section>
  );
}
