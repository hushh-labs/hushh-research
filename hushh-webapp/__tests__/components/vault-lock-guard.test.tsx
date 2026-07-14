import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

const mocks = vi.hoisted(() => ({
  checkVault: vi.fn(),
  peekVaultPresence: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "user_1" },
    loading: false,
    signOut: mocks.signOut,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: false, unlockVault: vi.fn() }),
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
  isSessionUnlockedOnce: () => false,
  markSessionUnlocked: vi.fn(),
}));

vi.mock("@/lib/testing/native-test", () => ({
  isNativeTestVaultBootstrapManaged: () => false,
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
});
