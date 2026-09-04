import type { AgentAccessTier } from "@/lib/agent/agent-runtime-context";

export type SiriOneVoiceHandoffState =
  | "expired"
  | "waiting_for_foreground"
  | "waiting_for_auth_restoration"
  | "waiting_for_auth"
  | "waiting_for_route"
  | "waiting_for_runtime"
  | "waiting_for_owner"
  | "voice_disabled"
  | "dispatch";

export function buildSiriOneVoiceLoginRoute(input: {
  currentRoute: string | null;
  loginPath: string;
  publicHomePath: string;
}): string {
  const currentRoute = input.currentRoute?.trim() ?? "";
  if (
    !currentRoute ||
    currentRoute === input.loginPath ||
    currentRoute === input.publicHomePath
  ) {
    return input.loginPath;
  }
  return `${input.loginPath}?redirect=${encodeURIComponent(currentRoute)}`;
}

export function resolveSiriOneVoiceHandoffState(input: {
  now: number;
  expiresAt: number;
  visible: boolean;
  authLoading: boolean;
  signedIn: boolean;
  pathname: string | null;
  loginPath: string;
  runtimeReady: boolean;
  tier: AgentAccessTier | null;
  ownerReady: boolean;
  voiceEnabled: boolean;
}): SiriOneVoiceHandoffState {
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
  if (!input.ownerReady) return "waiting_for_owner";
  if (!input.voiceEnabled) return "voice_disabled";
  return "dispatch";
}
