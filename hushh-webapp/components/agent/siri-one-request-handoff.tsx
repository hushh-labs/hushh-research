"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { oneSystemRequestRuntime, type RequestRuntimeState } from "@/lib/agent/one-system-request-runtime";
import {
  AGENT_CONVERSATION_OUTCOME_EVENT,
  cancelAgentConversationRequest,
  requestAgentConversation,
  type AgentConversationOutcome,
} from "@/lib/agent/agent-voice-settings";
import { useAgentVoiceState } from "@/lib/agent/agent-voice-state";

const REQUEST_HANDOFF_TIMEOUT_MS = 25_000;

/**
 * Thin foreground component that:
 * 1. Subscribes to the stable request runtime
 * 2. Waits for auth/owner readiness
 * 3. Hands off the claimed request text to the existing Agent One voice owner
 *
 * No microphone startup. No model execution inside cleanup.
 * The runtime owns the claim lifecycle; this component only orchestrates.
 */
export function SiriOneRequestHandoff() {
  const { user, isAuthenticated } = useAuth();
  const ownerId = user?.uid ?? null;
  const isReady = isAuthenticated && Boolean(ownerId);
  const runtimeStartedRef = useRef(false);
  const lastHandoffRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimeoutIfNeeded = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  // Keep native request ownership aligned with auth even while the handoff
  // listener is being torn down. Sign-out must cancel claimed in-memory text
  // and any pending native record; it must not leave the previous owner active.
  useEffect(() => {
    oneSystemRequestRuntime.setOwner(isReady ? ownerId : null);
  }, [isReady, ownerId]);

  useEffect(() => {
    if (!isReady || runtimeStartedRef.current) return;
    runtimeStartedRef.current = true;

    const unsub = oneSystemRequestRuntime.startListening();

    return () => {
      unsub();
      runtimeStartedRef.current = false;
    };
  }, [isReady, ownerId]);

  useEffect(() => {
    if (!isReady) return;

    const unsub = oneSystemRequestRuntime.subscribe((state: RequestRuntimeState) => {
      if (state.status !== "claimed") return;

      // Prevent duplicate handoffs for the same invocation
      if (lastHandoffRef.current === state.invocation.id) return;
      lastHandoffRef.current = state.invocation.id;

      const dispatchResult = requestAgentConversation({
        source: "siri_app_shortcut",
        requestId: state.invocation.id,
        initialRequestText: state.invocation.requestText,
      });

      if (dispatchResult === "duplicate") {
        void (async () => {
          if (!(await oneSystemRequestRuntime.markAppOwned())) return;
          await oneSystemRequestRuntime.complete(
            "completed",
            "Agent One is already handling your request.",
          );
        })();
        return;
      }

      clearTimeoutIfNeeded();
      timeoutRef.current = setTimeout(() => {
        cancelAgentConversationRequest({
          source: "siri_app_shortcut",
          requestId: state.invocation.id,
        });
        useAgentVoiceState
          .getState()
          .setStatus(
            "error",
            "Agent One could not open this command request. Open the app and try again.",
          );
        void oneSystemRequestRuntime.complete(
          "handoff_timeout",
          "Agent One could not open the command surface in time. Try again in the app.",
        );
      }, REQUEST_HANDOFF_TIMEOUT_MS);
    });

    const handleOutcome = (event: Event) => {
      const outcome = (event as CustomEvent<AgentConversationOutcome>).detail;
      if (
        outcome?.source !== "siri_app_shortcut" ||
        outcome.requestId !== lastHandoffRef.current
      ) {
        return;
      }
      clearTimeoutIfNeeded();
      void (async () => {
        if (outcome.outcome === "accepted") {
          if (!(await oneSystemRequestRuntime.markAppOwned())) return;
        }
        await oneSystemRequestRuntime.complete(
          outcome.outcome === "accepted" ? "completed" : "failed",
          outcome.outcome === "accepted"
            ? "Agent One is handling your request."
            : "Agent One could not open the command surface. Try again in the app.",
        );
      })();
    };
    window.addEventListener(AGENT_CONVERSATION_OUTCOME_EVENT, handleOutcome);

    return () => {
      unsub();
      window.removeEventListener(AGENT_CONVERSATION_OUTCOME_EVENT, handleOutcome);
      clearTimeoutIfNeeded();
      const current = oneSystemRequestRuntime.getCurrentState();
      if (current.status === "awaiting_claim" || current.status === "claimed") {
        if (current.status === "claimed") {
          void oneSystemRequestRuntime.reportProgress("detached");
        } else {
          void oneSystemRequestRuntime.cancelCurrent("detached");
        }
        if (current.invocation.id === lastHandoffRef.current) {
          cancelAgentConversationRequest({
            source: "siri_app_shortcut",
            requestId: current.invocation.id,
          });
        }
      }
    };
  }, [clearTimeoutIfNeeded, isReady]);

  return null; // Invisible component
}
