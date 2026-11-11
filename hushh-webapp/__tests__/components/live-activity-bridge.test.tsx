import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  uid: "owner-a",
  unlocked: true,
  token: "fixture-owner-token",
  policyEnabled: true,
  attach: vi.fn(),
  detach: vi.fn(),
  setEnabled: vi.fn(),
  consolidate: vi.fn(),
  loadPolicy: vi.fn(),
  toastInfo: vi.fn(),
  noticeSeen: new Set<string>(),
  markNoticeSeen: vi.fn(),
  record: vi.fn(),
  /** The visible journal; default: one event a minute old at read time. */
  peek: null as null | (() => Array<{ lastAt: number }>),
  stage: vi.fn(),
  trackEvent: vi.fn(),
  resetListeners: new Set<(owner: string) => void>(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: m.uid }, userId: m.uid }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: m.unlocked,
    vaultKey: m.unlocked ? "fixture-vault-key" : null,
    vaultOwnerToken: m.unlocked ? m.token : null,
  }),
}));
vi.mock("@/lib/observability/product-activity-scope", async () => {
  const owner = await import("@/lib/auth/session-owner");
  return {
    snapshotProductActivityScope: () => {
      const snapshot = owner.snapshotValidatedAuthSessionOwner();
      return snapshot ? { owner: snapshot, reset: 0 } : null;
    },
    isProductActivityScopeCurrent: (scope: { owner: { userId: string; generation: number } }) =>
      owner.isValidatedAuthSessionOwnerCurrent(scope.owner),
  };
});
vi.mock("@/lib/agent/agent-pkm-auto-save-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/agent-pkm-auto-save-policy")>();
  return {
    loadAgentPkmAutoSavePolicy: (...args: unknown[]) => m.loadPolicy(...args),
    // The real runtime_secrets pkm-domain-changed listener.
    subscribeAgentPkmAutoSavePolicyInvalidation: actual.subscribeAgentPkmAutoSavePolicyInvalidation,
  };
});
vi.mock("@/lib/pkm/live-activity/live-activity-journal", () => ({
  // Each attachment hands back its own detach, as the journal does.
  attachLiveActivityStore: (...args: unknown[]) => { m.attach(...args); return () => m.detach(); },
  setLiveActivityEnabled: (...args: unknown[]) => m.setEnabled(...args),
  peekLiveActivity: () => (m.peek ? m.peek() : [{ lastAt: Date.now() - 60_000 }]),
  recordLiveActivity: (...args: unknown[]) => m.record(...args),
  hasSeenLiveActivityNotice: (userId: string) => m.noticeSeen.has(userId),
  markLiveActivityNoticeSeen: (userId: string) => { m.markNoticeSeen(userId); m.noticeSeen.add(userId); },
}));
vi.mock("@/lib/services/secure-durable-resource-service", () => ({
  subscribeDurableOwnerReset: (listener: (owner: string) => void) => {
    m.resetListeners.add(listener);
    return () => m.resetListeners.delete(listener);
  },
}));
vi.mock("@/lib/observability/client", () => ({
  trackEvent: (...args: unknown[]) => m.trackEvent(...args),
}));
vi.mock("@/lib/pkm/live-activity/live-activity-consolidation", () => ({
  consolidateLiveActivity: (...args: unknown[]) => m.consolidate(...args),
  shouldConsolidateLiveActivity: (stats: { pending: number }) => stats.pending > 0,
}));
vi.mock("@/lib/morphy-ux/toast-utils", () => ({
  morphyToast: { info: (...args: unknown[]) => m.toastInfo(...args) },
}));

import { LiveActivityBridge } from "@/components/profile/live-activity-bridge";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const NOTICE = "One now remembers useful things you do in the app.";
const flush = () => act(async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
});

function signIn(uid: string) {
  m.uid = uid;
  publishValidatedAuthSessionOwner(uid);
}

function turnAutomaticMemory(userId: string, enabled: boolean) {
  m.policyEnabled = enabled;
  window.dispatchEvent(new CustomEvent("pkm-domain-changed", { detail: { userId, domain: "runtime_secrets" } }));
}

