import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

const mocks = vi.hoisted(() => ({
  checkVault: vi.fn(),
  hasIncompleteNativeUiFlowSession: vi.fn(() => false),
  isNativePlatform: vi.fn(() => false),
  isNativeTestVaultBootstrapManaged: vi.fn(() => false),
  peekVaultPresence: vi.fn(),
  replace: vi.fn(),
  signOut: vi.fn(),
  sessionUnlockedOnce: false,
  vaultUnlocked: false,
  authState: {
    user: { uid: "user_1" } as { uid: string } | null,
    loading: false,
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: mocks.isNativePlatform },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: mocks.authState.user,
    loading: mocks.authState.loading,
    signOut: mocks.signOut,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: mocks.vaultUnlocked,
    unlockVault: vi.fn(),
  }),
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    checkVault: mocks.checkVault,
    peekVaultPresence: mocks.peekVaultPresence,
  },
}));

vi.mock("@/lib/progress/step-progress-context", () => ({
  useStepProgress: () => ({
    beginTask: vi.fn(),
    completeTaskStep: vi.fn(),
    endTask: vi.fn(),
  }),
}));

vi.mock("@/lib/vault/vault-session-latch", () => ({
  isSessionUnlockedOnce: () => mocks.sessionUnlockedOnce,
  markSessionUnlocked: vi.fn(),
}));

vi.mock("@/lib/testing/native-test", () => ({
  hasIncompleteNativeUiFlowSession: mocks.hasIncompleteNativeUiFlowSession,
  isNativeTestVaultBootstrapManaged: mocks.isNativeTestVaultBootstrapManaged,
  preferPassphraseUnlockForAutomation: () => false,
  useNativeTestConfig: () => null,
}));

vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({
    surfaceVariant,
    dismissible,
  }: {
    surfaceVariant?: string;
    dismissible: boolean;
  }) => (
    <div
      data-testid="vault-unlock-dialog"
      data-dismissible={String(dismissible)}
      data-surface={surfaceVariant}
    />
  ),
}));

describe("VaultLockGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authState.user = { uid: "user_1" };
    mocks.authState.loading = false;
    mocks.hasIncompleteNativeUiFlowSession.mockReturnValue(false);
    mocks.isNativePlatform.mockReturnValue(false);
    mocks.isNativeTestVaultBootstrapManaged.mockReturnValue(false);
    mocks.sessionUnlockedOnce = false;
    mocks.vaultUnlocked = false;
    delete window.__HUSHH_NATIVE_TEST__;
  });

  it("uses the focused hard-gate unlock surface instead of a route hero", async () => {
    mocks.peekVaultPresence.mockReturnValue(null);
    mocks.checkVault.mockResolvedValue(true);

    render(
      <VaultLockGuard>
        <div>Protected route</div>
      </VaultLockGuard>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("vault-unlock-dialog")).toBeTruthy();
    });

    const dialog = screen.getByTestId("vault-unlock-dialog");
    expect(dialog.getAttribute("data-surface")).toBe("hard_gate");
    expect(dialog.getAttribute("data-dismissible")).toBe("false");
    expect(screen.queryByText("Protected route")).toBeNull();
  });

  it("holds the requested route while native reviewer auth is restoring", async () => {
    mocks.authState.user = null;
    mocks.isNativeTestVaultBootstrapManaged.mockReturnValue(true);
    mocks.peekVaultPresence.mockReturnValue(null);

    render(
      <VaultLockGuard>
        <div>Protected route</div>
      </VaultLockGuard>,
    );

    expect(screen.getByText("Restoring reviewer session...")).toBeTruthy();
    await waitFor(() => expect(mocks.replace).not.toHaveBeenCalled());
  });

  it("holds an in-progress native flow before bridge config rehydrates", async () => {
    mocks.authState.user = null;
    mocks.hasIncompleteNativeUiFlowSession.mockReturnValue(true);
    mocks.peekVaultPresence.mockReturnValue(null);

    render(
      <VaultLockGuard>
        <div>Protected route</div>
      </VaultLockGuard>,
    );

    expect(screen.getByText("Restoring reviewer session...")).toBeTruthy();
    await waitFor(() => expect(mocks.replace).not.toHaveBeenCalled());
  });

  it("does not redirect during initial native Firebase restoration grace", async () => {
    mocks.authState.user = null;
    mocks.isNativePlatform.mockReturnValue(true);
    mocks.peekVaultPresence.mockReturnValue(null);

    render(
      <VaultLockGuard>
        <div>Protected route</div>
      </VaultLockGuard>,
    );

    expect(screen.getByText("Restoring reviewer session...")).toBeTruthy();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("hard-gates a reviewer UID mismatch before any unlocked fast path", () => {
    mocks.isNativeTestVaultBootstrapManaged.mockReturnValue(true);
    mocks.sessionUnlockedOnce = true;
    mocks.vaultUnlocked = true;
    window.__HUSHH_NATIVE_TEST__ = {
      enabled: true,
      bootstrapState: "uid_mismatch",
    };

    render(
      <VaultLockGuard>
        <div>Protected route</div>
      </VaultLockGuard>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Protected route")).toBeNull();
  });
});
