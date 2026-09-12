import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nativePlatform: false,
  iosPlatform: false,
  authLoading: false,
  sessionVerificationRequired: false,
  issueVaultOwnerToken: vi.fn(),
  publishIMessageSession: vi.fn(),
  clearIMessageSession: vi.fn(),
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
    getIdToken?: (force?: boolean) => Promise<string>;
  } | null,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => (mocks.iosPlatform ? "ios" : mocks.nativePlatform ? "android" : "web"),
    isNativePlatform: () => mocks.nativePlatform,
  },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: mocks.authUser,
    loading: mocks.authLoading,
    sessionVerificationRequired: mocks.sessionVerificationRequired,
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
    clearIMessageSession: mocks.clearIMessageSession,
    publishIMessageSession: mocks.publishIMessageSession,
  },
}));

vi.mock("@/lib/observability/growth", () => ({
  trackGrowthFunnelStepCompleted: vi.fn(),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: mocks.getIdToken, getCurrentUser: () => mocks.authUser },
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
  VaultService: { invalidateVaultStateCache: mocks.invalidateVaultState, issueVaultOwnerToken: mocks.issueVaultOwnerToken },
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
import { AUTH_SESSION_INVALIDATED_EVENT } from "@/lib/auth/session-invalidation";
import { ApiService } from "@/lib/services/api-service";

const NOW = 1_800_000_000_000;
let currentVault: ReturnType<typeof useVault>;

function VaultHarness() {
  const vault = useVault();
  useEffect(() => { currentVault = vault; }, [vault]);
  return (
    <div>
      <span data-testid="vault-status">
        {vault.isVaultUnlocked ? "unlocked" : "locked"}
      </span>
      <span data-testid="vault-token">{vault.vaultOwnerToken ?? "none"}</span>
      <span data-testid="vault-key">{vault.vaultKey ?? "none"}</span>
      <span data-testid="owner-token-status">{vault.ownerTokenStatus}</span>
      <button onClick={() => void vault.retryOwnerTokenRenewal()}>Renew</button>
      <button onClick={vault.lockVault}>Lock</button>
      <button onClick={() => vault.unlockVault("vault-key", "vault-token", NOW + 600_000)}>Unlock long-lived</button>
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
  mocks.iosPlatform = false;
  mocks.authLoading = false;
  mocks.sessionVerificationRequired = false;
  mocks.issueVaultOwnerToken.mockRejectedValue(new Error("offline"));
  mocks.publishIMessageSession.mockResolvedValue({ published: true });
  mocks.clearIMessageSession.mockResolvedValue({ cleared: true, sessionGeneration: 1 });
  mocks.authUser = {
    uid: "vault-owner",
    displayName: "Vault Owner",
    email: "owner@example.test",
    photoURL: null,
    getIdToken: mocks.getIdToken,
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
  it("renews authority before expiry without another local unlock", async () => {
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockRestore();
    vi.setSystemTime(NOW);
    mocks.issueVaultOwnerToken.mockResolvedValue({ token: "renewed-token", expiresAt: NOW + 86_400_000, scope: "vault.owner", renewalValidated: true });
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock long-lived" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(mocks.issueVaultOwnerToken).toHaveBeenCalledWith("vault-owner", "firebase-token", "vault-token");
    expect(currentVault.getVaultOwnerToken()).toBe("renewed-token");
    expect(currentVault.getVaultKey()).toBe("vault-key");
    expect(currentVault.ownerTokenStatus).toBe("valid");
  });

  it("never returns an expired token even before a lifecycle render", () => {
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    vi.spyOn(Date, "now").mockReturnValue(NOW + 60_001);
    expect(currentVault.getVaultOwnerToken()).toBeNull();
    expect(currentVault.getVaultKey()).toBe("vault-key");
  });

  it("rejects an older server's unacknowledged renewal result", async () => {
    mocks.issueVaultOwnerToken.mockResolvedValue({ token: "unvalidated-result", expiresAt: NOW + 86_400_000, scope: "vault.owner" });
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    vi.spyOn(Date, "now").mockReturnValue(NOW + 60_001);
    await act(async () => { await currentVault.retryOwnerTokenRenewal(); });
    expect(currentVault.getVaultOwnerToken()).toBeNull();
    expect(currentVault.getVaultKey()).toBe("vault-key");
    expect(currentVault.ownerTokenStatus).toBe("unavailable");
  });

  it("locks on a terminal renewal rejection without retrying initial issuance", async () => {
    mocks.issueVaultOwnerToken.mockRejectedValue({ code: "AUTH_VAULT_OWNER_INVALID" });
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    await act(async () => { await currentVault.retryOwnerTokenRenewal(); });
    expect(currentVault.getVaultKey()).toBeNull();
    expect(currentVault.getVaultOwnerToken()).toBeNull();
    expect(mocks.issueVaultOwnerToken).toHaveBeenCalledTimes(1);
    expect(mocks.issueVaultOwnerToken).toHaveBeenCalledWith("vault-owner", "firebase-token", "vault-token");
  });

  it("retains the local key through a temporary renewal failure", async () => {
    mocks.issueVaultOwnerToken.mockRejectedValue({ code: "AUTH_ACCOUNT_STATUS_UNAVAILABLE" });
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    vi.spyOn(Date, "now").mockReturnValue(NOW + 60_001);
    await act(async () => { await currentVault.retryOwnerTokenRenewal(); });
    expect(currentVault.getVaultKey()).toBe("vault-key");
    expect(currentVault.getVaultOwnerToken()).toBeNull();
    expect(currentVault.ownerTokenStatus).toBe("unavailable");
  });

  it("renews an expired token after an ambiguous native invalid-owner lock request", async () => {
    let finish!: (value: { token: string; expiresAt: number; scope: string; renewalValidated: boolean }) => void;
    mocks.issueVaultOwnerToken.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    vi.spyOn(Date, "now").mockReturnValue(NOW + 60_001);
    act(() => {
      window.dispatchEvent(new CustomEvent("vault-lock-requested", {
        detail: { reason: "AUTH_VAULT_OWNER_INVALID", path: "/api/kai/analyze/stream" },
      }));
    });
    await waitFor(() => expect(mocks.issueVaultOwnerToken).toHaveBeenCalledWith("vault-owner", "firebase-token", "vault-token"));
    expect(currentVault.getVaultKey()).toBe("vault-key");
    expect(currentVault.getVaultOwnerToken()).toBeNull();
    expect(currentVault.ownerTokenStatus).toBe("renewing");
    await act(async () => { finish({ token: "renewed-token", expiresAt: NOW + 86_400_000, scope: "vault.owner", renewalValidated: true }); });
    expect(currentVault.getVaultKey()).toBe("vault-key");
    expect(currentVault.getVaultOwnerToken()).toBe("renewed-token");
  });

  it("clears the key when expired-token recovery confirms revoked lineage", async () => {
    mocks.issueVaultOwnerToken.mockRejectedValue({ code: "AUTH_VAULT_OWNER_INVALID" });
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    vi.spyOn(Date, "now").mockReturnValue(NOW + 60_001);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("vault-lock-requested", {
        detail: { reason: "AUTH_VAULT_OWNER_INVALID", path: "/api/kai/analyze/stream" },
      }));
    });
    expect(mocks.issueVaultOwnerToken).toHaveBeenCalledTimes(1);
    expect(currentVault.getVaultKey()).toBeNull();
    expect(currentVault.getVaultOwnerToken()).toBeNull();
  });

  it("keeps explicit owner revocation destructive even after expiry", () => {
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    vi.spyOn(Date, "now").mockReturnValue(NOW + 60_001);
    act(() => window.dispatchEvent(new CustomEvent("vault-lock-requested", {
      detail: { reason: "VAULT_OWNER token revoked" },
    })));
    expect(currentVault.getVaultKey()).toBeNull();
    expect(mocks.issueVaultOwnerToken).not.toHaveBeenCalled();
  });

  it("ignores a pre-renewal API failure but honors a current-token revocation", async () => {
    let finishRequest!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(new Promise((resolve) => { finishRequest = resolve; }));
    mocks.issueVaultOwnerToken.mockResolvedValue({ token: "renewed-token", expiresAt: NOW + 86_400_000, scope: "vault.owner", renewalValidated: true });
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    const oldRequest = ApiService.apiFetch("/api/one/location/state", {
      headers: { Authorization: "Bearer HCT:old-owner-token" },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.spyOn(Date, "now").mockReturnValue(NOW + 60_001);
    await act(async () => { await currentVault.retryOwnerTokenRenewal(); });
    await act(async () => {
      finishRequest(Response.json({ code: "AUTH_VAULT_OWNER_INVALID" }, { status: 403 }));
      await oldRequest;
    });
    expect(currentVault.getVaultKey()).toBe("vault-key");
    expect(currentVault.getVaultOwnerToken()).toBe("renewed-token");
    fetchMock.mockResolvedValueOnce(Response.json({ code: "AUTH_VAULT_OWNER_INVALID" }, { status: 403 }));
    await act(async () => { await ApiService.apiFetch("/api/one/location/state", {
      headers: { Authorization: "Bearer HCT:renewed-owner-token" },
    }); });
    expect(currentVault.getVaultKey()).toBeNull();
  });

  it("rejects late renewal and stale unlock callbacks after an explicit lock", async () => {
    let resolveRenewal!: (value: { token: string; expiresAt: number; scope: string }) => void;
    mocks.issueVaultOwnerToken.mockReturnValue(new Promise((resolve) => { resolveRenewal = resolve; }));
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    const staleUnlock = currentVault.unlockVault;
    await act(async () => { void currentVault.retryOwnerTokenRenewal(); });
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    await act(async () => { resolveRenewal({ token: "late-token", expiresAt: NOW + 86_400_000, scope: "vault.owner" }); });
    expect(staleUnlock("late-key", "late-token", NOW + 86_400_000)).toBe(false);
    expect(currentVault.getVaultKey()).toBeNull();
    expect(currentVault.getVaultOwnerToken()).toBeNull();
  });

  it("does not renew while identity verification is unresolved", async () => {
    const view = renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    mocks.sessionVerificationRequired = true;
    view.rerender(<VaultProvider><VaultHarness /></VaultProvider>);
    await act(async () => { await currentVault.retryOwnerTokenRenewal(); });
    expect(mocks.issueVaultOwnerToken).not.toHaveBeenCalled();
    expect(currentVault.getVaultKey()).toBe("vault-key");
  });

  it("drops late iMessage publication when the local session locks", async () => {
    mocks.iosPlatform = true;
    let resolveToken!: (value: string) => void;
    mocks.getIdToken.mockReturnValue(new Promise<string>((resolve) => { resolveToken = resolve; }));
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    await act(async () => { resolveToken("firebase-token"); });
    expect(mocks.publishIMessageSession).not.toHaveBeenCalled();
    expect(mocks.clearIMessageSession).toHaveBeenCalledTimes(2);
  });

  it("requires a new unlock after the provider runtime is replaced", () => {
    const view = renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));
    view.unmount();
    renderVault();
    expect(currentVault.getVaultKey()).toBeNull();
    expect(currentVault.isVaultUnlocked).toBe(false);
  });

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

  it("retains the local unlock but withdraws an expired token on web resume", async () => {
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock short-lived" }));
    expect(screen.getByTestId("vault-status").textContent).toBe("unlocked");

    vi.spyOn(Date, "now").mockReturnValue(NOW + 2_000);
    act(() => {
      appInteractionCoordinator.handleLifecycle("background");
      appInteractionCoordinator.handleLifecycle("active");
    });

    await waitFor(() => {
      expect(screen.getByTestId("vault-status").textContent).toBe("unlocked");
    });
    expect(screen.getByTestId("vault-token").textContent).toBe("none");
    expect(screen.getByTestId("vault-key").textContent).toBe("vault-key");
    expect(mocks.clearAgentPkmContext).not.toHaveBeenCalled();
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
          detail: { reason: "Token validation failed.", path: "/api/one/location/state" },
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

  it("immediately clears the matching Vault on uncertain account deletion", async () => {
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AUTH_SESSION_INVALIDATED_EVENT, {
          detail: {
            code: "account_deletion_uncertain",
            path: "account_delete_uncertain_unverified",
            userId: "vault-owner",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("vault-status").textContent).toBe("locked");
    });
    expect(screen.getByTestId("vault-token").textContent).toBe("none");
    expect(screen.getByTestId("vault-key").textContent).toBe("none");
    expect(mocks.clearAgentPkmContext).toHaveBeenCalledWith("vault-owner");
  });

  it("does not let a delayed account-A terminal event lock account B", () => {
    mocks.authUser = {
      uid: "account-b",
      displayName: "Account B",
      email: "b@example.test",
      photoURL: null,
    };
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock valid" }));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AUTH_SESSION_INVALIDATED_EVENT, {
          detail: {
            code: "account_not_found",
            path: "delayed_account_a_request",
            userId: "account-a",
          },
        }),
      );
    });

    expect(screen.getByTestId("vault-status").textContent).toBe("unlocked");
    expect(screen.getByTestId("vault-token").textContent).toBe("vault-token");
  });

  it("retains the key but hides expired authority when native becomes active", async () => {
    mocks.nativePlatform = true;
    renderVault();
    fireEvent.click(screen.getByRole("button", { name: "Unlock short-lived" }));
    vi.spyOn(Date, "now").mockReturnValue(NOW + 2_000);

    act(() => appInteractionCoordinator.handleLifecycle("background"));
    expect(screen.getByTestId("vault-status").textContent).toBe("unlocked");

    act(() => appInteractionCoordinator.handleLifecycle("active"));
    await waitFor(() => {
      expect(screen.getByTestId("vault-token").textContent).toBe("none");
    });
    expect(screen.getByTestId("vault-status").textContent).toBe("unlocked");
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
