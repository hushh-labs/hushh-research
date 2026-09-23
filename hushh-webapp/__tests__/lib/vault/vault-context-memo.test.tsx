import { act, render } from "@testing-library/react";
import { memo } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * The vault context value must be referentially stable across renders of the
 * provider that change no vault fact.
 *
 * useVault() has over a hundred consumers and VaultProvider sits inside the
 * app shell frame, which re-renders on every search-param change (each
 * `?tab=` tap). An inline value object re-rendered every consumer on every
 * tab switch; the memo re-mints only when a vault fact changes.
 */

const mocks = vi.hoisted(() => ({
  authUser: {
    uid: "vault-owner",
    displayName: "Vault Owner",
    email: "owner@example.test",
    photoURL: null,
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "web", isNativePlatform: () => false },
  registerPlugin: vi.fn(() => ({})),
}));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: mocks.authUser,
    loading: false,
    sessionVerificationRequired: false,
  }),
}));
vi.mock("@/lib/agent/agent-pkm-memory", () => ({ clearAgentPkmContext: vi.fn() }));
vi.mock("@/lib/agent/agent-chat-history-cache", () => ({
  clearAgentChatHistoryCache: vi.fn(),
  warmAgentChatHistoryCache: vi.fn(),
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onVaultStateChanged: vi.fn() },
}));
vi.mock("@/lib/capacitor", () => ({
  HushhConsent: { clearIMessageSession: vi.fn(), publishIMessageSession: vi.fn() },
}));
vi.mock("@/lib/observability/growth", () => ({ trackGrowthFunnelStepCompleted: vi.fn() }));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: vi.fn(), getCurrentUser: () => mocks.authUser },
}));
vi.mock("@/lib/services/consent-export-refresh-orchestrator", () => ({
  ConsentExportRefreshOrchestrator: {
    ensureRunning: vi.fn().mockResolvedValue(undefined),
    pauseForLocalAuthResume: vi.fn(),
  },
}));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { invalidateSessionStateAfterVaultRekey: vi.fn() },
}));
vi.mock("@/lib/services/pkm-upgrade-orchestrator", () => ({
  PkmUpgradeOrchestrator: {
    ensureRunning: vi.fn().mockResolvedValue(undefined),
    pauseForLocalAuthResume: vi.fn(),
  },
}));
vi.mock("@/lib/services/unlock-warm-orchestrator", () => ({
  UnlockWarmOrchestrator: { run: vi.fn() },
}));
vi.mock("@/lib/services/vault-service", () => ({
  VaultService: { invalidateVaultStateCache: vi.fn(), issueVaultOwnerToken: vi.fn() },
}));
vi.mock("@/lib/kai/kai-financial-resource", () => ({
  KaiFinancialResourceService: {
    hydrateFromSecureCache: vi.fn().mockResolvedValue(null),
    invalidate: vi.fn(),
  },
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    hydrateFromSecureCache: vi.fn().mockResolvedValue(null),
    invalidateDomain: vi.fn(),
  },
}));

import { VaultProvider, useVault } from "@/lib/vault/vault-context";

const consumerRenders = vi.fn();
const values: Array<ReturnType<typeof useVault>> = [];

// memo() so only a context change, never the parent's re-render, reaches it.
const Consumer = memo(function Consumer() {
  const vault = useVault();
  consumerRenders();
  values.push(vault);
  return <span data-testid="unlocked">{String(vault.isVaultUnlocked)}</span>;
});

function Parent({ tick }: { tick: number }) {
  return (
    <VaultProvider>
      <span data-tick={tick} />
      <Consumer />
    </VaultProvider>
  );
}

describe("VaultProvider value identity", () => {
  it("does not re-render consumers when the provider's parent re-renders", () => {
    const view = render(<Parent tick={0} />);
    const initialRenders = consumerRenders.mock.calls.length;
    expect(initialRenders).toBeGreaterThan(0);

    act(() => {
      view.rerender(<Parent tick={1} />);
    });
    act(() => {
      view.rerender(<Parent tick={2} />);
    });

    expect(consumerRenders.mock.calls.length).toBe(initialRenders);
    expect(values.at(-1)).toBe(values[0]);
  });
});
