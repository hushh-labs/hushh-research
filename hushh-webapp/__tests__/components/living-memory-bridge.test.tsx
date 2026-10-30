import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  uid: "owner-a",
  unlocked: true,
  vaultKey: "fixture-vault-key",
  vaultOwnerToken: "fixture-owner-token",
  token: vi.fn(),
  getMetadata: vi.fn(),
  refreshMemoryDocument: vi.fn(),
  syncLivingSources: vi.fn(),
  markPending: vi.fn(),
  domainChangeListener: null as ((detail: { userId: string; domain: string; operation: string }) => void) | null,
  connectionChangeListener: null as ((detail: { userId: string }) => void) | null,
  payoutChangeListener: null as ((detail: { kinds: string[] }) => void) | null,
  LivingSourcesIncompleteError: class extends Error {
    constructor(readonly failedKinds: string[], readonly recordsChanged = false) {
      super("Source inventory incomplete; retry required");
    }
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: m.uid }, userId: m.uid }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: m.unlocked,
    vaultKey: m.vaultKey,
    vaultOwnerToken: m.vaultOwnerToken,
  }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => 0,
  isVaultSessionEpochCurrent: () => true,
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: m.token },
}));
vi.mock("@/lib/services/cache-service", () => ({
  CacheService: {
    getInstance: () => ({
      subscribe: () => () => undefined,
      peek: () => undefined,
    }),
  },
  CACHE_KEYS: { ACCOUNT_IDENTITY: (userId: string) => `identity:${userId}` },
}));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    getMetadata: (...args: unknown[]) => m.getMetadata(...args),
  },
}));
vi.mock("@/lib/pkm/memory-refresh", () => ({
  refreshMemoryDocument: (...args: unknown[]) => m.refreshMemoryDocument(...args),
  watchMemoryFreshness: () => () => undefined,
  clearMemoryDocument: vi.fn(),
  markMemoryRefreshPending: (...args: unknown[]) => m.markPending(...args),
}));
vi.mock("@/lib/pkm/pkm-domain-change-events", () => ({
  subscribeToPkmDomainChanges: (listener: (detail: { userId: string; domain: string; operation: string }) => void) => {
    m.domainChangeListener = listener;
    return () => { m.domainChangeListener = null; };
  },
}));
vi.mock("@/lib/consent/consent-events", () => ({
  CONSENT_STATE_CHANGED_EVENT: "consent-state-changed",
}));
vi.mock("@/lib/connections/connection-graph-events", () => ({
  subscribeToConnectionGraphChanges: (listener: (detail: { userId: string }) => void) => {
    m.connectionChangeListener = listener;
    return () => { m.connectionChangeListener = null; };
  },
}));
vi.mock("@/lib/payouts/payout-events", () => ({
  subscribePayoutStateChanged: (listener: (detail: { kinds: string[] }) => void) => {
    m.payoutChangeListener = listener;
    return () => { m.payoutChangeListener = null; };
  },
  payoutChangeTouches: (detail: { kinds: string[] }, kinds: string[]) =>
    detail.kinds.some((kind) => kinds.includes(kind)),
}));
vi.mock("@/lib/agent/agent-chat-history-events", () => ({
  AGENT_CHAT_HISTORY_INVALIDATED_EVENT: "agent-chat-history-invalidated",
}));
vi.mock("@/lib/pkm/living-source-sync", () => ({
  LIVING_SOURCE_DOMAIN: "one_living_sources",
  LivingSourcesIncompleteError: m.LivingSourcesIncompleteError,
  syncLivingSources: (...args: unknown[]) => m.syncLivingSources(...args),
}));
vi.mock("@/lib/testing/native-test", () => ({
  shouldSkipReviewerBackgroundWritesForAutomation: () => false,
}));

import { LivingMemoryBridge } from "@/components/profile/living-memory-bridge";
import {
  getLivingSourceSessionVerification,
  recordLivingSourceSessionVerification,
} from "@/lib/pkm/living-source-session-verification";

const flush = () => act(async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
});

/**
 * The bridge forced a full, network-bound refresh on every trigger --
 * focus, the 60s interval, every consent mutation -- regardless of whether
 * refreshMemoryDocument's own freshness tracking already knew nothing
 * relevant had changed. Divya's account, with domains that will legitimately
 * 404 forever (never created), re-fetched them on every one of those
 * triggers: tens of identical requests over one short test session. The
 * freshness check already exists inside refreshMemoryDocument; the bridge
 * must let it decide, not force past it every time.
 */
