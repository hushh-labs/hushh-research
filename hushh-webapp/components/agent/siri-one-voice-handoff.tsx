"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import {
  OneVoiceInvocationBridge,
  type OneVoiceInvocationOutcome,
  type PendingOneVoiceInvocation,
} from "@/lib/capacitor/one-voice-invocation";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import {
  AGENT_CONVERSATION_OUTCOME_EVENT,
  AGENT_CONVERSATION_READY_EVENT,
  isAgentConversationOwnerReady,
  isAgentGeminiVoiceEnabled,
  requestAgentConversation,
  type AgentConversationOutcome,
} from "@/lib/agent/agent-voice-settings";
import { ROUTES } from "@/lib/navigation/routes";
import { snapKaiBottomChromeVisible } from "@/lib/navigation/kai-bottom-chrome-visibility";
import {
  buildSiriOneVoiceLoginRoute,
  resolveSiriOneVoiceHandoffState,
} from "@/lib/agent/siri-one-voice-handoff-policy";

// Force re-evaluation when vault unlocks so a waiting/blocked invocation
// can transition to dispatch without waiting for AgentRuntimeStateProvider's
// tier recomputation.
const VAULT_UNLOCK_EVENT = "vault-unlocked";

const ACCEPTANCE_TIMEOUT_MS = 30_000;

function logLifecycle(
  state: string,
  invocation: PendingOneVoiceInvocation,
  outcome?: string,
): void {
  console.info(
    `[SIRI_ONE_VOICE] state=${state} request_id=${invocation.id} source=${invocation.source} outcome=${outcome ?? "none"} duration_ms=${Math.max(0, Date.now() - invocation.createdAt)}`,
  );
}

/**
 * Metadata-only adapter from Apple's system surface to the existing Agent Bar.
 * It owns no microphone, transcript, route registry, voice model, or action.
 */