function hide() {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** One 60-second check; runs start only from the timer, never from hiding. */
const nextCheck = () => act(() => { vi.advanceTimersByTime(60_000); });

describe("LiveActivityBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.noticeSeen.clear();
    m.unlocked = true;
    m.token = "fixture-owner-token";
    m.loadPolicy.mockImplementation(async () => ({ enabled: m.policyEnabled, version: 1, enabledAt: null, source: "product_default" }));
    m.consolidate.mockResolvedValue({ outcome: "saved", saved: 1 });
    m.policyEnabled = true;
    m.peek = null;
  });
  afterEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => publishValidatedAuthSessionOwner(null));
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  it("attaches on unlock, shows the notice once per owner on this device and detaches on lock", async () => {
    signIn("owner-notice");
    const view = render(<LiveActivityBridge />);
    await flush();

    expect(m.toastInfo).toHaveBeenCalledTimes(1);
    expect(m.toastInfo).toHaveBeenCalledWith(NOTICE, expect.objectContaining({ duration: expect.any(Number) }));
    expect(m.setEnabled).toHaveBeenCalledWith("owner-notice", true);
    expect(m.attach).toHaveBeenCalledWith({ userId: "owner-notice", vaultKey: "fixture-vault-key" });

    // A token renewal keeps the attached journal (and its unflushed events).
    m.token = "renewed-owner-token";
    view.rerender(<LiveActivityBridge />);
    await flush();
    expect(m.detach).not.toHaveBeenCalled();

    m.unlocked = false;
    view.rerender(<LiveActivityBridge />);
    expect(m.detach).toHaveBeenCalledTimes(1);
    expect(m.setEnabled).toHaveBeenLastCalledWith("owner-notice", false);

    m.unlocked = true;
    view.rerender(<LiveActivityBridge />);
    await flush();
    expect(m.attach).toHaveBeenCalledTimes(2);
    expect(m.toastInfo).toHaveBeenCalledTimes(1);
    expect(m.markNoticeSeen).toHaveBeenCalledExactlyOnceWith("owner-notice");
  });

  it("moves capture to the new owner and never consolidates for the previous one", async () => {
    vi.useFakeTimers();
    signIn("owner-a");
    const view = render(<LiveActivityBridge />);
    await flush();
    expect(m.attach).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner-a" }));

    act(() => signIn("owner-b"));
    view.rerender(<LiveActivityBridge />);
    await flush();

    expect(m.setEnabled).toHaveBeenCalledWith("owner-a", false);
    expect(m.detach).toHaveBeenCalledTimes(1);
    expect(m.attach).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "owner-b" }));

    nextCheck();
    await flush();
    expect(m.consolidate).toHaveBeenCalledTimes(1);
    const params = m.consolidate.mock.calls[0][0];
    expect(params).toMatchObject({ userId: "owner-b", reason: "attach" });
    expect(params.isCurrent()).toBe(true);
    act(() => signIn("owner-c"));
    expect(params.isCurrent()).toBe(false);
  });

  it("does nothing beyond disabling capture when automatic memory is off, and does not re-read it", async () => {
    vi.useFakeTimers();
    m.policyEnabled = false;
    signIn("owner-off");
    render(<LiveActivityBridge />);
    await flush();
    act(() => hide());
    await flush();
    act(() => { vi.advanceTimersByTime(60_000); });
    await flush();

    expect(m.loadPolicy).toHaveBeenCalledTimes(1);
    expect(m.setEnabled).toHaveBeenCalledWith("owner-off", false);
    expect(m.setEnabled).not.toHaveBeenCalledWith("owner-off", true);
    expect(m.attach).not.toHaveBeenCalled();
    expect(m.toastInfo).not.toHaveBeenCalled();
    expect(m.consolidate).not.toHaveBeenCalled();
  });

  it("cancels an in-flight consolidation when automatic memory is turned off", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    m.consolidate.mockImplementation(async (params: { isCurrent: () => boolean }) => {
      await gate;
      if (!params.isCurrent()) return { outcome: "failed", saved: 0 };
      m.stage();
      return { outcome: "saved", saved: 1 };
    });
    vi.useFakeTimers();
    signIn("owner-optout");
    render(<LiveActivityBridge />);
    await flush();
    nextCheck();
    await flush();
    expect(m.consolidate).toHaveBeenCalledTimes(1);

    act(() => turnAutomaticMemory("owner-optout", false));
    await flush();
    expect(m.setEnabled).toHaveBeenLastCalledWith("owner-optout", false);
    release();
    await flush();

    expect(m.stage).not.toHaveBeenCalled();
    expect(m.trackEvent).not.toHaveBeenCalled();
  });

  it("restarts capture after an account reset while the vault stays unlocked", async () => {
    signIn("owner-reset");
    render(<LiveActivityBridge />);
    await flush();
    expect(m.attach).toHaveBeenCalledTimes(1);

    act(() => { for (const listener of m.resetListeners) listener("owner-reset"); });
    await flush();

    expect(m.detach).toHaveBeenCalledTimes(1);
    expect(m.attach).toHaveBeenCalledTimes(2);
  });

  it("keeps capture off after a failed policy read and retries it on the next check", async () => {
    vi.useFakeTimers();
    m.loadPolicy.mockRejectedValueOnce(new Error("network"));
    signIn("owner-flaky");
    render(<LiveActivityBridge />);
    await flush();
    expect(m.attach).not.toHaveBeenCalled();
    expect(m.setEnabled).toHaveBeenLastCalledWith("owner-flaky", false);

    act(() => { vi.advanceTimersByTime(60_000); });
    await flush();

    expect(m.loadPolicy).toHaveBeenCalledTimes(2);
    expect(m.attach).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner-flaky" }));
  });

  it("records the section that was open when the store attached", async () => {
    window.history.replaceState(null, "", "/one/location");
    signIn("owner-section");
    render(<LiveActivityBridge />);
    await flush();

    expect(m.record).toHaveBeenCalledExactlyOnceWith({ kind: "section_opened", subject: "location" });
  });

  it.each([
    [{ outcome: "saved", saved: 3 }, { outcome: "saved", saved_bucket: "2_5" }],
    [{ outcome: "host_skipped", saved: 0 }, { outcome: "host_skipped", saved_bucket: "0" }],
    [{ outcome: "failed", saved: 0 }, { outcome: "failed", saved_bucket: "0" }],
  ])("reports the cycle outcome %o through its own enum-only event", async (outcome, expected) => {
    vi.useFakeTimers();
    m.consolidate.mockResolvedValue(outcome);
    signIn(`owner-outcome-${outcome.outcome}`);
    render(<LiveActivityBridge />);
    await flush();
    nextCheck();
    await flush();

    expect(m.trackEvent).toHaveBeenCalledExactlyOnceWith("live_activity_consolidation_completed", expected);
  });

  it("waits for new activity after a blocked run, but retries a backlog after the gap", async () => {
    vi.useFakeTimers();
    const seenAt = Date.now() - 60_000;
    m.peek = () => [{ lastAt: seenAt }];
    m.consolidate.mockResolvedValue({ outcome: "memory_full", saved: 0, more: false });
    signIn("owner-blocked");
    render(<LiveActivityBridge />);
    await flush();
    nextCheck();
    await flush();
    expect(m.consolidate).toHaveBeenCalledTimes(1);

    for (let check = 0; check < 3; check++) { nextCheck(); await flush(); }
    expect(m.consolidate).toHaveBeenCalledTimes(1);

    const newer = Date.now();
    m.peek = () => [{ lastAt: seenAt }, { lastAt: newer }];
    m.consolidate.mockResolvedValue({ outcome: "saved", saved: 1, more: true });
    nextCheck();
    await flush();
    expect(m.consolidate).toHaveBeenCalledTimes(2);

    // Another day is still queued: the same events are offered again without new activity.
    nextCheck();
    await flush();
    expect(m.consolidate).toHaveBeenCalledTimes(3);
  });

  it("never starts a run when the app hides, and cancels a running one unreported", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    m.consolidate.mockImplementation(async (params: { signal: AbortSignal }) => {
      await gate;
      return params.signal.aborted ? { outcome: "failed", saved: 0 } : { outcome: "saved", saved: 1 };
    });
    signIn("owner-hide");
    render(<LiveActivityBridge />);
    await flush();
    act(() => hide());
    await flush();
    expect(m.consolidate).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    nextCheck();
    await flush();
    const params = m.consolidate.mock.calls[0][0];
    act(() => hide());
    expect(params.signal.aborted).toBe(true);
    release();
    await flush();
    expect(m.trackEvent).not.toHaveBeenCalled();
  });
});
