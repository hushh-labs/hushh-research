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
  domainChangeListener: null as ((detail: { userId: string; domain: string; operation: string }) => void) | null,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: m.uid } }),
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
  markMemoryRefreshPending: vi.fn(),
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
vi.mock("@/lib/agent/agent-chat-history-events", () => ({
  AGENT_CHAT_HISTORY_INVALIDATED_EVENT: "agent-chat-history-invalidated",
}));
vi.mock("@/lib/pkm/living-source-sync", () => ({
  LIVING_SOURCE_DOMAIN: "one_living_sources",
  syncLivingSources: (...args: unknown[]) => m.syncLivingSources(...args),
}));
vi.mock("@/lib/testing/native-test", () => ({
  shouldSkipReviewerBackgroundWritesForAutomation: () => false,
}));

import { LivingMemoryBridge } from "@/components/profile/living-memory-bridge";

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
});
