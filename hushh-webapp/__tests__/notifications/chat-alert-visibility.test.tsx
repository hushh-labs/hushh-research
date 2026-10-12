import { useRef } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatAlertIsVisible, useChatAlertVisibility } from "@/lib/notifications/chat-alert-visibility";

const state = vi.hoisted(() => ({ key: null as string | null, listeners: new Set<() => void>(), setActiveChat: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@/lib/capacitor", () => ({ HushhNotifications: { setActiveChat: state.setActiveChat } }));
vi.mock("@/lib/notifications/preview-keys", () => ({
  activeNotificationKeyId: () => state.key,
  subscribeNotificationKey: (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
}));
vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({ appInteractionCoordinator: {
  getLifecycleSnapshot: () => ({ state: "active" }), subscribeLifecycle: () => () => {},
} }));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({ getVoiceSurfaceMetadata: () => null }));
beforeEach(() => {
  state.key = null;
  state.setActiveChat.mockClear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => { cleanup(); document.body.style.pointerEvents = ""; vi.restoreAllMocks(); });

it("publishes a visible chat after registration and key rotation without changing its tag", async () => {
  renderHook(() => { const root = useRef(document.createElement("div")); useChatAlertVisibility("circle-chat:registration", root); });
  expect(state.setActiveChat).not.toHaveBeenCalled();
  state.key = "registered-key"; state.listeners.forEach(listener => listener());
  await waitFor(() => expect(state.setActiveChat).toHaveBeenCalledWith({ tag: "circle-chat:registration", keyId: "registered-key" }));
  state.key = "rotated-key"; state.listeners.forEach(listener => listener());
  await waitFor(() => expect(state.setActiveChat).toHaveBeenCalledWith({ tag: "circle-chat:registration", keyId: "rotated-key" }));
});

it("does not acknowledge a chat covered by a modal, and clears the native presentation hint", async () => {
  state.key = "modal-key";
  renderHook(() => { const root = useRef(document.createElement("div")); useChatAlertVisibility("direct-chat:modal", root); });
  await waitFor(() => expect(state.setActiveChat).toHaveBeenCalledWith({ tag: "direct-chat:modal", keyId: "modal-key" }));
  document.body.style.pointerEvents = "none";
  expect(chatAlertIsVisible({ type: "direct_message", conversation_id: "modal" })).toBe(false);
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(state.setActiveChat).toHaveBeenCalledWith({ tag: "", keyId: "modal-key" }));
});
