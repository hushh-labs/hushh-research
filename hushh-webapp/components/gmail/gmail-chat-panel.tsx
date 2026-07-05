"use client";

import { useCallback, useRef, useState } from "react";
import { RotateCcw, Send, Sparkles } from "lucide-react";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Button } from "@/lib/morphy-ux/button";
import { EmailChatService } from "@/lib/services/email-chat-service";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  errored?: boolean;
}

const SUGGESTIONS = [
  "What needs a reply today?",
  "Find unread emails from this week",
  "Any invoices in my inbox?",
];

const ERROR_TEXT = "Sorry — that couldn't be processed. Try rephrasing.";

/**
 * Inline chat for the Gmail inbox agent — mirrors the Information Marketplace
 * chat. Ask what needs a reply or to find messages; the backend answers over the
 * connected mailbox (read-only). Renders only when the vault is unlocked.
 */
export default function GmailChatPanel({
  vaultOwnerToken,
}: {
  vaultOwnerToken: string | null;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const conversationIdRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const nextId = useCallback(() => `m-${seqRef.current++}`, []);

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy || !vaultOwnerToken) return;
      setInput("");
      setMessages((prev) => [...prev, { id: nextId(), role: "user", text: message }]);
      setBusy(true);
      try {
        const result = await EmailChatService.chat({
          vaultOwnerToken,
          message,
          conversationId: conversationIdRef.current,
        });
        conversationIdRef.current = result.conversationId;
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: result.response },
        ]);
      } catch {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: ERROR_TEXT, errored: true },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, vaultOwnerToken, nextId],
  );

  const clear = useCallback(() => {
    setMessages([]);
    conversationIdRef.current = null;
  }, []);

  if (!vaultOwnerToken) {
    return (
      <SurfaceInset className="px-4 py-4 text-sm sm:px-5 sm:py-5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-foreground">Email assistant</p>
            <p className="text-xs text-muted-foreground">
              Unlock your vault to chat with your inbox.
            </p>
          </div>
        </div>
      </SurfaceInset>
    );
  }

  const hasMessages = messages.length > 0;

  return (
    <SurfaceInset className="space-y-3 px-4 py-4 text-sm sm:px-5 sm:py-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-foreground">Email assistant</p>
            <p className="text-xs text-muted-foreground">
              Ask what needs a reply, or to find anything in your inbox.
            </p>
          </div>
        </div>
        {hasMessages ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear conversation"
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {hasMessages || busy ? (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {messages.map((message) => (
            <div
              key={message.id}
              className={
                message.role === "user" ? "flex justify-end" : "flex justify-start"
              }
            >
              <div
                className={[
                  "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
                  message.role === "user"
                    ? "bg-foreground text-background"
                    : message.errored
                      ? "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300"
                      : "bg-muted/60 text-foreground",
                ].join(" ")}
              >
                {message.text}
              </div>
            </div>
          ))}
          {busy ? (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
                Reading your inbox…
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => void send(suggestion)}
              className="rounded-full border border-[color:var(--app-card-border-standard)] bg-background/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(input);
            }
          }}
          rows={1}
          placeholder="Ask your inbox…"
          className="min-h-[40px] flex-1 resize-none rounded-xl border border-[color:var(--app-card-border-standard)] bg-background/60 px-3 py-2 text-sm outline-none focus:border-foreground/40"
        />
        <Button type="submit" variant="muted" size="icon" disabled={busy || !input.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </SurfaceInset>
  );
}
