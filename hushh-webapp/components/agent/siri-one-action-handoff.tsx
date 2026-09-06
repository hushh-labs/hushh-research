"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import {
  executeOneSystemActionInvocation,
  isOneSystemActionExecutorReady,
  subscribeOneSystemActionExecutor,
} from "@/lib/agent/one-system-action-executor";
import {
  OneSystemActionInvocationBridge,
  isOneSystemActionId,
  type OneSystemActionOutcome,
  type PendingOneSystemActionInvocation,
} from "@/lib/capacitor/one-system-action-invocation";
import { ROUTES } from "@/lib/navigation/routes";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { buildSiriOneVoiceLoginRoute } from "@/lib/agent/siri-one-voice-handoff-policy";
import { resolveSiriOneActionHandoffState } from "@/lib/agent/siri-one-action-handoff-policy";

// Force re-evaluation when vault unlocks so a waiting-for-vault invocation
// can immediately transition to dispatch without waiting for the next
// effect cycle (which requires a dependency change that may not fire).
const VAULT_UNLOCK_EVENT = "vault-unlocked";

function logLifecycle(
  state: string,
  invocation: PendingOneSystemActionInvocation,
  outcome?: string,
): void {
  console.info(
    `[SIRI_ONE_ACTION] state=${state} request_id=${invocation.id} action_id=${invocation.actionId} outcome=${outcome ?? "none"} duration_ms=${Math.max(0, Date.now() - invocation.createdAt)}`,
  );
}

function normalizeOutcome(
  status: "succeeded" | "started" | "blocked" | "invalid" | "failed" | "noop",
): OneSystemActionOutcome {
  if (status === "succeeded" || status === "started" || status === "blocked") {
    return status;
  }
  return "failed";
}

/**
 * Restores auth/runtime and hands the structured Siri request to the sole
 * Agent Bar action owner. It owns no action implementation and no model.
 */
