import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef, useRef } from "react";
import { NativeChromeLease, hasOutstandingNativeChrome, retireNativeChrome, syncNativeCanvasAppearance, type ChromeAcknowledgement, type ChromeProjection } from "@/lib/capacitor/native-chrome";
import { NativeShellBack } from "@/components/app-ui/native-shell-back";
import { NativeChatChrome, type NativeChatChromeHandle } from "@/components/app-ui/native-chat-chrome";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";
import { writeAccent } from "@/lib/theme/accent";
import { isCurrentNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

const bridge = vi.hoisted(() => ({ platform: "ios", callbacks: new Map<string, (event: unknown) => void>(),
  listeners: new Map<string, Set<(event: unknown) => void>>(),
  prepare: vi.fn(), activate: vi.fn(), retire: vi.fn(), confirmChoice: vi.fn(), getCapabilities: vi.fn(), setCanvasAppearance: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => bridge.platform !== "web", getPlatform: () => bridge.platform },
  registerPlugin: () => ({ ...bridge, addListener: async (name: string, callback: (event: unknown) => void) => {
    const listeners = bridge.listeners.get(name) ?? new Set<(event: unknown) => void>();
    listeners.add(callback);
    bridge.listeners.set(name, listeners);
    bridge.callbacks.set(name, (event) => listeners.forEach((listener) => listener(event)));
    return { remove: async () => { listeners.delete(callback); if (!listeners.size) bridge.callbacks.delete(name); } };
  } }),
}));
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativeDocumentId: () => "document-a",
  subscribeNativeSessionPrivacy: async () => ({ remove: async () => undefined }) }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({ useVoiceSurfaceMetadata: () => null, getVoiceSurfaceMetadata: () => null }));
const projection = { kind: "back" as const, label: "Go back", enabled: true,
  appearance: "light" as const, accentHex: "#112233", foregroundHex: "#223344",
  frame: { x: 2, y: 60, width: 44, height: 44 }, viewport: { width: 390, height: 844 } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject }; }
function choice(lease: NativeChromeLease, sequence = 1) { return { ...lease.projection, sequence, privacyGeneration: 0 }; }

