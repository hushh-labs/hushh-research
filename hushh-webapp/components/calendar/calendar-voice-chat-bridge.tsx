"use client";

import { useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import { useOptionalVoiceSession } from "@/components/one-voice/voice-session-provider";
import { navigateToAgentChat } from "@/lib/navigation/agent-navigation";
import type { CalendarInvitationHandoff } from "@/lib/calendar/calendar-invitation-handoff";

/** One bounded adapter into the current chat. It never reads or changes Calendar. */
export function CalendarVoiceChatBridge() {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const voice = useOptionalVoiceSession();
  const handled = useRef(new Set<string>());
  const continueRequest = (request: unknown, operation: string, invitation?: CalendarInvitationHandoff) => {
    if (!user?.uid || !isVaultUnlocked || !vaultOwnerToken || typeof request !== "string" || !request.trim() || request.length > 2000 || (invitation && invitation.ownerId !== user.uid)) return false;
    if (handled.current.has(operation)) return true;
    handled.current.add(operation);
    useOneConversationSession.getState().createHandoff({ id: `calendar-voice-${operation}`, reason: "user_requested",
      ...(invitation ? { calendarInvitation: { ...invitation, request } } : { calendarRequest: { ownerId: user.uid, request } }) });
    navigateToAgentChat();
    return true;
  };
  useLocalOnboardingActionHandler("calendar.invitation.review", (slots, context) => {
    if (context?.signal?.aborted) return { status: "blocked", summary: "Calendar review was cancelled." };
    const opened = continueRequest(slots.request, context?.operationId || crypto.randomUUID());
    return { status: opened ? "started" : "blocked", summary: opened ? "Continue this invitation review in One Chat. Nothing has been changed or sent." : "Sign in, unlock and state the invitation request again." };
  }, { prepare: slots => {
    if (!user?.uid || !isVaultUnlocked || !vaultOwnerToken) return { status: "blocked", gate: "permission", summary: "Sign in and unlock to continue this invitation review." };
    if (typeof slots.request !== "string" || !slots.request.trim() || slots.request.length > 2000) return { status: "blocked", gate: "input", summary: "State the invitation request again." };
    return { status: "ready", binding: { ownerId: user.uid, request: slots.request }, summary: "Continue this invitation review in the existing One Chat conversation." };
  } });
  useVoiceToolEffects({ onClientStep: (step, report) => {
    if (step.kind !== "continue_calendar_in_chat") return;
    const raw = step.payload.invitation as Record<string, unknown> | undefined;
    const valid = raw && ["ownerId", "accountEmail", "calendarId", "eventId"].every(key => typeof raw[key] === "string") && ["view", "accepted", "declined", "offer_times"].includes(String(raw.decision));
    if (step.payload.owner_id !== user?.uid || (raw && !valid)) { report("failed", { reason: "owner_or_selection_changed" }); return; }
    const opened = continueRequest(step.payload.request, step.stepId, valid ? raw as CalendarInvitationHandoff : undefined);
    report(opened ? "ok" : "failed", { review_queued: opened });
    if (opened) voice?.stop("calendar_chat_review_queued");
  } });
  return null;
}