export function SiriOneActionHandoff(): null {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const runtime = useAgentRuntimeStateOptional();
  const [pending, setPending] =
    useState<PendingOneSystemActionInvocation | null>(null);
  const [executorRevision, setExecutorRevision] = useState(0);
  const [visibilityRevision, setVisibilityRevision] = useState(0);
  const [vaultUnlockRevision, setVaultUnlockRevision] = useState(0);
  const claimedRef = useRef<string | null>(null);
  const waitingStateRef = useRef<string | null>(null);

  const refreshPending = useCallback(async () => {
    const invocation =
      await OneSystemActionInvocationBridge.getPendingInvocation().catch(
        () => null,
      );
    if (invocation) logLifecycle("bridge_ready", invocation);
    setPending(invocation);
  }, []);

  const complete = useCallback(
    async (
      invocation: PendingOneSystemActionInvocation,
      outcome: OneSystemActionOutcome,
      summary: string,
    ) => {
      await OneSystemActionInvocationBridge.completeInvocation({
        id: invocation.id,
        outcome,
        summary,
      }).catch(() => undefined);
      logLifecycle(outcome, invocation, outcome);
      if (claimedRef.current === invocation.id) claimedRef.current = null;
      setPending((current) =>
        current?.id === invocation.id ? null : current,
      );
    },
    [],
  );

  useEffect(() => {
    if (!OneSystemActionInvocationBridge.isSupported()) return undefined;
    let cancelled = false;
    let removeListener: (() => Promise<void>) | null = null;
    void refreshPending();
    void OneSystemActionInvocationBridge.addAvailabilityListener(
      (invocation) => {
        if (cancelled) return;
        logLifecycle("foregrounded", invocation);
        setPending(invocation);
      },
    ).then((handle) => {
      if (cancelled) void handle.remove();
      else removeListener = () => handle.remove();
    });
    return () => {
      cancelled = true;
      void removeListener?.();
    };
  }, [refreshPending]);

  useEffect(
    () =>
      subscribeOneSystemActionExecutor(() =>
        setExecutorRevision((value) => value + 1),
      ),
    [],
  );

  useEffect(() => {
    const onVisibility = () => setVisibilityRevision((value) => value + 1);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Vault unlock may resolve a waiting_for_vault invocation before the
  // AgentRuntimeStateProvider's tier recomputation triggers a re-render.
  // Listen for the explicit event to force immediate re-evaluation.
  useEffect(() => {
    if (!OneSystemActionInvocationBridge.isSupported()) return undefined;
    const onVaultUnlock = () => setVaultUnlockRevision((value) => value + 1);
    window.addEventListener(VAULT_UNLOCK_EVENT, onVaultUnlock);
    return () =>
      window.removeEventListener(VAULT_UNLOCK_EVENT, onVaultUnlock);
  }, []);

  useEffect(() => {
    if (!pending || claimedRef.current) return;
    const configuredFallback = getKaiActionById(
      pending.actionId,
    )?.siri_vault_locked_fallback_action_id;
    const vaultLockedFallbackActionId =
      configuredFallback && isOneSystemActionId(configuredFallback)
        ? configuredFallback
        : null;
    const state = resolveSiriOneActionHandoffState({
      now: Date.now(),
      expiresAt: pending.expiresAt,
      visible: document.visibilityState === "visible",
      authLoading,
      signedIn: Boolean(user),
      pathname,
      loginPath: ROUTES.LOGIN,
      runtimeReady: Boolean(runtime?.appRuntimeState),
      tier: runtime?.tier ?? null,
      requiresVault: pending.requiresVault,
      hasVaultLockedFallback: Boolean(vaultLockedFallbackActionId),
      executorReady: isOneSystemActionExecutorReady(),
    });
    if (state === "expired") {
      void complete(pending, "expired", "That HUSSH request expired. Try again.");
      return;
    }
    if (
      state === "waiting_for_auth" ||
      state === "waiting_for_auth_restoration" ||
      state === "waiting_for_vault"
    ) {
      const key = `${pending.id}:${state}`;
      if (waitingStateRef.current !== key) {
        waitingStateRef.current = key;
        logLifecycle(state, pending);
        if (state === "waiting_for_vault") {
          void OneSystemActionInvocationBridge.reportProgress({
            id: pending.id,
            state,
          }).catch(() => undefined);
        }
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
    if (state !== "dispatch" && state !== "review_vault") return;

    const invocationToExecute: PendingOneSystemActionInvocation =
      state === "review_vault" && vaultLockedFallbackActionId
        ? {
            ...pending,
            actionId: vaultLockedFallbackActionId,
            slots: {},
            requiresVault: false,
            confirmedBySystem: false,
          }
        : pending;

    let cancelled = false;
    void OneSystemActionInvocationBridge.claimInvocation({ id: pending.id })
      .then(async ({ claimed }) => {
        if (cancelled) return;
        if (!claimed) {
          void refreshPending();
          return;
        }
        claimedRef.current = pending.id;
        logLifecycle(
          state === "review_vault" ? "vault_review_dispatched" : "dispatched",
          pending,
        );
        const result = await executeOneSystemActionInvocation(invocationToExecute);
        if (state === "review_vault") {
          await complete(
            pending,
            "blocked",
            result.status === "succeeded" || result.status === "started"
              ? "Agent One's Vault is locked. I opened Location Settings for you. Unlock your Vault, then ask me again to pause location sharing."
              : result.resultSummary,
          );
          return;
        }
        await complete(
          pending,
          normalizeOutcome(result.status),
          result.resultSummary,
        );
      })
      .catch(() => {
        if (claimedRef.current === pending.id) {
          void complete(pending, "failed", "HUSSH could not run that action.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    authLoading,
    complete,
    executorRevision,
    pathname,
    pending,
    refreshPending,
    router,
    runtime?.appRuntimeState,
    runtime?.tier,
    searchParams,
    user,
    vaultUnlockRevision,
    visibilityRevision,
  ]);

  return null;
}
