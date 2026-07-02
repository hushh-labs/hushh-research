"use client";

import type { Ref } from "react";
import { SendHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ChatComposer(props: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const { value, onChange, onSend, busy, inputRef } = props;
  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={inputRef}
        data-testid="location-chat-input"
        value={value}
        disabled={busy}
        rows={1}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
        placeholder="Ask about your location sharing…"
        aria-label="Ask the One Location assistant"
        className={cn(
          "max-h-32 min-h-10 flex-1 resize-none rounded-2xl px-3.5 py-2.5 text-sm",
          "border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]",
          "text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[#d4a574]/40",
        )}
      />
      <Button
        type="button"
        size="icon"
        data-testid="location-chat-send"
        disabled={busy}
        onClick={onSend}
        aria-label="Send"
        className="h-10 w-10 shrink-0 rounded-full"
      >
        <SendHorizontal className="h-4 w-4" />
      </Button>
    </div>
  );
}
