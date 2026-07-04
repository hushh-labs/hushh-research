"use client";

import { useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/lib/morphy-ux/morphy";
import {
  MARKET_CARD_SURFACE,
  MARKET_MUTED_TEXT,
  MarketBotAvatar,
} from "./marketplace-chat-atoms";
import { MarketplaceChatComposer } from "./marketplace-chat-composer";
import { MarketplaceChatMessageList } from "./marketplace-chat-message-list";
import { MarketplaceSuggestionChips } from "./marketplace-chat-suggestions";
import { useMarketplaceChat } from "./use-marketplace-chat";
import type { PublishableSlice } from "@/lib/one-marketplace/service";
import { formatCents } from "@/lib/services/slice-pricing-service";
import { Sparkles } from "lucide-react";

/**
 * The Information Marketplace chat panel — the marketplace's conversational
 * surface. Ask what you've published and what it's worth, approve/deny a pending
 * request (server-side), and get an inline "publish for offers?" card the agent
 * surfaces (tailored to the topic). Publishing runs the page's consent-first flow
 * via `onPublishSlice`.
 */
export function MarketplaceChatPanel(props: {
  vaultOwnerToken: string | null;
  onStateChanged?: () => void;
  onPublishSlice?: (slice: PublishableSlice) => void;
  /** Identity keys ("h:<scopeHandle>", "l:<domain>:<label>") of already-published
   *  slices, so a just-published slice drops off the publish card. */
  publishedSliceKeys?: Set<string>;
}) {
  const { vaultOwnerToken, onStateChanged, onPublishSlice, publishedSliceKeys } = props;
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const chat = useMarketplaceChat({
    vaultOwnerToken: vaultOwnerToken ?? "",
    onStateChanged,
  });

  const isPublished = (slice: PublishableSlice) =>
    Boolean(
      publishedSliceKeys &&
        ((slice.scopeHandle && publishedSliceKeys.has(`h:${slice.scopeHandle}`)) ||
          publishedSliceKeys.has(`l:${slice.domain}:${slice.label}`)),
    );

  const publishCardSlices = (chat.publishCard?.slices ?? []).filter((s) => !isPublished(s));

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
      <section data-testid="marketplace-chat-panel" className={cn(MARKET_CARD_SURFACE, "p-4")}>
        <div className="flex items-center gap-3">
          <MarketBotAvatar />
          <div>
            <p className="text-sm font-semibold text-foreground">Information Marketplace</p>
            <p className={MARKET_MUTED_TEXT}>Unlock your vault to use the assistant.</p>
          </div>
        </div>
      </section>
    );
  }

  const hasMessages = chat.messages.length > 0;

  return (
    <section data-testid="marketplace-chat-panel" className={cn(MARKET_CARD_SURFACE, "p-4")}>
      <header className="mb-3 flex items-center gap-3">
        <MarketBotAvatar />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Marketplace assistant</p>
          <p className={MARKET_MUTED_TEXT}>
            Ask what you&apos;ve published — and what it&apos;s worth.
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
      </header>

      {hasMessages || chat.busy ? (
        <div className="mb-3">
          <MarketplaceChatMessageList
            messages={chat.messages}
            busy={chat.busy}
            onRetry={chat.retry}
          />
        </div>
      ) : (
        <div className="mb-3">
          <MarketplaceSuggestionChips onSend={sendValue} onPrefill={prefill} />
        </div>
      )}

      {chat.publishCard && publishCardSlices.length > 0 ? (
        <div
          data-testid="marketplace-chat-publish-card"
          className="mb-3 rounded-2xl border border-emerald-300/50 bg-emerald-50/50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/15"
        >
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-emerald-900 dark:text-emerald-200">
            <Sparkles className="h-4 w-4" aria-hidden />
            {chat.publishCard.topic
              ? `Publish your ${chat.publishCard.topic} data for offers?`
              : "Publish these for offers?"}
          </div>
          <div className="flex flex-col gap-2">
            {publishCardSlices.map((slice) => (
              <div
                key={`${slice.domain}:${slice.scopeHandle ?? slice.label}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-300/40 bg-background/60 px-3 py-2"
              >
                <div className="min-w-0 text-sm">
                  <span className="font-medium text-foreground">{slice.label}</span>
                  <span className="text-muted-foreground"> · {slice.domainTitle ?? slice.domain}</span>
                  {slice.suggestedPriceCents ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · ~{formatCents(slice.suggestedPriceCents, slice.currency ?? "USD")}/mo
                    </span>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="none"
                  effect="fade"
                  onClick={() => onPublishSlice?.(slice)}
                >
                  Publish
                </Button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={chat.dismissPublishCard}
            className="mt-2 text-xs font-medium text-emerald-700/80 hover:underline dark:text-emerald-300/80"
          >
            Not now
          </button>
        </div>
      ) : null}

      <MarketplaceChatComposer
        value={input}
        onChange={setInput}
        onSend={submit}
        busy={chat.busy}
        inputRef={inputRef}
      />
    </section>
  );
}
