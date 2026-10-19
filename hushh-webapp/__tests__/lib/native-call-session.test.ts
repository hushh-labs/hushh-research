import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCallView } from "@/lib/capacitor/calling";
import { NativeCallSession } from "@/lib/direct-messages/native-call-session";

const bridge = vi.hoisted(() => ({ listener: null as ((view: NativeCallView) => void) | null,
  initialize: vi.fn(async () => ({ available: true })), remove: vi.fn(async () => undefined),
  start: vi.fn(async () => undefined), answer: vi.fn(async () => undefined), end: vi.fn(async () => undefined),
  mute: vi.fn(async () => undefined), verify: vi.fn(async () => undefined) }));
vi.mock("@/lib/capacitor/calling", () => ({ HushhCalling: { ...bridge,
  addListener: vi.fn(async (_event, callback) => { bridge.listener = callback; return { remove: bridge.remove }; }) } }));
const state: NativeCallView = { call: null, verification: null, error: null, muted: false, mediaConnected: false };
beforeEach(() => { vi.clearAllMocks(); bridge.listener = null; });

describe("native call presentation adapter", () => {
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
    bridge.listener?.({ ...state, verification: "first" });
    bridge.listener?.({ ...state, verification: "first" });
    expect(verify).toHaveBeenCalledTimes(1);
    bridge.listener?.({ ...state, verification: "replacement" });
    resolutions[0]!(true); await Promise.resolve();
    expect(bridge.verify).not.toHaveBeenCalled();
    resolutions[1]!(true); await Promise.resolve();
    expect(bridge.verify).toHaveBeenCalledWith({ fingerprint: "replacement", accepted: true });
    await session.end(true);
    expect(bridge.end).toHaveBeenCalledWith({ decline: true });
    session.dispose();
  });
});
