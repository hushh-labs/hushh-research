"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HttpAgent } from "@ag-ui/client";
import { Laptop, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  PuppyModelPicker,
  type ModelSelection,
} from "@/components/agent/puppy-model-picker";
import { cn } from "@/lib/utils";

/**
 * Chat with Puppy One, the agent running on the owner's own machine.
 *
 * Streams through AG-UI rather than awaiting a whole response: the server
 * route translates Hermes's own SSE vocabulary into AG-UI frames, so this
 * panel drives a stock HttpAgent and inherits the same token-delta and
 * tool-activity semantics the cloud agent uses, instead of growing a second
 * streaming stack that would drift from it.
 *
 * The loopback key never reaches this component. It talks only to our own
 * origin; a Next route handler on this machine holds the key.
 */

interface PuppyTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  activity?: string[];
}

interface PuppyStatus {
  connected: boolean;
  reason?: string;
  message?: string;
  model?: string | null;
  busy?: boolean;
}

export function HermesChatPanel({ className }: { className?: string }) {
  const [status, setStatus] = useState<PuppyStatus | null>(null);
  const [turns, setTurns] = useState<PuppyTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [onDevice, setOnDevice] = useState(true);
  const [error, setError] = useState("");
  const sessionRef = useRef<string>("");
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
  }, [turns, sending]);

  const applyModel = useCallback(
    (selection: ModelSelection) => {
      // Hermes applies a model assignment to new sessions only. Keeping the
      // current session would leave the header naming one model while another
      // answered, so the session is dropped and the switch is stated in the
      // transcript rather than happening invisibly.
      sessionRef.current = "";
      setOnDevice(selection.onDevice);
      setStatus((prior) =>
        prior ? { ...prior, model: selection.model } : prior,
      );
      setTurns((prior) => [
        ...prior,
        {
          id: `sys-${Date.now()}`,
          role: "assistant",
          text: selection.onDevice
            ? `Switched to ${selection.model} on this machine. Starting a new session.`
            : `Switched to ${selection.model}. This model runs off this machine. Starting a new session.`,
        },
      ]);
    },
    [],
  );

  const appendDelta = useCallback((assistantId: string, delta: string) => {
    setTurns((prior) =>
      prior.map((turn) =>
        turn.id === assistantId ? { ...turn, text: turn.text + delta } : turn,
      ),
    );
  }, []);

  async function send() {
    const message = draft.trim();
    if (!message || sending) return;
    setDraft("");
    setError("");
    setSending(true);

    const assistantId = `a-${Date.now()}`;
    setTurns((prior) => [
      ...prior,
      { id: `u-${Date.now()}`, role: "user", text: message },
      { id: assistantId, role: "assistant", text: "", activity: [] },
    ]);

    try {
      const agent = new HttpAgent({
        url: "/api/hermes/chat/stream",
        initialMessages: [
          { id: crypto.randomUUID(), role: "user", content: message },
        ],
      });
      await agent.runAgent(
        { forwardedProps: { sessionId: sessionRef.current, onDevice } },
        {
          onTextMessageContentEvent: ({ event }) => {
            appendDelta(assistantId, String(event.delta ?? ""));
          },
          onToolCallStartEvent: ({ event }) => {
            const label = String(event.toolCallName ?? "tool");
            setTurns((prior) =>
              prior.map((turn) =>
                turn.id === assistantId
                  ? { ...turn, activity: [...(turn.activity ?? []), label] }
                  : turn,
              ),
            );
          },
          onRunStartedEvent: ({ event }) => {
            // Hermes uses the session id as the run id, so keeping it gives the
            // next turn continuity in the same conversation.
            const runId = String(
              (event as unknown as { runId?: string }).runId ?? "",
            );
            if (runId) sessionRef.current = runId;
          },
          onRunErrorEvent: ({ event }) => {
            setError(
              String(event.message ?? "") || "Puppy One could not answer.",
            );
          },
        },
      );
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
          <PuppyModelPicker onApplied={applyModel} className="ml-auto" />
        ) : null}
        {connected ? (
          <button
            type="button"
            onClick={() => setOnDevice((value) => !value)}
            aria-pressed={onDevice}
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
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
            {status.message || "Puppy One is not answering on this machine."}
          </p>
        ) : null}
        {connected && turns.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            Ask Puppy One. Its answers are generated on this machine, and this
            conversation stays separate from One.
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
              {turn.activity && turn.activity.length > 0 ? (
                <p className="mb-1.5 text-[11px] text-muted-foreground">
                  {turn.activity.join(" · ")}
                </p>
              ) : null}
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {turn.text}
              </p>
              {turn.role === "assistant" && sending && !turn.text ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : null}
            </div>
          ))}
        </div>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
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
