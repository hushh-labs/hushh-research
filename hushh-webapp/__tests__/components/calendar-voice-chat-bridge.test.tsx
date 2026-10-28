import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
const mocks = vi.hoisted(() => ({ stop: vi.fn(), navigate: vi.fn(), user: { uid: "owner" }, unlocked: true }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, userId: mocks.user.uid }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: mocks.unlocked, vaultOwnerToken: mocks.unlocked ? "synthetic-owner" : null }) }));
vi.mock("@/components/one-voice/voice-session-provider", () => ({ useOptionalVoiceSession: () => ({ stop: mocks.stop }) }));
vi.mock("@/lib/navigation/agent-navigation", () => ({ navigateToAgentChat: mocks.navigate }));
import { CalendarVoiceChatBridge } from "@/components/calendar/calendar-voice-chat-bridge";
beforeEach(() => { vi.clearAllMocks(); mocks.unlocked = true; useOneConversationSession.getState().clearSession(); });
afterEach(cleanup);
it("hands a voice request to the current chat once, without an RSVP or Mail effect", () => {
  render(<CalendarVoiceChatBridge />);
  const report = vi.fn();
  const step = { stepId: "voice-step", kind: "continue_calendar_in_chat", timeoutS: 30, payload: { owner_id: "owner", request: "Accept tomorrow's client meeting" } };
  act(() => { useVoiceSessionStore.getState().emitClientStep(step, report); });
  expect(useOneConversationSession.getState().pendingHandoff?.calendarRequest).toEqual({ ownerId: "owner", request: "Accept tomorrow's client meeting" });
  expect(report).toHaveBeenCalledWith("ok", { review_queued: true });
  act(() => { useVoiceSessionStore.getState().emitClientStep(step, report); });
  expect(mocks.navigate).toHaveBeenCalledOnce();
});
it("registers the same generated action for bounded Talk to One and blocks locked authority", async () => {
  const view = render(<CalendarVoiceChatBridge />);
  const handler = resolveLocalOnboardingHandler("calendar.invitation.review")!;
  expect(await handler({ request: "Show my pending invitations" })).toMatchObject({ status: "started" });
  mocks.unlocked = false; view.rerender(<CalendarVoiceChatBridge />);
  expect(await handler({ request: "Decline my invitation" })).toMatchObject({ status: "blocked" });
});
it("rejects another owner's voice step", () => {
  render(<CalendarVoiceChatBridge />); const report = vi.fn();
  act(() => { useVoiceSessionStore.getState().emitClientStep({ stepId: "other", kind: "continue_calendar_in_chat", timeoutS: 30, payload: { owner_id: "other", request: "Decline it" } }, report); });
  expect(report).toHaveBeenCalledWith("failed", { reason: "owner_or_selection_changed" });
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("keeps the selected event, account, original request and read window together", () => {
  render(<CalendarVoiceChatBridge />); const report = vi.fn();
  const invitation = { ownerId: "owner", accountEmail: "owner@example.com", calendarId: "shared@example.com", eventId: "instance", decision: "offer_times", timeZone: "UTC", startAt: "2027-03-01T00:00:00Z", endAt: "2027-03-02T00:00:00Z" };
  act(() => { useVoiceSessionStore.getState().emitClientStep({ stepId: "selection", kind: "continue_calendar_in_chat", timeoutS: 30, payload: { owner_id: "owner", request: "Ask for next Friday after 3 PM", invitation } }, report); });
  expect(useOneConversationSession.getState().pendingHandoff?.calendarInvitation).toEqual({ ...invitation, request: "Ask for next Friday after 3 PM" });
  expect(report).toHaveBeenCalledWith("ok", { review_queued: true });
});
