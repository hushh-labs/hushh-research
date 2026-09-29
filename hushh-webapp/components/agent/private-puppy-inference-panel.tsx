"use client";

import { useEffect, useRef, useState } from "react";
import { Laptop, Loader2, Send } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";

import { useAuth } from "@/lib/firebase";
import { useVault } from "@/lib/vault/vault-context";
import { usePuppyLink } from "@/lib/hermes/use-puppy-link";
import { refreshPuppyLink } from "@/lib/services/puppy-one-service";
import { ApiService } from "@/lib/services/api-service";
import { PodMemoryConsentRow } from "@/components/agent/pod-memory-consent-row";
import {
  pendingRevocations,
  type PendingRevocation,
} from "@/lib/services/owner-pod-endpoint";
import { cn } from "@/lib/utils";

type Turn = { id: string; role: "user" | "assistant"; text: string };
const PUPPY_TURN_DEADLINE_MS = 205_000;

/**
 * The Puppy surface uses the private pod path, not Hermes' local agent loop:
 * frontend API -> owner pod -> Puppy relay -> resident model -> pod response.
 * One keeps orchestration, consent, tools, and conversation ownership. This
 * panel carries only a memory-only transcript and renders the pod's execution
 * metadata so the target cannot be implied from the header.
 */
export function PrivatePuppyInferencePanel({
  className,
}: {
  className?: string;
}) {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const link = usePuppyLink();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const [target, setTarget] = useState("Your machine · Private connection");
  // Revocations the pod has not received yet ("pending delivery"). Read from the
  // owner-pod store so the surface never claims a revocation landed when it was
  // only couriered.
  const [pending, setPending] = useState<PendingRevocation[]>([]);
  // The owner's agent id, for the memory row. Learned from the same status read
  // `send()` performs, so no second source of truth is introduced.
  const [hushhId, setHushhId] = useState<string | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    let cancelled = false;
    if (!user?.uid) {
      setPending([]);
      return () => {
        cancelled = true;
      };
    }
    void pendingRevocations(user.uid)
      .then((items) => {
        if (!cancelled) setPending(items);
      })
      .catch(() => {
        if (!cancelled) setPending([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid, link?.state, link?.device?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!user?.uid) {
      setHushhId(null);
      return () => {
        cancelled = true;
      };
    }
    void ApiService.getPersonalAgentStatus()
      .then((status) => {
        if (!cancelled)
          setHushhId(
            status.state === "active" && status.hushhId ? status.hushhId : null,
          );
      })
      .catch(() => {
        if (!cancelled) setHushhId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  const pendingForLinkedDevice = pending.filter(
    (item) => !link?.device?.id || item.subjectId === link.device.id,
  );

  async function send() {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    setError("");
    setBusy(true);
    setElapsedSeconds(0);
    const controller = new AbortController();
    const deadline = window.setTimeout(
      () => controller.abort(new DOMException("Puppy did not answer in time", "TimeoutError")),
      PUPPY_TURN_DEADLINE_MS,
    );
    requestRef.current = controller;
    const assistantId = `a-${Date.now()}`;
    const nextTurns = [
      ...turns,
      { id: `u-${Date.now()}`, role: "user" as const, text: message },
    ];
    setTurns([...nextTurns, { id: assistantId, role: "assistant", text: "" }]);
    try {
      if (!user?.uid || !vaultOwnerToken)
        throw new Error("PRIVATE_AGENT_UNLOCK_REQUIRED");
      const status = await ApiService.getPersonalAgentStatus();
      if (status.hostingMode !== "byoc")
        throw new Error("PUPPY_REQUIRES_BYOC_POD");
      if (status.state !== "active" || !status.hushhId)
        throw new Error("PRIVATE_AGENT_UNAVAILABLE");
      // The sidebar poll may still be loading, or may belong to an earlier
      // signed-in owner. Select only from a fresh owner-scoped read at send time.
      const currentLink = await refreshPuppyLink();
      if (!currentLink.device?.id || (currentLink.state !== "live" && currentLink.state !== "quiet"))
        throw new Error("PUPPY_OFFLINE");
      const response = await ApiService.runPodTurn({
        hushhId: status.hushhId,
        vaultOwnerToken,
        message,
        conversationId: "puppy-private-relay",
        runtimeProvider: "puppy",
        puppyDeviceId: currentLink.device.id,
        signal: controller.signal,
        history: nextTurns.map(({ role, text }) => ({ role, content: text })),
      });
      // A heartbeat model is a prior observation, not proof of which model
      // answered this turn. Show a model only when this response reports it.
      setTarget(response.modelReported
        ? `${response.model} · On your machine`
        : "Your machine · Private connection");
      setTurns((prior) =>
        prior.map((turn) =>
          turn.id === assistantId ? { ...turn, text: response.text } : turn,
        ),
      );
    } catch (cause) {
      const cancelled =
        (cause instanceof DOMException || cause instanceof Error) &&
        cause.name === "AbortError";
      const timedOut = (
        controller.signal.reason instanceof DOMException &&
        controller.signal.reason.name === "TimeoutError"
      ) || (cause instanceof Error && cause.name === "TimeoutError");
      const reason =
        cause instanceof Error ? cause.message : "PRIVATE_AGENT_UNAVAILABLE";
      setError(
        timedOut
          ? "Puppy did not answer in time. Check your machine and try again."
          : cancelled
          ? "Puppy request cancelled."
          : reason === "PUPPY_OFFLINE"
          ? "Puppy unavailable—open Puppy on your computer and try again."
          : reason === "PUPPY_REQUIRES_BYOC_POD"
            ? "Puppy needs your active BYOC pod and its private device relay. Shared and Hussh Pods do not run Puppy inference."
          : reason === "PUPPY_BUSY" || reason === "LOCAL_MODEL_OVERLOADED"
            ? "Puppy is handling another private turn. Try again shortly."
            : reason === "PUPPY_REVOKED"
              ? "Puppy inference access was revoked. Re-link the device to continue."
              : reason === "PRIVATE_AGENT_UNLOCK_REQUIRED"
                ? "Unlock your private agent before using the Puppy relay."
                : "The private Puppy path is unavailable right now. No shared or cloud fallback was used.",
      );
      setTurns((prior) => prior.filter((turn) => turn.id !== assistantId));
    } finally {
      window.clearTimeout(deadline);
      if (requestRef.current === controller) requestRef.current = null;
      setBusy(false);
    }
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs">
        <Laptop className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium" data-testid="puppy-target" data-relay="direct">
          {target}
        </span>
        <span className="ml-auto text-muted-foreground">
          {link?.state === "live" ? "Device reporting" : link?.state === "quiet" ? "Device quiet" : "Device unavailable"}
        </span>
      </div>
      <PodMemoryConsentRow hushhId={hushhId} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {turns.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            Ask Puppy One through your private pod. The local model answers; One
            keeps the tools and consent boundary.
          </p>
        ) : null}
        <div className="flex flex-col gap-3">
          {turns.map((turn) => (
            <div
              key={turn.id}
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm",
                turn.role === "user"
                  ? "self-end bg-[color:var(--app-accent-surface)]"
                  : "self-start bg-muted/60",
              )}
            >
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {turn.text}
              </p>
              {turn.role === "assistant" && busy && !turn.text ? (
                <span className="flex items-center gap-2 text-muted-foreground" role="status" aria-live="polite">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {elapsedSeconds < 15
                    ? "Connecting to your machine…"
                    : elapsedSeconds < 60
                      ? "Waiting for Puppy to answer…"
                      : "Still waiting for your machine. You can cancel below."}
                </span>
              ) : null}
            </div>
          ))}
        </div>
        {error ? (
          <p className="mt-3 text-sm text-destructive">{error}</p>
        ) : null}
        {pendingForLinkedDevice.length > 0 ? (
          <p
            className="mt-3 text-sm text-muted-foreground"
            data-testid="puppy-revocation-pending"
          >
            Revocation pending delivery: your pod will drop this device the next
            time it checks in.
          </p>
        ) : null}
      </div>
      <div className="shrink-0 px-3 pt-3 sm:px-5">
        <div className="bottom-chrome-surface flex min-h-14 items-center gap-2 rounded-[var(--app-input-radius)] px-3.5">
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
            aria-label="Message Puppy One"
            className="h-auto max-h-28 min-h-0 min-w-0 flex-1 resize-none overscroll-contain overflow-y-auto border-0 bg-transparent px-0 py-3 text-[15px] leading-snug text-foreground caret-[color:var(--app-accent)] outline-none placeholder:text-muted-foreground/70 disabled:opacity-60 sm:max-h-36 sm:text-sm"
          />
          <ShellActionSurface
            type="button"
            onClick={() => void send()}
            disabled={busy || !draft.trim()}
            aria-label="Send to Puppy One"
            title="Send to Puppy One"
            className="border-transparent bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]"
          >
            <Send className="size-4" aria-hidden />
          </ShellActionSurface>
        </div>
        {busy ? (
          <button type="button" onClick={() => requestRef.current?.abort()} aria-label="Cancel" className="mt-2 px-1 text-sm text-muted-foreground underline-offset-2 hover:underline">
            Cancel request
          </button>
        ) : null}
      </div>
    </div>
  );
}