export function SiriOneVoiceHandoff(): null {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const runtime = useAgentRuntimeStateOptional();
  const [pending, setPending] = useState<PendingOneVoiceInvocation | null>(
    null,
  );
  const [ownerRevision, setOwnerRevision] = useState(0);
  const [visibilityRevision, setVisibilityRevision] = useState(0);
  const claimedRef = useRef<PendingOneVoiceInvocation | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitingForAuthLoggedRef = useRef<string | null>(null);

  const clearTimeoutIfNeeded = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const complete = useCallback(
    async (
      invocation: PendingOneVoiceInvocation,
      outcome: OneVoiceInvocationOutcome,
    ) => {
      clearTimeoutIfNeeded();
      await OneVoiceInvocationBridge.completeInvocation({
        id: invocation.id,
        outcome,
      }).catch(() => undefined);
      logLifecycle(outcome, invocation, outcome);
      if (claimedRef.current?.id === invocation.id) claimedRef.current = null;
      setPending((current) => (current?.id === invocation.id ? null : current));
    },
    [clearTimeoutIfNeeded],
  );

  const refreshPending = useCallback(async () => {
    const invocation =
      await OneVoiceInvocationBridge.getPendingInvocation().catch(() => null);
    if (invocation) logLifecycle("bridge_ready", invocation);
    setPending(invocation);
  }, []);

  useEffect(() => {
    if (!OneVoiceInvocationBridge.isSupported()) return undefined;
    let cancelled = false;
    let removeListener: (() => Promise<void>) | null = null;
    void refreshPending();
    void OneVoiceInvocationBridge.addAvailabilityListener((invocation) => {
      if (cancelled) return;
      logLifecycle("foregrounded", invocation);
      setPending(invocation);
    }).then((handle) => {
      if (cancelled) void handle.remove();
      else removeListener = () => handle.remove();
    });
    return () => {
      cancelled = true;
      clearTimeoutIfNeeded();
      void removeListener?.();
    };
  }, [clearTimeoutIfNeeded, refreshPending]);

  useEffect(() => {
    const onVisibilityChange = () => {
      setVisibilityRevision((current) => current + 1);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Vault unlock may resolve a waiting_for_runtime invocation when the
  // oneVoiceContextSnapshot (derived from vaultOwnerToken) becomes available.
  useEffect(() => {
    if (!OneVoiceInvocationBridge.isSupported()) return undefined;
    const onVaultUnlock = () =>
      setVisibilityRevision((current) => current + 1);
    window.addEventListener(VAULT_UNLOCK_EVENT, onVaultUnlock);
    return () =>
      window.removeEventListener(VAULT_UNLOCK_EVENT, onVaultUnlock);
  }, []);

  useEffect(() => {
    const onReady = () => {
      setOwnerRevision((current) => current + 1);
      void refreshPending();
    };
    window.addEventListener(AGENT_CONVERSATION_READY_EVENT, onReady);
    return () =>
      window.removeEventListener(AGENT_CONVERSATION_READY_EVENT, onReady);
  }, [refreshPending]);

  useEffect(() => {
    const onOutcome = (event: Event) => {
      const outcome = (event as CustomEvent<AgentConversationOutcome>).detail;
      const invocation = claimedRef.current;
      if (!invocation || outcome?.requestId !== invocation.id) return;
      void complete(invocation, outcome.outcome);
    };
    window.addEventListener(AGENT_CONVERSATION_OUTCOME_EVENT, onOutcome);
    return () =>
      window.removeEventListener(AGENT_CONVERSATION_OUTCOME_EVENT, onOutcome);
  }, [complete]);

  useEffect(() => {
    if (!pending || claimedRef.current) return;
    const state = resolveSiriOneVoiceHandoffState({
      now: Date.now(),
      expiresAt: pending.expiresAt,
      visible: document.visibilityState === "visible",
      authLoading,
      signedIn: Boolean(user),
      pathname,
      loginPath: ROUTES.LOGIN,
      runtimeReady: Boolean(runtime?.oneVoiceContextSnapshot),
      tier: runtime?.tier ?? null,
      ownerReady: isAgentConversationOwnerReady(),
      voiceEnabled: isAgentGeminiVoiceEnabled(),
    });
    if (state === "expired") {
      void complete(pending, "expired");
      return;
    }
    if (
      state === "waiting_for_auth_restoration" ||
      state === "waiting_for_auth"
    ) {
      if (waitingForAuthLoggedRef.current !== pending.id) {
        waitingForAuthLoggedRef.current = pending.id;
        logLifecycle("waiting_for_auth", pending);
      }
      if (state === "waiting_for_auth" && pathname !== ROUTES.LOGIN) {
        const search = searchParams?.toString() ?? "";
        const currentRoute = pathname
          ? `${pathname}${search ? `?${search}` : ""}`
          : null;
        router.push(
          buildSiriOneVoiceLoginRoute({
            currentRoute,
            loginPath: ROUTES.LOGIN,
            publicHomePath: ROUTES.HOME,
          }),
        );
      }
      return;
    }
    if (state === "voice_disabled") {
      void complete(pending, "failed");
      return;
    }
    if (state !== "dispatch") return;

    let cancelled = false;
    void OneVoiceInvocationBridge.claimInvocation({ id: pending.id }).then(
      ({ claimed }) => {
        if (cancelled) return;
        if (!claimed) {
          void refreshPending();
          return;
        }
        claimedRef.current = pending;
        logLifecycle("dispatched", pending);
        requestAgentConversation({
          source: "siri_app_shortcut",
          requestId: pending.id,
        });
        timeoutRef.current = setTimeout(() => {
          const active = claimedRef.current;
          if (!active || active.id !== pending.id) return;
          snapKaiBottomChromeVisible();
          logLifecycle("fallback_shown", active, "failed");
          void complete(active, "failed");
        }, ACCEPTANCE_TIMEOUT_MS);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    authLoading,
    complete,
    pathname,
    ownerRevision,
    pending,
    refreshPending,
    router,
    runtime?.oneVoiceContextSnapshot,
    runtime?.tier,
    searchParams,
    user,
    visibilityRevision,
  ]);

  return null;
}
