import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { NativeChromeLease, hasOutstandingNativeChrome, retireNativeChrome, type ChromeAcknowledgement, type ChromeProjection } from "@/lib/capacitor/native-chrome";
import { NativeShellBack } from "@/components/app-ui/native-shell-back";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";

const bridge = vi.hoisted(() => ({ platform: "ios", callbacks: new Map<string, (event: unknown) => void>(),
  prepare: vi.fn(), activate: vi.fn(), retire: vi.fn(), confirmChoice: vi.fn(), getCapabilities: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => bridge.platform !== "web", getPlatform: () => bridge.platform },
  registerPlugin: () => ({ ...bridge, addListener: async (name: string, callback: (event: unknown) => void) => {
    bridge.callbacks.set(name, callback); return { remove: async () => { bridge.callbacks.delete(name); } };
  } }),
}));
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativeDocumentId: () => "document-a",
  subscribeNativeSessionPrivacy: async () => ({ remove: async () => undefined }) }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({ useVoiceSurfaceMetadata: () => null, getVoiceSurfaceMetadata: () => null }));
const projection = { kind: "back" as const, label: "Go back", enabled: true,
  frame: { x: 2, y: 60, width: 44, height: 44 }, viewport: { width: 390, height: 844 } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject }; }
function choice(lease: NativeChromeLease, sequence = 1) { return { ...lease.projection, sequence, privacyGeneration: 0 }; }

