import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DirectCallControl } from "@/components/direct-messages/direct-call-control";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import type { CallView, VerifyPeer } from "@/lib/direct-messages/call-session";

const harness = vi.hoisted(() => ({ native: false, available: false,
  platform: "web", nativeInitialized: vi.fn(),
  publish: null as ((view: CallView) => void) | null, verify: null as VerifyPeer | null,
  start: vi.fn(async () => undefined), end: vi.fn(async () => undefined), dispose: vi.fn(), initialized: vi.fn() }));
vi.mock("@capacitor/core", async importOriginal => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return { ...actual, Capacitor: { ...actual.Capacitor, isNativePlatform: () => harness.native, getPlatform: () => harness.platform } };
});
vi.mock("@/lib/services/direct-calls-service", () => ({ DirectCallsService: class {
  capabilities = async () => ({ available: harness.available });
} }));
vi.mock("@/lib/direct-messages/call-session", () => ({ DirectCallSession: class {
  constructor(_service: unknown, publish: (view: CallView) => void, verify: VerifyPeer) { harness.publish = publish; harness.verify = verify; }
  initialize = async () => { harness.initialized(); };
  start = harness.start; end = harness.end; dispose = harness.dispose; answer = vi.fn(); mute = vi.fn();
} }));
vi.mock("@/lib/direct-messages/native-call-session", () => ({ NativeCallSession: class {
  initialize = async () => { harness.nativeInitialized(); return harness.available; };
  start = harness.start; end = harness.end; dispose = harness.dispose; answer = vi.fn(); mute = vi.fn();
} }));

const props = { ownerId: "synthetic-owner", getIdToken: async () => "synthetic-token", conversationId: "synthetic-conversation",
  peerName: "Synthetic peer", canCall: true, className: "" };
const incoming: CallView = { call: { id: "synthetic-call", conversationId: props.conversationId, state: "ringing", revision: 1,
  expiresAt: 9999999999, isCaller: false, callerDeviceId: "caller", calleeDeviceId: null }, error: null, muted: false, mediaConnected: false };
beforeEach(() => { harness.native = false; harness.platform = "web"; harness.available = false; harness.publish = null; harness.verify = null; vi.clearAllMocks(); });

describe("Messages call presentation", () => {
  it("uses OS-owned iOS calling without page-visibility hangup", async () => {
    harness.native = true; harness.platform = "ios"; harness.available = true;
    const { unmount } = render(<DirectCallControl {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start voice call" })).toBeEnabled());
    expect(harness.nativeInitialized).toHaveBeenCalledOnce();
    expect(harness.initialized).not.toHaveBeenCalled();
    fireEvent(window, new Event("pagehide"));
    expect(harness.end).not.toHaveBeenCalled();
    unmount();
    expect(harness.dispose).toHaveBeenCalledOnce();
  });
  it("keeps disabled release and native callers from opening a foreground substitute", async () => {
    const { unmount } = render(<DirectCallControl {...props} />);
    expect(screen.getByRole("button", { name: "Start voice call" })).toBeDisabled();
    await act(async () => { await Promise.resolve(); });
    expect(harness.initialized).not.toHaveBeenCalled();
    unmount(); harness.native = true; harness.available = true;
    render(<DirectCallControl {...props} />);
    expect(screen.getByRole("button", { name: "Start voice call" })).toBeDisabled();
    expect(harness.initialized).not.toHaveBeenCalled();
  });

  it("uses one modal for incoming verification and gives verification Back priority", async () => {
    harness.available = true;
    render(<DirectCallControl {...props} />);
    await waitFor(() => expect(harness.initialized).toHaveBeenCalledOnce());
    act(() => harness.publish?.(incoming));
    let verification!: Promise<boolean>;
    act(() => { verification = harness.verify!(props.conversationId, "0123456789abcdef"); });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Verify this conversation");
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    act(() => { expect(unwindBackLayer("/one/messages")).toBe(true); });
    await expect(verification).resolves.toBe(false);
    expect(harness.end).not.toHaveBeenCalled();
    act(() => { unwindBackLayer("/one/messages"); });
    expect(harness.end).toHaveBeenCalledOnce();
  });

  it("shows errors and clears an old owner's verification prompt", async () => {
    harness.available = true;
    const { rerender } = render(<DirectCallControl {...props} />);
    await waitFor(() => expect(harness.initialized).toHaveBeenCalledOnce());
    act(() => harness.publish?.({ ...incoming, call: null, error: "Microphone permission denied." }));
    expect(screen.getByRole("status")).toHaveTextContent("Microphone permission denied.");
    fireEvent.click(screen.getAllByRole("button", { name: "Close", exact: true })[0]!);
    let verification!: Promise<boolean>;
    act(() => { verification = harness.verify!(props.conversationId, "0123456789abcdef"); });
    rerender(<DirectCallControl {...props} ownerId="synthetic-other" />);
    await expect(verification).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
