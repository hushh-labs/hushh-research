import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCallView } from "@/lib/capacitor/calling";
import { NativeCallSession } from "@/lib/direct-messages/native-call-session";

const bridge = vi.hoisted(() => ({ listener: null as ((view: NativeCallView) => void) | null,
  initialize: vi.fn(async () => ({ available: true })), remove: vi.fn(async () => undefined),
  start: vi.fn(async () => undefined), answer: vi.fn(async () => undefined), end: vi.fn(async () => undefined),
  mute: vi.fn(async () => undefined), verify: vi.fn(async () => undefined) }));
const updated = vi.hoisted(() => vi.fn());
vi.mock("@/lib/direct-messages/direct-message-events", () => ({ dispatchDirectMessagesUpdated: updated }));
vi.mock("@/lib/capacitor/calling", () => ({ HushhCalling: { ...bridge,
  addListener: vi.fn(async (_event, callback) => { bridge.listener = callback; return { remove: bridge.remove }; }) } }));
const activeCall = { id: "verified-call", conversationId: "conversation", state: "connecting" as const, revision: 1,
  expiresAt: 9999999999, isCaller: false, callerDeviceId: "peer", calleeDeviceId: "self" };
const state: NativeCallView = { call: null, verification: null, error: null, muted: false, mediaConnected: false };
beforeEach(() => { vi.clearAllMocks(); bridge.listener = null; });

describe("native call presentation adapter", () => {
  it("refreshes the owner's Messages through the existing domain event once per call", async () => {
    const session = new NativeCallSession("synthetic-owner", vi.fn(), vi.fn(async () => true));
    await session.initialize();
    const call = { id: "synthetic-call", conversationId: "new-conversation", state: "ringing" as const, revision: 1,
      expiresAt: 9999999999, isCaller: false, callerDeviceId: "peer", calleeDeviceId: null };
    bridge.listener?.({ ...state, call });
    bridge.listener?.({ ...state, call: { ...call, revision: 2 } });
    expect(updated).toHaveBeenCalledOnce();
    expect(updated).toHaveBeenCalledWith({ userId: "synthetic-owner", conversationId: "new-conversation", messageId: null, source: "call" });
    session.dispose();
  });
  it("detaches UI without ending the OS-owned call and ignores late owner events", async () => {
    const publish = vi.fn();
    const session = new NativeCallSession("synthetic-owner", publish, vi.fn(async () => true));
    expect(await session.initialize()).toBe(true);
    expect(bridge.initialize).toHaveBeenCalledWith({ ownerId: "synthetic-owner" });
    await session.start(null, "synthetic-person");
    expect(bridge.start).toHaveBeenCalledWith({ personRef: "synthetic-person" });
    session.dispose();
    expect(bridge.remove).toHaveBeenCalledOnce();
    expect(bridge.end).not.toHaveBeenCalled();
    bridge.listener?.(state);
    expect(publish).not.toHaveBeenCalled();
  });
  it("sends comparison acceptance once and drops superseded comparison results", async () => {
    const resolutions: ((value: boolean) => void)[] = [];
    const verify = vi.fn(() => new Promise<boolean>(resolve => resolutions.push(resolve)));
    const session = new NativeCallSession("synthetic-owner", vi.fn(), verify);
    await session.initialize();
    bridge.listener?.({ ...state, call: activeCall, verification: "first" });
    bridge.listener?.({ ...state, call: activeCall, verification: "first" });
    expect(verify).toHaveBeenCalledTimes(1);
    bridge.listener?.({ ...state, call: activeCall, verification: "replacement" });
    resolutions[0]!(true); await Promise.resolve();
    expect(bridge.verify).not.toHaveBeenCalled();
    resolutions[1]!(true); await Promise.resolve();
    expect(bridge.verify).toHaveBeenCalledWith({ callId: "verified-call", fingerprint: "replacement", accepted: true });
    await session.end(true, "verified-call");
    expect(bridge.end).toHaveBeenCalledWith({ callId: "verified-call", decline: true });
    session.dispose();
  });
  it("keeps rendered call intents bound to their original call after a replacement event", async () => {
    const session = new NativeCallSession("synthetic-owner", vi.fn(), vi.fn(async () => true));
    await session.initialize();
    const call = { id: "replacement", conversationId: "conversation", state: "ringing" as const, revision: 1,
      expiresAt: 9999999999, isCaller: false, callerDeviceId: "peer", calleeDeviceId: null };
    bridge.listener?.({ ...state, call });
    await session.answer("original");
    await session.end(true, "original");
    session.mute("original");
    expect(bridge.answer).toHaveBeenCalledWith({ callId: "original" });
    expect(bridge.end).toHaveBeenCalledWith({ callId: "original", decline: true });
    expect(bridge.mute).toHaveBeenCalledWith({ callId: "original" });
    session.dispose();
  });
  it("rejects a previous call's comparison even when the replacement uses the same endpoint code", async () => {
    const resolutions: ((accepted: boolean) => void)[] = [];
    const session = new NativeCallSession("synthetic-owner", vi.fn(), () => new Promise(resolve => resolutions.push(resolve)));
    await session.initialize();
    bridge.listener?.({ ...state, call: activeCall, verification: "same-pair" });
    bridge.listener?.({ ...state, call: { ...activeCall, id: "replacement" }, verification: "same-pair" });
    expect(resolutions).toHaveLength(2);
    resolutions[0]!(true); await Promise.resolve();
    expect(bridge.verify).not.toHaveBeenCalled();
    resolutions[1]!(true); await Promise.resolve();
    expect(bridge.verify).toHaveBeenCalledWith({ callId: "replacement", fingerprint: "same-pair", accepted: true });
    session.dispose();
  });
});