describe("native chrome presentation lease", () => {
  beforeEach(async () => {
    bridge.platform = "ios";
    bridge.callbacks.clear();
    bridge.getCapabilities.mockReset().mockResolvedValue({ contractVersion: 1, families: ["back"] });
    bridge.prepare.mockReset().mockImplementation(async (value: ChromeProjection) => ({ ...value, phase: "prepared" }));
    bridge.activate.mockReset().mockImplementation(async (value) => ({ ...value, phase: "active" }));
    bridge.retire.mockReset().mockImplementation(async (value) => ({ ...value, phase: "retired" }));
    bridge.confirmChoice.mockReset().mockResolvedValue({ valid: true });
    await retireNativeChrome("owner-a");
  });
  afterEach(async () => { cleanup(); await act(async () => { await Promise.resolve(); }); vi.restoreAllMocks(); });
  it("does not transfer interaction before matching layout and activation acknowledgements", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    const action = vi.fn();
    await lease.prepare();
    await lease.choose(choice(lease), () => true, action);
    expect(action).not.toHaveBeenCalled();
    await lease.activate();
    await lease.choose(choice(lease), () => true, action);
    expect(action).toHaveBeenCalledOnce();
    await lease.choose(choice(lease), () => true, action);
    expect(action).toHaveBeenCalledOnce();
  });
  it("keeps an uncertain presentation quarantined until exact retirement is confirmed", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    bridge.prepare.mockImplementation(async (value) => ({ ...value, frame: { ...projection.frame, x: 99 }, phase: "prepared" }));
    await expect(lease.prepare()).rejects.toThrow("LAYOUT_UNCONFIRMED");
    expect(hasOutstandingNativeChrome()).toBe(true);
    bridge.retire.mockImplementation(async (value) => ({ ...value, revision: value.revision - 1, phase: "retired" }));
    await expect(retireNativeChrome("owner-a")).rejects.toThrow("RETIRE_UNCONFIRMED");
    expect(hasOutstandingNativeChrome()).toBe(true);
    bridge.retire.mockImplementation(async (value) => ({ ...value, phase: "retired" }));
    await retireNativeChrome("owner-a");
    expect(hasOutstandingNativeChrome()).toBe(false);
  });
  it.each(["owner", "context", "privacy", "disabled"])("rejects %s changes while a choice is being confirmed", async (reason) => {
    const lease = new NativeChromeLease({ ...projection, enabled: reason !== "disabled" }, "owner-a");
    const pending = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValue(pending.promise);
    const action = vi.fn();
    let allowed = true;
    await lease.prepare(); await lease.activate();
    const result = lease.choose(choice(lease), () => allowed, action);
    if (reason === "owner") lease.invalidate(); else allowed = false;
    pending.resolve({ valid: true }); await result;
    expect(action).not.toHaveBeenCalled();
  });
  it("does not activate a retired preparation or accept another owner/revision", async () => {
    const lease = new NativeChromeLease(projection, "owner-a");
    const pending = deferred<ChromeAcknowledgement>();
    bridge.prepare.mockReturnValue(pending.promise);
    const preparing = lease.prepare(); lease.invalidate();
    pending.resolve({ ...lease.projection, phase: "prepared" });
    expect(await preparing).toBe(false);
    await lease.activate(); expect(bridge.activate).not.toHaveBeenCalled();
    const fresh = new NativeChromeLease(projection, "owner-b");
    bridge.prepare.mockImplementation(async (value) => ({ ...value, phase: "prepared" }));
    await fresh.prepare(); await fresh.activate();
    const action = vi.fn();
    await fresh.choose(choice(lease), () => true, action);
    expect(action).not.toHaveBeenCalled();
  });
  it("never lets late recovery retire a replacement or reordered confirmations execute twice", async () => {
    const old = new NativeChromeLease(projection, "owner-a");
    await old.prepare(); await old.activate();
    const fresh = new NativeChromeLease(projection, "owner-b");
    await fresh.prepare(); await fresh.activate();
    bridge.retire.mockClear();
    await retireNativeChrome("owner-a", old.projection);
    expect(bridge.retire).not.toHaveBeenCalled();
    const first = deferred<{ valid: boolean }>();
    const second = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const action = vi.fn();
    const firstChoice = fresh.choose(choice(fresh, 1), () => true, action);
    const secondChoice = fresh.choose(choice(fresh, 2), () => true, action);
    second.resolve({ valid: true }); await secondChoice;
    first.resolve({ valid: true }); await firstChoice;
    expect(action).toHaveBeenCalledOnce();
    await fresh.choose(choice(fresh, 3), () => true, action);
    // A new intentional tap remains available if navigation was cancelled.
    // It is not a replay of either previously consumed choice.
    expect(action).toHaveBeenCalledTimes(2);
  });

  function Harness({ context = "/one/profile/security", owner = "synthetic-owner", suppressed = false, onBack = vi.fn() }) {
    useSessionChromeSuppression(suppressed);
    return <NativeShellBack label="Go back" onBack={onBack} owner={owner} context={context} eligible />;
  }
  function measureSlot() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 2, y: 60, width: 44, height: 44, top: 60, left: 2, right: 46, bottom: 104, toJSON: () => ({}),
    });
  }
  it("commits DOM isolation before activation and waits for retirement during session checks", async () => {
    measureSlot();
    const onBack = vi.fn();
    const view = render(<Harness onBack={onBack} />);
    const button = view.getByRole("button", { name: "Go back" });
    bridge.activate.mockImplementation(async (value) => {
      expect(button).toBeDisabled();
      expect(button).toHaveStyle({ visibility: "hidden" });
      return { ...value, phase: "active" };
    });
    await waitFor(() => expect(bridge.activate).toHaveBeenCalled());
    const approval = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(approval.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...bridge.activate.mock.calls.at(-1)![0], sequence: 1, privacyGeneration: 0 }));
    const pending = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValue(pending.promise);
    view.rerender(<Harness suppressed onBack={onBack} />);
    await act(async () => { approval.resolve({ valid: true }); });
    expect(onBack).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    await waitFor(() => expect(bridge.retire.mock.calls.at(-1)?.[0].revision).toBeGreaterThan(bridge.activate.mock.calls.at(-1)![0].revision));
    await act(async () => { pending.resolve({ ...bridge.retire.mock.calls.at(-1)![0], phase: "retired" }); });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).not.toHaveStyle({ visibility: "hidden" });
    bridge.retire.mockImplementation(async (value) => ({ ...value, phase: "retired" }));
  });
  it("does not remove a replacement when old activation fails after a context change", async () => {
    measureSlot();
    const pending = deferred<ChromeAcknowledgement>();
    bridge.activate.mockReturnValueOnce(pending.promise);
    const view = render(<Harness />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(1));
    view.rerender(<Harness context="/one/profile/account" />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const retirements = bridge.retire.mock.calls.length;
    await act(async () => { pending.reject(new Error("synthetic_old_ack_failure")); });
    expect(bridge.retire).toHaveBeenCalledTimes(retirements);
    expect(view.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(view.getByRole("button", { hidden: true })).toBeDisabled();
  });
  it.each(["web", "android", "older-ios"])("retains the existing control on %s", async (platform) => {
    bridge.platform = platform === "older-ios" ? "ios" : platform;
    if (platform === "older-ios") bridge.getCapabilities.mockResolvedValue({ contractVersion: 1, families: [] });
    const view = render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    expect(view.getByRole("button", { name: "Go back" })).not.toBeDisabled();
    expect(bridge.prepare).not.toHaveBeenCalled();
  });
});
