"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import type { ChatMessage } from "./use-location-chat";
import { BotAvatar, StateChangedNote, TypingIndicator } from "./location-chat-atoms";

export function ChatMessageList(props: {
  messages: ChatMessage[];
  busy: boolean;
  onRetry?: () => void;
}) {
  const { messages, busy, onRetry } = props;
  return (
    <div
      data-testid="location-chat-log"
      role="log"
      aria-live="polite"
      className="flex flex-col gap-3"
    >
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#d4a574]/15 px-3.5 py-2 text-sm text-foreground">
              {message.text}
            </div>
          </div>
        ) : (
          <div key={message.id} className="flex items-start gap-2">
            <BotAvatar size={28} />
            <div className="min-w-0 max-w-[85%]">
              <div
                className={cn(
                  "rounded-2xl rounded-tl-md bg-[color:var(--app-card-surface-compact)] px-3.5 py-2 text-sm text-foreground",
                  "[&_p]:m-0 [&_p+p]:mt-2 [&_ul]:my-1 [&_ul]:pl-4 [&_li]:list-disc",
                  message.errored && "text-muted-foreground",
                )}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.text}
                </ReactMarkdown>
              </div>
              {message.stateChanged ? <StateChangedNote /> : null}
              {message.errored ? (
                <button
                  type="button"
                  onClick={onRetry}
                  className="mt-1 text-xs font-semibold text-[#b8894d] hover:underline"
                >
                  Retry
                </button>
              ) : null}
            </div>
          </div>
        ),
      )}
      {busy ? (
        <div className="flex items-center gap-2">
          <BotAvatar size={28} />
          <div className="rounded-2xl rounded-tl-md bg-[color:var(--app-card-surface-compact)] px-3.5 py-2.5">
            <TypingIndicator />
          </div>
        </div>
      ) : null}
    </div>
  );
}
