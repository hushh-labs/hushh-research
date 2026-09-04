import type { AgentAccessTier } from "@/lib/agent/agent-runtime-context";

export type SiriOneActionHandoffState =
  | "expired"
  | "waiting_for_foreground"
  | "waiting_for_auth_restoration"
  | "waiting_for_auth"
  | "waiting_for_route"
  | "waiting_for_runtime"
  | "waiting_for_vault"
  | "waiting_for_executor"
  | "review_vault"
  | "dispatch";

export function resolveSiriOneActionHandoffState(input: {
  now: number;
  expiresAt: number;
  visible: boolean;
  authLoading: boolean;
  signedIn: boolean;
  pathname: string | null;
  loginPath: string;
  runtimeReady: boolean;
  tier: AgentAccessTier | null;
  requiresVault: boolean;
  hasVaultLockedFallback: boolean;
  executorReady: boolean;
}): SiriOneActionHandoffState {
  if (input.expiresAt <= input.now) return "expired";
  if (!input.visible) return "waiting_for_foreground";
  if (input.authLoading) return "waiting_for_auth_restoration";
  if (!input.signedIn) return "waiting_for_auth";
  if (!input.pathname || input.pathname === input.loginPath) {
    return "waiting_for_route";
  }
  if (!input.runtimeReady || !input.tier?.startsWith("signed_")) {
    return "waiting_for_runtime";
  }
  if (input.requiresVault && input.tier !== "signed_unlocked") {
    if (input.hasVaultLockedFallback) {
      return input.executorReady ? "review_vault" : "waiting_for_executor";
    }
    return "waiting_for_vault";
  }
  if (!input.executorReady) return "waiting_for_executor";
  return "dispatch";
}
