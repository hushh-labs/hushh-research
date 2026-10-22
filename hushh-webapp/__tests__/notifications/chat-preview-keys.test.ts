import { beforeEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";

const native = vi.hoisted(() => ({ enabled: true, prepare: vi.fn(), clear: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => native.enabled } }));
vi.mock("@/lib/capacitor", () => ({ HushhNotifications: { prepareNotificationKey: native.prepare, clearNotificationKey: native.clear } }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  native.enabled = true;
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("indexedDB", new IDBFactory());
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
});

it("serializes native key rotation and fences a delayed previous-owner result and logout", async () => {
  const keys = await import("@/lib/notifications/preview-keys");
  let complete!: (value: { deviceId: string; keyId: string; publicKey: string }) => void;
  native.prepare.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  native.prepare.mockResolvedValueOnce({ deviceId: "fixture", keyId: "bob-key", publicKey: "fixture" });
  const previous = keys.prepareNotificationDevice("alice");
  const rejected = expect(previous).rejects.toThrow("Notification session changed");
  await vi.waitFor(() => expect(native.prepare).toHaveBeenCalledOnce());
  const current = keys.prepareNotificationDevice("bob");
  complete({ deviceId: "fixture", keyId: "alice-key", publicKey: "fixture" });
  await rejected;
  await current;
  expect(native.prepare.mock.calls.map((call) => call[0].userId)).toEqual(["alice", "bob"]);
  expect(keys.activeNotificationKeyId("alice")).toBeNull();
  expect(keys.activeNotificationKeyId("bob")).toBe("bob-key");
  await keys.clearNotificationDevice("alice");
  expect(native.clear).not.toHaveBeenCalled();
  expect(keys.activeNotificationKeyId("bob")).toBe("bob-key");
  await keys.clearNotificationDevice("bob");
  expect(native.clear).toHaveBeenCalledWith({ userId: "bob" });
  expect(keys.activeNotificationKeyId("bob")).toBeNull();
});

it("keeps installation identity through logout while rotating web preview ownership", async () => {
  native.enabled = false;
  const keys = await import("@/lib/notifications/preview-keys");
  const alice = await keys.prepareNotificationDevice("alice");
  const previous = { data: { recipient_key_id: alice.keyId }, close: vi.fn() };
  const foreign = { data: { recipient_key_id: "another-owner" }, close: vi.fn() };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({ getNotifications: async () => [previous, foreign] }) } });
  await keys.clearNotificationDevice("alice");
  expect(previous.close).toHaveBeenCalledOnce();
  expect(foreign.close).not.toHaveBeenCalled();
  const bob = await keys.prepareNotificationDevice("bob");
  expect(bob.deviceId).toBe(alice.deviceId);
  expect(bob.keyId).not.toBe(alice.keyId);
  await keys.clearNotificationDevice("alice");
  expect(keys.activeNotificationKeyId("bob")).toBe(bob.keyId);
});

it("closes only the previous owner's delivered alerts when web ownership rotates directly", async () => {
  native.enabled = false;
  const keys = await import("@/lib/notifications/preview-keys");
  const alice = await keys.prepareNotificationDevice("alice");
  const previous = { data: { recipient_key_id: alice.keyId }, close: vi.fn() };
  const foreign = { data: { recipient_key_id: "another-owner" }, close: vi.fn() };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({ getNotifications: async () => [previous, foreign] }) } });
  const bob = await keys.prepareNotificationDevice("bob");
  expect(previous.close).toHaveBeenCalledOnce();
  expect(foreign.close).not.toHaveBeenCalled();
  expect(keys.activeNotificationKeyId("bob")).toBe(bob.keyId);
});


it.each(["sequence", "before"] as const)("clears only delivered messages through the committed %s read boundary", async (field) => {
  native.enabled = false;
  const keys = await import("@/lib/notifications/preview-keys");
  const device = await keys.prepareNotificationDevice("alice");
  const older = { data: { recipient_key_id: device.keyId, circle_id: "fixture-thread", chat_sequence: "1", chat_sent_at: "1000" }, close: vi.fn() };
  const newer = { data: { ...older.data, chat_sequence: "2", chat_sent_at: "2000" }, close: vi.fn() };
  const foreign = { data: { ...older.data, recipient_key_id: "previous-owner-key" }, close: vi.fn() };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({ getNotifications: async () => [older, newer, foreign] }) } });
  const { ChatSystemNotifications } = await import("@/lib/notifications/chat-system-notifications");
  await ChatSystemNotifications.clearRead({ threadId: "fixture-thread", keyId: device.keyId, [field]: field === "sequence" ? 1 : 1000 });
  expect(older.close).toHaveBeenCalledOnce();
  expect(newer.close).not.toHaveBeenCalled();
  expect(foreign.close).not.toHaveBeenCalled();
});

it("clears the exact direct-message event while preserving a later alert in the same millisecond", async () => {
  native.enabled = false;
  const keys = await import("@/lib/notifications/preview-keys");
  const device = await keys.prepareNotificationDevice("alice");
  const boundary = { data: { recipient_key_id: device.keyId, conversation_id: "thread", chat_sent_at: "1000", message_id: "direct-message:read" }, close: vi.fn() };
  const later = { data: { ...boundary.data, message_id: "direct-message:unread" }, close: vi.fn() };
  const foreign = { data: { ...boundary.data, recipient_key_id: "another-owner" }, close: vi.fn() };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({ getNotifications: async () => [boundary, later, foreign] }) } });
  const { ChatSystemNotifications } = await import("@/lib/notifications/chat-system-notifications");
  await ChatSystemNotifications.clearRead({ threadId: "thread", keyId: device.keyId, before: 999, messageId: "direct-message:read" });
  expect(boundary.close).toHaveBeenCalledOnce(); expect(later.close).not.toHaveBeenCalled(); expect(foreign.close).not.toHaveBeenCalled();
});