describe("native chrome presentation lease", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.style.removeProperty("--app-accent");
    document.documentElement.style.removeProperty("--app-accent-deep");
    document.documentElement.style.setProperty("--muted-foreground", "#8e8e93");
    document.documentElement.style.removeProperty("--background");
    bridge.platform = "ios";
    bridge.callbacks.clear();
    bridge.listeners.clear();
    bridge.getCapabilities.mockReset().mockResolvedValue({ contractVersion: 2, families: ["back"], independentControls: true });
    bridge.setCanvasAppearance.mockReset().mockImplementation(async (value) => value);
    bridge.prepare.mockReset().mockImplementation(async (value: ChromeProjection) => ({ ...value, phase: "prepared" }));
    bridge.activate.mockReset().mockImplementation(async (value) => ({ ...value, phase: "active" }));
    bridge.retire.mockReset().mockImplementation(async (value) => ({ ...value, phase: "retired" }));
    bridge.confirmChoice.mockReset().mockResolvedValue({ valid: true });
    await Promise.all(["top-shell-back", "chat-history-toggle", "chat-agent-surface"].map((controlId) =>
      retireNativeChrome("owner-a", undefined, controlId as ChromeProjection["controlId"])));
  });
  afterEach(async () => { cleanup(); await act(async () => { await Promise.resolve(); }); vi.restoreAllMocks(); });
  it("uses the committed CSS canvas and cannot repaint an older theme after delayed discovery", async () => {
    const discovery = deferred<{ contractVersion: number; families: "back"[]; canvasAppearance: boolean }>();
    const capability = { contractVersion: 2, families: [] as "back"[], canvasAppearance: true };
    document.documentElement.style.setProperty("--background", "#f2f2f7");
    bridge.getCapabilities.mockReturnValueOnce(discovery.promise).mockResolvedValue(capability);
    const old = syncNativeCanvasAppearance();
    document.documentElement.style.setProperty("--background", "#0e0e10");
    expect(await syncNativeCanvasAppearance()).toBe(true);
    discovery.resolve(capability);
    expect(await old).toBe(false);
    expect(bridge.setCanvasAppearance).toHaveBeenCalledOnce();
    expect(bridge.setCanvasAppearance.mock.calls[0][0]).toMatchObject({ documentId: "document-a", backgroundHex: "#0e0e10" });
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [] });
    expect(await syncNativeCanvasAppearance()).toBe(false);
    bridge.getCapabilities.mockResolvedValue(capability);
    bridge.setCanvasAppearance.mockImplementation(async (value) => ({ ...value, revision: value.revision - 1 }));
    await expect(syncNativeCanvasAppearance()).rejects.toThrow("NATIVE_CANVAS_ACK_UNCONFIRMED");
  });
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

  it("retires only the requested independent control, including delayed acknowledgement", async () => {
    const back = new NativeChromeLease(projection, "owner-a");
    const history = new NativeChromeLease({ ...projection, kind: "history", label: "Open chat history" }, "owner-a");
    const selector = new NativeChromeLease({ ...projection, kind: "agent-surface", value: "one",
      frame: { ...projection.frame, x: 100, width: 100 } }, "owner-a");
    for (const lease of [back, history, selector]) { await lease.prepare(); await lease.activate(); }
    expect([back, history, selector].map((lease) => hasOutstandingNativeChrome(lease.projection.controlId))).toEqual([true, true, true]);
    const retired = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(retired.promise);
    history.invalidate();
    const retirement = retireNativeChrome("owner-a", history.projection);
    const request = bridge.retire.mock.calls.at(-1)![0];
    const replacement = new NativeChromeLease({ ...projection, kind: "history" }, "owner-b");
    await replacement.prepare(); await replacement.activate();
    retired.resolve({ ...request, phase: "retired" }); await retirement;
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(true);
    bridge.retire.mockClear();
    await retireNativeChrome("owner-a", history.projection);
    await retireNativeChrome("owner-a", back.projection, "chat-agent-surface");
    expect(bridge.retire).not.toHaveBeenCalled();
    const actions = [vi.fn(), vi.fn(), vi.fn()];
    await back.choose(choice(back), () => true, actions[0]);
    await selector.choose({ ...choice(selector), value: "puppy" }, () => true, actions[1]);
    await replacement.choose(choice(replacement), () => true, actions[2]);
    actions.forEach((action) => expect(action).toHaveBeenCalledOnce());
    await retireNativeChrome("owner-b", replacement.projection);
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(false);
    expect(hasOutstandingNativeChrome()).toBe(true);
    expect(hasOutstandingNativeChrome("chat-agent-surface")).toBe(true);
  });

  it("rejects stale selector identities and unbounded values before native confirmation", async () => {
    const selector = new NativeChromeLease({ ...projection, kind: "agent-surface", value: "one",
      frame: { ...projection.frame, width: 100 } }, "owner-a");
    await selector.prepare(); await selector.activate();
    const action = vi.fn();
    const event = { ...choice(selector), value: "puppy" as const };
    for (const invalid of [
      { ...event, ownerEpoch: "other-owner" }, { ...event, revision: event.revision - 1 },
      { ...event, controlId: "chat-history-toggle" as const }, { ...event, documentId: "other-document" },
      { ...event, value: "unbounded" as "one" }, { ...event, value: undefined },
    ]) await selector.choose(invalid, () => true, action);
    expect(bridge.confirmChoice).not.toHaveBeenCalled();
    await selector.choose(event, () => true, action);
    expect(bridge.confirmChoice).toHaveBeenCalledWith(expect.objectContaining({ controlId: "chat-agent-surface", value: "puppy" }));
    expect(action).toHaveBeenCalledOnce();
  });

  function ChatHarness({ kind = "history", value = "one", pendingAttention = 0, owner = "synthetic-owner",
    context = "/one/chat:vault-epoch", onAction = vi.fn(), handle }: {
    kind?: "history" | "agent-surface"; value?: "one" | "puppy"; pendingAttention?: number;
    owner?: string; context?: string; onAction?: (value?: "one" | "puppy") => void;
    handle?: ReturnType<typeof createRef<NativeChatChromeHandle>>;
  }) {
    const focusRef = useRef<HTMLButtonElement>(null);
    const common = { owner, context, eligible: true, className: "chat-slot", focusRef, ref: handle };
    const fallback = <button ref={focusRef}>Authored {kind}</button>;
    return kind === "history"
      ? <NativeChatChrome {...common} kind="history" pendingAttention={pendingAttention} onActivate={onAction}>{fallback}</NativeChatChrome>
      : <NativeChatChrome {...common} kind="agent-surface" value={value} onValueChange={onAction}>{fallback}</NativeChatChrome>;
  }
  function admitChat() {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["back", "history", "agent-surface"], independentControls: true });
  }
  it("preserves CSS secondary-label color and alpha, fencing unresolved or changed utility colors", async () => {
    admitChat();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 2, y: 60, width: 44, height: 44, top: 60, left: 2, right: 46, bottom: 104, toJSON: () => ({}),
    });
    document.documentElement.style.setProperty("--muted-foreground", "oklch(0.6 0.005 264)");
    const view = render(<ChatHarness />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const light = bridge.prepare.mock.calls.at(-1)![0];
    expect(light.foregroundHex).toMatch(/^#[0-9a-f]{6}$/);
    expect(light.foregroundHex).not.toBe(light.accentHex);
    expect(isCurrentNativeControlAppearance(light, "secondary")).toBe(true);
    // The action check reads committed CSS before observer publication.
    document.documentElement.style.setProperty("--muted-foreground", "rgba(235, 235, 245, 0.72)");
    expect(isCurrentNativeControlAppearance(light, "secondary")).toBe(false);
    act(() => document.documentElement.classList.add("dark"));
    await waitFor(() => expect(bridge.prepare.mock.calls.at(-1)![0]).toMatchObject({
      appearance: "dark", foregroundHex: "#ebebf5b8",
    }));
    const dark = bridge.prepare.mock.calls.at(-1)![0];
    document.documentElement.style.setProperty("--muted-foreground", "var(--unresolved-utility)");
    expect(isCurrentNativeControlAppearance(dark, "secondary")).toBe(false);
    act(() => document.documentElement.setAttribute("data-accent", "gold"));
    await waitFor(() => expect(view.getByRole("button", { name: "Authored history" })).toBeVisible());
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(false);
  });
  it("isolates simultaneous authored controls and retires native history when attention appears", async () => {
    admitChat();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const selector = this.textContent?.includes("agent-surface");
      return { x: selector ? 100 : 2, y: 60, width: selector ? 100 : 44, height: 44,
        top: 60, left: selector ? 100 : 2, right: selector ? 200 : 46, bottom: 104, toJSON: () => ({}) };
    });
    const onAction = vi.fn();
    const view = render(<><ChatHarness onAction={onAction} /><ChatHarness kind="agent-surface" /></>);
    bridge.activate.mockImplementation(async (identity) => {
      const kind = identity.controlId === "chat-history-toggle" ? "history" : "agent-surface";
      const button = view.getByText(`Authored ${kind}`);
      expect(button.parentElement).toHaveAttribute("inert");
      expect(button.parentElement).toHaveAttribute("aria-hidden", "true");
      expect(button.parentElement).toHaveStyle({ visibility: "hidden" });
      return { ...identity, phase: "active" };
    });
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    expect(bridge.prepare.mock.calls.find(([item]) => item.kind === "history")![0].foregroundHex).toBe("#8e8e93");
    expect(bridge.prepare.mock.calls.find(([item]) => item.kind === "agent-surface")![0].foregroundHex).not.toBe("#8e8e93");
    const old = bridge.activate.mock.calls.find(([identity]) => identity.controlId === "chat-history-toggle")![0];
    const confirmation = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(confirmation.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, privacyGeneration: 0 }));
    view.rerender(<><ChatHarness pendingAttention={1} onAction={onAction} /><ChatHarness kind="agent-surface" /></>);
    await act(async () => { confirmation.resolve({ valid: true }); });
    expect(onAction).not.toHaveBeenCalled();
    await waitFor(() => expect(view.getByRole("button", { name: "Authored history" })).toBeVisible());
    expect(hasOutstandingNativeChrome("chat-history-toggle")).toBe(false);
    expect(hasOutstandingNativeChrome("chat-agent-surface")).toBe(true);
    expect(bridge.prepare.mock.calls.filter(([item]) => item.kind === "history")).toHaveLength(1);
    view.rerender(<><ChatHarness onAction={onAction} /><ChatHarness kind="agent-surface" /></>);
    await waitFor(() => expect(bridge.prepare.mock.calls.filter(([item]) => item.kind === "history")).toHaveLength(2));
  });
  it.each([84, 88, 100, 321])("measures the selector's authored %s-point width instead of guessing a header size", async (width) => {
    admitChat();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 100, y: 60, width, height: 44, top: 60, left: 100, right: 100 + width, bottom: 104, toJSON: () => ({}),
    });
    const view = render(<ChatHarness kind="agent-surface" />);
    await waitFor(() => expect(bridge.getCapabilities).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    if (width >= 88 && width <= 320) {
      await waitFor(() => expect(bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent-surface", value: "one", frame: expect.objectContaining({ width }) })));
    } else {
      expect(bridge.prepare).not.toHaveBeenCalled();
      expect(view.getByRole("button", { name: "Authored agent-surface" })).toBeVisible();
    }
  });
  it("keeps selection React-owned and rejects an old owner/value during confirmation", async () => {
    admitChat();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 100, y: 60, width: 100, height: 44, top: 60, left: 100, right: 200, bottom: 104, toJSON: () => ({}),
    });
    const onAction = vi.fn();
    const view = render(<ChatHarness kind="agent-surface" onAction={onAction} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const old = bridge.activate.mock.calls.at(-1)![0];
    const pending = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(pending.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, value: "puppy", sequence: 1, privacyGeneration: 0 }));
    view.rerender(<ChatHarness kind="agent-surface" owner="replacement-owner" value="puppy" onAction={onAction} />);
    await act(async () => { pending.resolve({ valid: true }); });
    expect(onAction).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(2));
    const fresh = bridge.activate.mock.calls.at(-1)![0];
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...fresh, value: "one", sequence: 1, privacyGeneration: 0 }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("one"));
    expect(bridge.prepare.mock.calls.at(-1)![0].value).toBe("puppy"); // No second selector state.
  });
  it("restores authored focus only after native retirement and holds fallback until blur", async () => {
    admitChat(); measureSlot();
    const handle = createRef<NativeChatChromeHandle>();
    const view = render(<ChatHarness handle={handle} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    const retired = deferred<ChromeAcknowledgement>();
    bridge.retire.mockReturnValueOnce(retired.promise);
    const firstRetirement = bridge.retire.mock.calls.length;
    let result!: Promise<boolean>;
    act(() => { result = handle.current!.restoreFocus(); });
    const identity = bridge.retire.mock.calls[firstRetirement][0];
    expect(view.queryByRole("button", { name: "Authored history" })).toBeNull();
    await act(async () => { retired.resolve({ ...identity, phase: "retired" }); expect(await result).toBe(true); });
    const button = view.getByRole("button", { name: "Authored history" });
    await waitFor(() => expect(button).toHaveFocus());
    const preparations = bridge.prepare.mock.calls.length;
    fireEvent(window, new Event("resize"));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.prepare).toHaveBeenCalledTimes(preparations);
    act(() => { button.blur(); });
    await waitFor(() => expect(bridge.prepare.mock.calls.length).toBeGreaterThan(preparations));
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
  it("applies committed theme tokens and rejects an old-theme choice during replacement", async () => {
    measureSlot();
    const onBack = vi.fn();
    const view = render(<Harness onBack={onBack} />);
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledTimes(1));
    const old = bridge.activate.mock.calls.at(-1)![0];
    const approval = deferred<{ valid: boolean }>();
    bridge.confirmChoice.mockReturnValueOnce(approval.promise);
    act(() => bridge.callbacks.get("choiceRequested")?.({ ...old, sequence: 1, privacyGeneration: 0 }));
    await act(async () => {
      document.documentElement.style.setProperty("--app-accent", "#112233");
      document.documentElement.style.setProperty("--app-accent-deep", "#445566");
      document.documentElement.classList.add("dark");
      // Resolve before React commits the observer's replacement projection.
      // A class-only change must fence the old control immediately too.
      approval.resolve({ valid: true });
      await approval.promise;
    });
    expect(onBack).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.prepare.mock.calls.at(-1)![0]).toMatchObject({
      appearance: "dark", accentHex: "#112233", foregroundHex: "#445566",
    }));
    await waitFor(() => expect(bridge.activate.mock.calls.at(-1)![0].revision).toBeGreaterThan(old.revision));
    expect(view.queryByRole("button", { name: "Go back" })).toBeNull();
    act(() => {
      document.documentElement.style.setProperty("--app-accent", "#667788");
      writeAccent("gold");
    });
    await waitFor(() => expect(bridge.prepare.mock.calls.at(-1)![0].accentHex).toBe("#667788"));
  });
  it.each(["web", "android", "older-ios", "older-wrapper", "older-single-control-wrapper"])("retains the existing control on %s", async (platform) => {
    bridge.platform = platform.startsWith("older-") ? "ios" : platform;
    if (platform === "older-ios") bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: [] });
    if (platform === "older-wrapper") bridge.getCapabilities.mockResolvedValue({ contractVersion: 1, families: ["back"] });
    if (platform === "older-single-control-wrapper") bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["back"] });
    const view = render(<Harness />);
    await act(async () => { await Promise.resolve(); });
    expect(view.getByRole("button", { name: "Go back" })).not.toBeDisabled();
    expect(bridge.prepare).not.toHaveBeenCalled();
  });
});
