"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import type { MarketplaceChatMessage } from "./use-marketplace-chat";
import { MarketBotAvatar, MarketTypingIndicator } from "./marketplace-chat-atoms";

export function MarketplaceChatMessageList(props: {
  messages: MarketplaceChatMessage[];
  busy: boolean;
  onRetry?: () => void;
}) {
  const { messages, busy, onRetry } = props;
  return (
    <div
      data-testid="marketplace-chat-log"
      role="log"
      aria-live="polite"
      className="flex flex-col gap-3"
    >
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-emerald-500/12 px-3.5 py-2 text-sm text-foreground">
              {message.text}
            </div>
          </div>
        ) : (
          <div key={message.id} className="flex items-start gap-2">
            <MarketBotAvatar size={28} />
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
              {message.errored ? (
                <button
                  type="button"
                  onClick={onRetry}
                  className="mt-1 text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-300"
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
          <MarketBotAvatar size={28} />
          <div className="rounded-2xl rounded-tl-md bg-[color:var(--app-card-surface-compact)] px-3.5 py-2.5">
            <MarketTypingIndicator />
          </div>
        </div>
      ) : null}
    </div>
  );
}
