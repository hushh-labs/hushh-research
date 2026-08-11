import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nativePlatform: false,
  pausePkmUpgrade: vi.fn().mockResolvedValue(undefined),
  pauseConsentExport: vi.fn(),
  clearAgentPkmContext: vi.fn(),
  clearAgentChatHistoryCache: vi.fn(),
  warmAgentChatHistoryCache: vi.fn(),
  invalidateVaultState: vi.fn(),
  getIdToken: vi.fn(),
  unlockWarmRun: vi.fn(),
  authUser: {
    uid: "vault-owner",
    displayName: "Vault Owner",
    email: "owner@example.test",
    photoURL: null,
  } as {
    uid: string;
    displayName: string;
    email: string;
    photoURL: string | null;
  } | null,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => (mocks.nativePlatform ? "android" : "web"),
    isNativePlatform: () => mocks.nativePlatform,
  },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: mocks.authUser,
  }),
}));

vi.mock("@/lib/agent/agent-pkm-memory", () => ({
  clearAgentPkmContext: mocks.clearAgentPkmContext,
}));

vi.mock("@/lib/agent/agent-chat-history-cache", () => ({
  clearAgentChatHistoryCache: mocks.clearAgentChatHistoryCache,
  warmAgentChatHistoryCache: mocks.warmAgentChatHistoryCache,
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onVaultStateChanged: vi.fn() },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhConsent: {
    clearIMessageSession: vi.fn().mockResolvedValue(undefined),
    publishIMessageSession: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/observability/growth", () => ({
  trackGrowthFunnelStepCompleted: vi.fn(),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: mocks.getIdToken },
}));

vi.mock("@/lib/services/consent-export-refresh-orchestrator", () => ({
  ConsentExportRefreshOrchestrator: {
    ensureRunning: vi.fn().mockResolvedValue(undefined),
    pauseForLocalAuthResume: mocks.pauseConsentExport,
  },
}));

vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    invalidateSessionStateAfterVaultRekey: vi.fn(),
  },
}));

vi.mock("@/lib/services/pkm-upgrade-orchestrator", () => ({
  PkmUpgradeOrchestrator: {
    ensureRunning: vi.fn().mockResolvedValue(undefined),
    pauseForLocalAuthResume: mocks.pausePkmUpgrade,
  },
}));

vi.mock("@/lib/services/unlock-warm-orchestrator", () => ({
  UnlockWarmOrchestrator: { run: mocks.unlockWarmRun },
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: { invalidateVaultStateCache: mocks.invalidateVaultState },
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
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

const NOW = 1_800_000_000_000;

function VaultHarness() {
  const vault = useVault();
  return (
    <div>
      <span data-testid="vault-status">
        {vault.isVaultUnlocked ? "unlocked" : "locked"}
      </span>
      <span data-testid="vault-token">{vault.vaultOwnerToken ?? "none"}</span>
      <span data-testid="vault-key">{vault.vaultKey ?? "none"}</span>
      <button
        type="button"
        onClick={() => vault.unlockVault("vault-key", "vault-token", NOW + 1_000)}
      >
        Unlock short-lived
      </button>
      <button
        type="button"
        onClick={() => vault.unlockVault("vault-key", "vault-token", NOW + 60_000)}
      >
        Unlock valid
      </button>
    </div>
  );
}

function renderVault() {
  return render(
    <VaultProvider>
      <VaultHarness />
    </VaultProvider>,
  );
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.warmAgentChatHistoryCache.mockResolvedValue(undefined);
  mocks.getIdToken.mockResolvedValue("firebase-token");
  mocks.unlockWarmRun.mockResolvedValue(undefined);
  mocks.nativePlatform = false;
  mocks.authUser = {
    uid: "vault-owner",
    displayName: "Vault Owner",
    email: "owner@example.test",
    photoURL: null,
  };
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  appInteractionCoordinator.handleLifecycle("active");
  setVisibility("hidden");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VaultProvider app-resume expiry recovery", () => {
  it("starts protected Agent Chat warming before optional Firebase token resolution", async () => {
    vi.useFakeTimers();
    let resolveIdToken: ((token: string) => void) | null = null;
    mocks.getIdToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveIdToken = resolve;
        }),
    );

    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mocks.warmAgentChatHistoryCache).toHaveBeenCalledWith({
      userId: "vault-owner",
      vaultOwnerToken: "vault-token",
    });
    expect(mocks.unlockWarmRun).not.toHaveBeenCalled();

    resolveIdToken?.("firebase-token");
  });

  it("relocks and clears memory-only credentials when an expired token resumes on web", async () => {
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock short-lived" }));
    expect(screen.getByTestId("vault-status").textContent).toBe("unlocked");

    vi.spyOn(Date, "now").mockReturnValue(NOW + 2_000);
    act(() => {
      appInteractionCoordinator.handleLifecycle("background");
      appInteractionCoordinator.handleLifecycle("active");
    });

    await waitFor(() => {
      expect(screen.getByTestId("vault-status").textContent).toBe("locked");
    });
    expect(screen.getByTestId("vault-token").textContent).toBe("none");
    expect(screen.getByTestId("vault-key").textContent).toBe("none");
    expect(mocks.invalidateVaultState).toHaveBeenCalled();
    expect(mocks.clearAgentPkmContext).toHaveBeenCalledWith("vault-owner");
    expect(mocks.clearAgentChatHistoryCache).toHaveBeenCalledWith("vault-owner");
  });

  it("keeps a still-valid token unlocked when the web app resumes", () => {
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));

    act(() => {
      appInteractionCoordinator.handleLifecycle("background");
      appInteractionCoordinator.handleLifecycle("active");
    });

    expect(screen.getByTestId("vault-status").textContent).toBe("unlocked");
    expect(screen.getByTestId("vault-token").textContent).toBe("vault-token");
  });

  it("relocks and clears credentials when API validation requests a vault lock", async () => {
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("vault-lock-requested", {
          detail: { reason: "Token validation failed." },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("vault-status").textContent).toBe("locked");
    });
    expect(screen.getByTestId("vault-token").textContent).toBe("none");
    expect(screen.getByTestId("vault-key").textContent).toBe("none");
    expect(mocks.invalidateVaultState).toHaveBeenCalled();
  });

  it("relocks only when the shared native lifecycle becomes active", async () => {
    mocks.nativePlatform = true;
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock short-lived" }));
    vi.spyOn(Date, "now").mockReturnValue(NOW + 2_000);

    act(() => appInteractionCoordinator.handleLifecycle("background"));
    expect(screen.getByTestId("vault-status").textContent).toBe("unlocked");

    act(() => appInteractionCoordinator.handleLifecycle("active"));
    await waitFor(() => {
      expect(screen.getByTestId("vault-status").textContent).toBe("locked");
    });
  });

  it("fails closed and clears memory credentials when the authenticated UID changes", async () => {
    const view = renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    expect(screen.getByTestId("vault-status").textContent).toBe("unlocked");

    mocks.authUser = {
      uid: "different-user",
      displayName: "Different User",
      email: "different@example.test",
      photoURL: null,
    };
    view.rerender(
      <VaultProvider>
        <VaultHarness />
      </VaultProvider>,
    );

    expect(screen.getByTestId("vault-status").textContent).toBe("locked");
    expect(screen.getByTestId("vault-token").textContent).toBe("none");
    expect(screen.getByTestId("vault-key").textContent).toBe("none");
    await waitFor(() => expect(mocks.invalidateVaultState).toHaveBeenCalled());
  });
});
