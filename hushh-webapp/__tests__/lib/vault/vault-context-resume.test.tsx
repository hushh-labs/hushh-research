import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nativePlatform: false,
  appStateListener: null as ((state: { isActive: boolean }) => void) | null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  pausePkmUpgrade: vi.fn().mockResolvedValue(undefined),
  pauseConsentExport: vi.fn(),
  clearAgentPkmContext: vi.fn(),
  invalidateVaultState: vi.fn(),
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
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: mocks.addListener,
  },
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: mocks.authUser,
  }),
}));

vi.mock("@/lib/agent/agent-pkm-memory", () => ({
  clearAgentPkmContext: mocks.clearAgentPkmContext,
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
  AuthService: { getIdToken: vi.fn().mockResolvedValue("firebase-token") },
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
  UnlockWarmOrchestrator: { run: vi.fn().mockResolvedValue(undefined) },
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
        onClick={() => vault.unlockVault("vault-key", "vault-token", NOW)}
      >
        Unlock expired
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
  mocks.nativePlatform = false;
  mocks.authUser = {
    uid: "vault-owner",
    displayName: "Vault Owner",
    email: "owner@example.test",
    photoURL: null,
  };
  mocks.appStateListener = null;
  mocks.addListener.mockImplementation(
    async (
      _event: string,
      listener: (state: { isActive: boolean }) => void,
    ) => {
      mocks.appStateListener = listener;
      return { remove: mocks.removeListener };
    },
  );
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  setVisibility("hidden");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VaultProvider app-resume expiry recovery", () => {
  it("relocks and clears memory-only credentials when an expired token resumes on web", async () => {
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock expired" }));
    expect(screen.getByTestId("vault-status").textContent).toBe("unlocked");

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    await waitFor(() => {
      expect(screen.getByTestId("vault-status").textContent).toBe("locked");
    });
    expect(screen.getByTestId("vault-token").textContent).toBe("none");
    expect(screen.getByTestId("vault-key").textContent).toBe("none");
    expect(mocks.invalidateVaultState).toHaveBeenCalled();
    expect(mocks.clearAgentPkmContext).toHaveBeenCalledWith("vault-owner");
  });

  it("keeps a still-valid token unlocked when the web app resumes", () => {
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));

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

  it("relocks only when the native app becomes active and removes its listener", async () => {
    mocks.nativePlatform = true;
    const view = renderVault();
    await waitFor(() => expect(mocks.addListener).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Unlock expired" }));
    await waitFor(() => expect(mocks.appStateListener).not.toBeNull());

    act(() => mocks.appStateListener?.({ isActive: false }));
    expect(screen.getByTestId("vault-status").textContent).toBe("unlocked");

    act(() => mocks.appStateListener?.({ isActive: true }));
    await waitFor(() => {
      expect(screen.getByTestId("vault-status").textContent).toBe("locked");
    });

    view.unmount();
    await waitFor(() => expect(mocks.removeListener).toHaveBeenCalled());
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
