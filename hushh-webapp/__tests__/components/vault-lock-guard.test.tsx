import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

const { replaceMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: null,
    loading: false,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: false,
    unlockVault: vi.fn(),
  }),
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    checkVault: vi.fn(),
  },
}));

vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => <div>Unlock dialog</div>,
}));

vi.mock("@/lib/progress/step-progress-context", () => ({
  useStepProgress: () => ({
    beginTask: vi.fn(),
    completeTaskStep: vi.fn(),
    endTask: vi.fn(),
  }),
}));

vi.mock("@/lib/vault/vault-session-latch", () => ({
  isSessionUnlockedOnce: () => false,
  markSessionUnlocked: vi.fn(),
}));

vi.mock("@/lib/testing/native-test", () => ({
  isNativeTestVaultBootstrapManaged: () => false,
  preferPassphraseUnlockForAutomation: () => false,
  useNativeTestConfig: () => null,
}));

describe("VaultLockGuard", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    window.history.pushState({}, "", "/one/location");
  });

  it("keeps the unauthenticated loader label hydration-stable while redirecting", async () => {
    render(
      <VaultLockGuard>
        <div>Protected location content</div>
      </VaultLockGuard>,
    );

    expect(screen.getByText("Checking session...")).toBeTruthy();
    expect(screen.queryByText("Protected location content")).toBeNull();
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/login?redirect=%2Fone%2Flocation");
    });
  });
});