describe("LivingMemoryBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.uid = "owner-a";
    m.unlocked = true;
    m.vaultKey = "fixture-vault-key";
    m.vaultOwnerToken = "fixture-owner-token";
    m.domainChangeListener = null;
    m.connectionChangeListener = null;
    m.payoutChangeListener = null;
    m.token.mockResolvedValue("fixture-id-token");
    m.getMetadata.mockResolvedValue({ domains: [{ key: "identity" }, { key: "professional" }] });
    m.syncLivingSources.mockResolvedValue(undefined);
    m.refreshMemoryDocument.mockResolvedValue({ document: null, status: "current", builtAt: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not force a refresh on every trigger once nothing has changed", async () => {
    render(<LivingMemoryBridge />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.refreshMemoryDocument).toHaveBeenCalledTimes(1);
    expect(m.refreshMemoryDocument.mock.calls[0]![0]).toMatchObject({ force: false });

    m.refreshMemoryDocument.mockClear();
    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.refreshMemoryDocument).toHaveBeenCalledTimes(1);
    expect(m.refreshMemoryDocument.mock.calls[0]![0]).toMatchObject({ force: false });
  });

  it("rebuilds quietly after a verification-only store and shows Updating for a found change", async () => {
    m.syncLivingSources.mockResolvedValue({ stored: true, recordsChanged: false });
    render(<LivingMemoryBridge />);
    await flush();
    expect(m.refreshMemoryDocument.mock.calls.at(-1)![0]).toMatchObject({ force: true });
    expect(m.markPending).not.toHaveBeenCalled();

    // A routine wake whose sync stored nothing lets the freshness check decide.
    m.refreshMemoryDocument.mockClear();
    m.syncLivingSources.mockResolvedValue({ stored: false, recordsChanged: false });
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(m.refreshMemoryDocument.mock.calls.at(-1)![0]).toMatchObject({ force: false });
    expect(m.markPending).not.toHaveBeenCalled();

    // A routine wake whose sync found a changed record marks the mirror
    // pending before the forced rebuild, so its old values never read current.
    m.refreshMemoryDocument.mockClear();
    m.syncLivingSources.mockResolvedValue({ stored: true, recordsChanged: true });
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(m.markPending).toHaveBeenCalledWith("owner-a");
    expect(m.refreshMemoryDocument.mock.calls.at(-1)![0]).toMatchObject({ force: true });
    expect(m.markPending.mock.invocationCallOrder[0])
      .toBeLessThan(m.refreshMemoryDocument.mock.invocationCallOrder.at(-1)!);

    // So does a committed owner change.
    m.markPending.mockClear();
    act(() => window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: { userId: "owner-a" } })));
    await flush();
    expect(m.markPending).toHaveBeenCalledWith("owner-a");
  });

  it("still refreshes when a relevant domain actually changed", async () => {
    render(<LivingMemoryBridge />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    m.refreshMemoryDocument.mockClear();

    act(() => {
      m.domainChangeListener?.({ userId: "owner-a", domain: "identity", operation: "stored" });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.refreshMemoryDocument).toHaveBeenCalledTimes(1);
  });

  it("ignores its own derived memory-document write, never looping on it", async () => {
    render(<LivingMemoryBridge />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    m.refreshMemoryDocument.mockClear();

    act(() => {
      m.domainChangeListener?.({ userId: "owner-a", domain: "one_living_sources", operation: "stored" });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.refreshMemoryDocument).not.toHaveBeenCalled();
  });

  it("wakes for the current owner's connection graph only", async () => {
    render(<LivingMemoryBridge />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    m.syncLivingSources.mockClear();
    act(() => m.connectionChangeListener?.({ userId: "other" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.syncLivingSources).not.toHaveBeenCalled();
    act(() => m.connectionChangeListener?.({ userId: "owner-a" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.syncLivingSources).toHaveBeenCalledTimes(1);
    expect(m.syncLivingSources).toHaveBeenCalledWith(
      expect.objectContaining({ forceConnections: true }),
    );
  });

  it("wakes payout activity on bank changes and both sources on earnings changes", async () => {
    render(<LivingMemoryBridge />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    m.syncLivingSources.mockClear();
    act(() => m.payoutChangeListener?.({ kinds: ["bank_payouts"] }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.syncLivingSources).toHaveBeenCalledWith(
      expect.objectContaining({ forcePayoutActivity: true, forceDocumentEarnings: false,
        forceDocumentRequestPayments: false }),
    );
    m.syncLivingSources.mockClear();
    act(() => m.payoutChangeListener?.({ kinds: ["earnings"] }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.syncLivingSources).toHaveBeenCalledWith(
      expect.objectContaining({ forceDocumentEarnings: true, forcePayoutActivity: true }),
    );
  });

  it("forces consent and curated OAuth reads for their change hints", async () => {
    render(<LivingMemoryBridge />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    m.syncLivingSources.mockClear();
    act(() => window.dispatchEvent(new CustomEvent("consent-state-changed", {
      detail: { userId: "other" },
    })));
    await act(async () => { await Promise.resolve(); });
    expect(m.syncLivingSources).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new CustomEvent("consent-state-changed", {
      detail: { userId: "owner-a" },
    })));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.syncLivingSources).toHaveBeenCalledWith(
      expect.objectContaining({ forceConsent: true, forceDocumentRequestPayments: true }),
    );
    m.syncLivingSources.mockClear();
    act(() => window.dispatchEvent(new CustomEvent("hushh:native-connector-return", {
      detail: { attemptId: "attempt", outcome: "ready" },
    })));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.syncLivingSources).toHaveBeenCalledWith(
      expect.objectContaining({ forceCuratedConnectors: true }),
    );
  });

  it("defers failed storage retries despite a burst of owner changes and retains their hints", async () => {
    vi.useFakeTimers();
    m.syncLivingSources.mockRejectedValueOnce(new Error("store-domain HTTP 429"));
    render(<LivingMemoryBridge />);
    await flush();
    expect(m.refreshMemoryDocument).not.toHaveBeenCalled();
    for (let i = 0; i < 20; i++) {
      act(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: { userId: "owner-a" } }));
      });
    }
    await flush();
    expect(m.syncLivingSources).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(m.syncLivingSources).toHaveBeenCalledTimes(2);
    expect(m.syncLivingSources).toHaveBeenLastCalledWith(expect.objectContaining({ forceConsent: true, forceDocumentRequestPayments: true }));
  });

  it("cancels a failed storage retry when the vault locks", async () => {
    vi.useFakeTimers();
    m.syncLivingSources.mockRejectedValueOnce(new Error("store-domain HTTP 429"));
    const view = render(<LivingMemoryBridge />);
    await flush();
    m.unlocked = false;
    view.rerender(<LivingMemoryBridge />);
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(m.syncLivingSources).toHaveBeenCalledTimes(1);
  });

  it("does not recreate a retry after an in-flight failure outlives vault cleanup", async () => {
    vi.useFakeTimers();
    let rejectSync!: (error: Error) => void;
    m.syncLivingSources.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSync = reject; }));
    const view = render(<LivingMemoryBridge />);
    await flush();
    m.unlocked = false;
    view.rerender(<LivingMemoryBridge />);
    m.markPending.mockClear();
    await act(async () => { rejectSync(new Error("store-domain HTTP 429")); });
    expect(m.markPending).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores cached consent re-announcements", async () => {
    render(<LivingMemoryBridge />);
    await flush();
    for (const source of ["cached_pending", "queued_pending", "hydrated_pending", "fcm_opened"]) {
      act(() => window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: { userId: "owner-a", source } })));
    }
    await flush();
    expect(m.syncLivingSources).toHaveBeenCalledTimes(1);
  });

  it("still refreshes the mirror after a sync that stored only the checked sources", async () => {
    m.syncLivingSources.mockRejectedValueOnce(new m.LivingSourcesIncompleteError(["consent"]));
    render(<LivingMemoryBridge />);
    await flush();
    expect(m.refreshMemoryDocument).toHaveBeenCalledTimes(1);
    expect(m.markPending).not.toHaveBeenCalled();
    // A record change stored beside the failed source still shows Updating.
    m.syncLivingSources.mockRejectedValueOnce(new m.LivingSourcesIncompleteError(["consent"], true));
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(m.syncLivingSources).toHaveBeenCalledTimes(2);
    expect(m.markPending).toHaveBeenCalledWith("owner-a");
  });

  it("wakes when the app becomes visible, never when it is hidden", async () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    try {
      render(<LivingMemoryBridge />);
      await flush();
      m.syncLivingSources.mockClear();
      visibility = "hidden";
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await flush();
      expect(m.syncLivingSources).not.toHaveBeenCalled();
      visibility = "visible";
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await flush();
      expect(m.syncLivingSources).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    }
  });

  const wakeEverything = async () => {
    act(() => {
      vi.advanceTimersByTime(120_000);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: { userId: "owner-a" } }));
      m.domainChangeListener?.({ userId: "owner-a", domain: "identity", operation: "stored" });
    });
    await flush();
  };

  it.each([
    ["the vault is locked", { unlocked: false }],
    ["the vault key is missing", { vaultKey: "" }],
  ])("never reads or writes sources while %s", async (_label, state) => {
    Object.assign(m, state);
    vi.useFakeTimers();
    render(<LivingMemoryBridge />);
    await flush();
    await wakeEverything();
    expect(m.syncLivingSources).not.toHaveBeenCalled();
    expect(m.refreshMemoryDocument).not.toHaveBeenCalled();
  });

  it("stops reading and forgets this session's verification when the vault locks", async () => {
    vi.useFakeTimers();
    recordLivingSourceSessionVerification("owner-a", 0, ["profile"], "2026-10-15T00:00:00.000Z");
    const view = render(<LivingMemoryBridge />);
    await flush();
    // Positive control: the unlocked bridge reads sources.
    expect(m.syncLivingSources).toHaveBeenCalled();
    m.unlocked = false;
    view.rerender(<LivingMemoryBridge />);
    expect(getLivingSourceSessionVerification("owner-a", 0)).toEqual({});
    m.syncLivingSources.mockClear();
    m.refreshMemoryDocument.mockClear();
    await wakeEverything();
    expect(m.syncLivingSources).not.toHaveBeenCalled();
    expect(m.refreshMemoryDocument).not.toHaveBeenCalled();
  });
});
