"use client";

import { useState } from "react";
import { Laptop, Loader2 } from "lucide-react";

import { useAuth } from "@/lib/firebase";
import { useVault } from "@/lib/vault/vault-context";
import { usePuppyLink } from "@/lib/hermes/use-puppy-link";
import { ApiService } from "@/lib/services/api-service";
import { cn } from "@/lib/utils";

type Turn = { id: string; role: "user" | "assistant"; text: string };

/**
 * The Puppy surface uses the private pod path, not Hermes' local agent loop:
 * frontend API -> owner pod -> Puppy relay -> resident model -> pod response.
 * One keeps orchestration, consent, tools, and conversation ownership. This
 * panel carries only a memory-only transcript and renders the pod's execution
 * metadata so the target cannot be implied from the header.
 */
export function PrivatePuppyInferencePanel({ className }: { className?: string }) {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const link = usePuppyLink();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("Puppy One · private relay");

  async function send() {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    setError("");
    setBusy(true);
    const assistantId = `a-${Date.now()}`;
    const nextTurns = [...turns, { id: `u-${Date.now()}`, role: "user" as const, text: message }];
    setTurns([...nextTurns, { id: assistantId, role: "assistant", text: "" }]);
    try {
      if (!user?.uid || !vaultOwnerToken) throw new Error("PRIVATE_AGENT_UNLOCK_REQUIRED");
      if (link?.state !== "live" || !link.device?.id) throw new Error("PUPPY_OFFLINE");
      const relayStatus = await ApiService.getPuppyRelayStatus(link.device.id);
      if (relayStatus.state === "busy") throw new Error("PUPPY_BUSY");
      if (!relayStatus.inference_ready) {
        throw new Error(
          relayStatus.state === "revoked" ? "PUPPY_REVOKED" : "PUPPY_OFFLINE",
        );
      }
      const status = await ApiService.getPersonalAgentStatus();
      if (status.state !== "active" || !status.hushhId) throw new Error("PRIVATE_AGENT_UNAVAILABLE");
      const grant = await ApiService.issuePuppyInferenceGrant(link.device.id);
      const response = await ApiService.runPodTurn({
        hushhId: status.hushhId,
        message,
        conversationId: "puppy-private-relay",
        runtimeProvider: "puppy",
        puppyDeviceId: link.device.id,
        runtimeCredential: grant.token,
        history: nextTurns.map(({ role, text }) => ({ role, content: text })),
      });
      setTarget(`${response.provider}:${response.model} · ${response.runtimeMode}`);
      setTurns((prior) => prior.map((turn) => (turn.id === assistantId ? { ...turn, text: response.text } : turn)));
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "PRIVATE_AGENT_UNAVAILABLE";
      setError(
        reason === "PUPPY_OFFLINE"
          ? "Puppy unavailable—open Puppy on your computer and try again."
          : reason === "PUPPY_BUSY"
            ? "Puppy is handling another private turn. Try again shortly."
            : reason === "PUPPY_REVOKED"
              ? "Puppy inference access was revoked. Re-link the device to continue."
          : reason === "PRIVATE_AGENT_UNLOCK_REQUIRED"
            ? "Unlock your private agent before using the Puppy relay."
            : "The private Puppy path is unavailable right now. No shared or cloud fallback was used.",
      );
      setTurns((prior) => prior.filter((turn) => turn.id !== assistantId));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs">
        <Laptop className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-medium">{target}</span>
        <span className="ml-auto text-muted-foreground">owner pod</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {turns.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            Ask Puppy One through your private pod. The local model answers; One keeps the tools and consent boundary.
          </p>
        ) : null}
        <div className="flex flex-col gap-3">
          {turns.map((turn) => (
            <div key={turn.id} className={cn("max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm", turn.role === "user" ? "self-end bg-[color:var(--app-accent-surface)]" : "self-start bg-muted/60")}>
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.text}</p>
              {turn.role === "assistant" && busy && !turn.text ? <Loader2 className="size-4 animate-spin" /> : null}
            </div>
          ))}
        </div>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
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
          disabled={busy}
          rows={1}
          placeholder="Ask through your private Puppy relay…"
          className="min-h-10 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none"
        />
        <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()} className="rounded-xl bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50">
          Send
        </button>
      </div>
    </div>
  );
}
