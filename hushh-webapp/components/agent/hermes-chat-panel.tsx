"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Laptop, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Chat with the Hermes agent running on this machine.
 *
 * Deliberately its own thread, not a mode of the cloud One conversation: this
 * is a different agent, with a different model and a different memory, doing
 * its work on the user's own hardware. Mixing those turns into the cloud
 * transcript would make the transcript lie about where each answer came from.
 *
 * The loopback key never reaches this component -- it talks only to our own
 * origin, and a Next route handler on this machine holds the key and makes the
 * loopback call.
 */

interface HermesTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  runtime?: { provider: string | null; model: string | null } | null;
}

interface HermesStatus {
  connected: boolean;
  reason?: string;
  message?: string;
  model?: string | null;
  busy?: boolean;
}

export function HermesChatPanel({ className }: { className?: string }) {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [turns, setTurns] = useState<HermesTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [onDevice, setOnDevice] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/hermes/status", { cache: "no-store" });
      setStatus(await response.json());
    } catch {
      setStatus({ connected: false, reason: "unreachable" });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const timer = setInterval(() => void loadStatus(), 30_000);
    return () => clearInterval(timer);
  }, [loadStatus]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, sending]);

  async function send() {
    const message = draft.trim();
    if (!message || sending) return;
    setDraft("");
    setError("");
    setSending(true);
    const userTurn: HermesTurn = {
      id: `u-${Date.now()}`,
      role: "user",
      text: message,
    };
    setTurns((prior) => [...prior, userTurn]);
    try {
      const response = await fetch("/api/hermes/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionId, onDevice }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload?.message || "Hermes could not answer.");
        return;
      }
      if (payload?.sessionId) setSessionId(String(payload.sessionId));
      setTurns((prior) => [
        ...prior,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: String(payload?.text || ""),
          runtime: payload?.runtime ?? null,
        },
      ]);
    } catch {
      setError("Puppy One is not answering on this machine.");
    } finally {
      setSending(false);
    }
  }

  const connected = status?.connected === true;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs">
        <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
            connected
              ? "bg-[rgba(52,199,89,0.12)] text-[#34C759]"
              : "bg-muted text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              connected ? "bg-current" : "bg-muted-foreground/60",
            )}
          />
          {connected ? (status?.model ?? "connected") : "not connected"}
        </span>
        {connected ? (
          <button
            type="button"
            onClick={() => setOnDevice((value) => !value)}
            aria-pressed={onDevice}
            className={cn(
              "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
              onDevice
                ? "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)]"
                : "text-muted-foreground hover:text-foreground",
            )}
            title={
              onDevice
                ? "Answers are generated on this machine."
                : "Answers may use a cloud model."
            }
          >
            {onDevice ? "on-device" : "any model"}
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!connected && status ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            {status.message ||
              "Puppy One is not answering on this machine."}
          </p>
        ) : null}
        {connected && turns.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            Ask Puppy One, the agent running on this machine. Its answers are
            generated here, and this conversation stays separate from One.
          </p>
        ) : null}
        <div className="flex flex-col gap-3">
          {turns.map((turn) => (
            <div
              key={turn.id}
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm",
                turn.role === "user"
                  ? "self-end bg-[color:var(--app-accent-surface)] text-foreground"
                  : "self-start bg-muted/60",
              )}
            >
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {turn.text}
              </p>
              {turn.runtime?.model ? (
                // Show the runtime that actually ran rather than asserting it.
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {turn.runtime.provider === "lmstudio"
                    ? `on this machine · ${turn.runtime.model}`
                    : turn.runtime.model}
                </p>
              ) : null}
            </div>
          ))}
          {sending ? (
            <div className="self-start rounded-2xl bg-muted/60 px-3.5 py-2.5">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : null}
        </div>
        {error ? (
          <p className="mt-3 text-sm text-destructive">{error}</p>
        ) : null}
        <div ref={endRef} />
      </div>

      <div className="flex items-end gap-2 border-t border-border/60 px-4 py-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          disabled={!connected || sending}
          rows={1}
          placeholder={
            connected ? "Ask Puppy One…" : "Puppy One is not connected"
          }
          className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-border/70 bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
        />
        <Button
          type="button"
          size="icon"
          onClick={() => void send()}
          disabled={!connected || sending || !draft.trim()}
          aria-label="Send to Puppy One"
        >
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  );
}
