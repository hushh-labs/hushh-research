import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPortal } from "react-dom";

import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

const mocks = vi.hoisted(() => ({
  checkVault: vi.fn(),
  hasIncompleteNativeUiFlowSession: vi.fn(() => false),
  isNativePlatform: vi.fn(() => false),
  isNativeTestVaultBootstrapManaged: vi.fn(() => false),
  peekVaultPresence: vi.fn(),
  refreshVaultPresence: vi.fn(),
  replace: vi.fn(),
  retrySessionVerification: vi.fn(),
  signOut: vi.fn(),
  vaultUnlocked: false,
  ownerTokenStatus: "valid",
  retryOwnerTokenRenewal: vi.fn(),
  authState: {
    user: { uid: "user_1" } as { uid: string } | null,
    loading: false,
    sessionVerificationRequired: false,
  },
  VaultAuthSessionNotReadyError: class VaultAuthSessionNotReadyError extends Error {
    readonly code = "VAULT_AUTH_SESSION_NOT_READY";
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
    sessionVerificationRequired: mocks.authState.sessionVerificationRequired,
    retrySessionVerification: mocks.retrySessionVerification,
    signOut: mocks.signOut,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: mocks.vaultUnlocked,
    ownerTokenStatus: mocks.ownerTokenStatus,
    retryOwnerTokenRenewal: mocks.retryOwnerTokenRenewal,
    unlockVault: vi.fn(),
  }),
}));

vi.mock("@/lib/services/vault-service", () => ({
  VaultAuthSessionNotReadyError: mocks.VaultAuthSessionNotReadyError,
  VaultService: {
    checkVault: mocks.checkVault,
    peekVaultPresence: mocks.peekVaultPresence,
    refreshVaultPresence: mocks.refreshVaultPresence,
  },
}));

vi.mock("@/lib/progress/step-progress-context", () => ({
  useStepProgress: () => ({
    beginTask: vi.fn(),
    completeTaskStep: vi.fn(),
    endTask: vi.fn(),
  }),
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
  const dialogPrototype = HTMLDialogElement.prototype;
  const originalShowModal = Object.getOwnPropertyDescriptor(dialogPrototype, "showModal");
  const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, "close");
  const showModal = vi.fn(function(this: HTMLDialogElement) { this.setAttribute("open", ""); });
  beforeAll(() => {
    // JSDOM has no browser top layer. Actual inertness/focus behavior is covered
    // in Chromium/WebKit; this double proves the guard requests modal isolation.
    Object.defineProperty(dialogPrototype, "showModal", { configurable: true, value: showModal });
    Object.defineProperty(dialogPrototype, "close", {
      configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute("open"); },
    });
  });
  afterAll(() => {
    if (originalShowModal) Object.defineProperty(dialogPrototype, "showModal", originalShowModal);
    else Reflect.deleteProperty(dialogPrototype, "showModal");
    if (originalClose) Object.defineProperty(dialogPrototype, "close", originalClose);
    else Reflect.deleteProperty(dialogPrototype, "close");
  });

  it("uses top-layer privacy isolation for a previously mounted route portal", () => {
    mocks.vaultUnlocked = true;
    const page = () => <VaultLockGuard>{createPortal(<button>Private portal sentinel</button>, document.body)}</VaultLockGuard>;
    const view = render(page());
    const sentinel = screen.getByText("Private portal sentinel");
    mocks.authState.sessionVerificationRequired = true;
    view.rerender(page());
    expect(screen.getByText("Private portal sentinel")).toBe(sentinel);
    const gate = screen.getByRole("dialog", { name: "Verifying access" });
    expect(gate).toHaveAttribute("open");
    expect(gate).toHaveAttribute("aria-modal", "true");
    expect(gate).toHaveStyle({ position: "fixed", background: "var(--background)" });
    expect(showModal).toHaveBeenCalled();
    const cancel = new Event("cancel", { cancelable: true, bubbles: true });
    gate.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    const retainedModalEscape = vi.fn();
    document.addEventListener("keydown", retainedModalEscape, true);
    fireEvent.keyDown(gate, { key: "Escape" });
    expect(retainedModalEscape).not.toHaveBeenCalled();
    document.removeEventListener("keydown", retainedModalEscape, true);
    const retainedModalOutside = vi.fn();
    document.addEventListener("pointerdown", retainedModalOutside);
    document.addEventListener("focusin", retainedModalOutside);
    fireEvent.pointerDown(gate);
    fireEvent.focusIn(gate);
    expect(retainedModalOutside).not.toHaveBeenCalled();
    document.removeEventListener("pointerdown", retainedModalOutside);
    document.removeEventListener("focusin", retainedModalOutside);
    mocks.authState.sessionVerificationRequired = false;
    view.rerender(page());
    expect(screen.queryByRole("dialog", { name: "Verifying access" })).toBeNull();
    expect(screen.getByText("Private portal sentinel")).toBe(sentinel);
  });

  it("never mounts private portals on a fresh unsettled gate", () => {
    mocks.vaultUnlocked = true;
    mocks.authState.loading = true;
    render(<VaultLockGuard>{createPortal(<button>Fresh private portal</button>, document.body)}</VaultLockGuard>);
    expect(screen.queryByText("Fresh private portal")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Verifying access" })).toHaveAttribute("open");
  });

  it("drops retained portals if browser-modal isolation is unavailable", () => {
    mocks.vaultUnlocked = true;
    const page = () => <VaultLockGuard>{createPortal(<button>Unsupported private portal</button>, document.body)}</VaultLockGuard>;
    const view = render(page());
    expect(screen.getByText("Unsupported private portal")).toBeInTheDocument();
    showModal.mockImplementationOnce(() => { throw new Error("unsupported modal"); });
    mocks.ownerTokenStatus = "unavailable";
    view.rerender(page());
    expect(screen.queryByText("Unsupported private portal")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("preserves a route draft through auth and token recovery without another unlock", async () => {
    mocks.vaultUnlocked = true;
    const page = <VaultLockGuard><input aria-label="Draft" defaultValue="" /></VaultLockGuard>;
    const view = render(page);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    mocks.authState.loading = true;
    view.rerender(<VaultLockGuard><input aria-label="Draft" defaultValue="" /></VaultLockGuard>);
    expect(draft).not.toBeVisible();
    expect(screen.getByText("Checking session...")).toBeVisible();
    mocks.authState.loading = false;
    mocks.ownerTokenStatus = "unavailable";
    view.rerender(<VaultLockGuard><input aria-label="Draft" defaultValue="" /></VaultLockGuard>);
    expect(draft).not.toBeVisible();
    expect(screen.queryByTestId("vault-unlock-dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.retryOwnerTokenRenewal).toHaveBeenCalledOnce();
    mocks.ownerTokenStatus = "valid";
    view.rerender(<VaultLockGuard><input aria-label="Draft" defaultValue="" /></VaultLockGuard>);
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep this draft");
  });

  it("recovers from a failed Vault read without guessing that an unlock is required", async () => {
    mocks.peekVaultPresence.mockReturnValue(null);
    mocks.checkVault.mockRejectedValueOnce(new Error("offline"));
    mocks.checkVault.mockResolvedValueOnce(false);
    render(
      <VaultLockGuard>
        <div>Protected route</div>
      </VaultLockGuard>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reconnect to continue securely",
    );
    expect(screen.queryByTestId("vault-unlock-dialog")).toBeNull();
    expect(screen.queryByText("Protected route")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Protected route")).toBeTruthy();
  });

  it("offers sign out when a Vault read cannot recover", async () => {
    mocks.peekVaultPresence.mockReturnValue(null);
    mocks.checkVault.mockRejectedValue(new Error("offline"));
    render(
      <VaultLockGuard>
        <div>Protected route</div>
      </VaultLockGuard>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).toHaveBeenCalledWith({ skipFcmCleanup: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authState.user = { uid: "user_1" };
    mocks.authState.loading = false;
    mocks.authState.sessionVerificationRequired = false;
    mocks.hasIncompleteNativeUiFlowSession.mockReturnValue(false);
    mocks.isNativePlatform.mockReturnValue(false);
    mocks.isNativeTestVaultBootstrapManaged.mockReturnValue(false);
    mocks.vaultUnlocked = false;
    mocks.ownerTokenStatus = "valid";
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

  it("revalidates cached negative presence before revealing protected content", async () => {
    mocks.peekVaultPresence.mockReturnValue(false);
    mocks.refreshVaultPresence.mockResolvedValue(true);

    render(
      <VaultLockGuard>
        <div>Protected route</div>
      </VaultLockGuard>,
    );

    expect(screen.getByText("Checking vault...")).toBeTruthy();
    await waitFor(() => {
      expect(mocks.refreshVaultPresence).toHaveBeenCalledWith("user_1");
      expect(screen.getByTestId("vault-unlock-dialog")).toBeTruthy();
    });
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

  it("retries native vault discovery while the restored session token becomes available", async () => {
    mocks.isNativePlatform.mockReturnValue(true);
    mocks.peekVaultPresence.mockReturnValue(null);
    mocks.checkVault.mockRejectedValueOnce(
      new mocks.VaultAuthSessionNotReadyError(),
    );
    mocks.checkVault.mockResolvedValueOnce(false);

    render(
      <VaultLockGuard>
        <div>Protected route</div>
      </VaultLockGuard>,
    );

    expect(screen.getByText("Checking vault...")).toBeTruthy();
    await waitFor(() => expect(mocks.checkVault).toHaveBeenCalledTimes(2), {
      timeout: 1_500,
    });
    expect(await screen.findByText("Protected route")).toBeTruthy();
    expect(screen.queryByTestId("vault-unlock-dialog")).toBeNull();
  });

  it("hard-gates a reviewer UID mismatch before any unlocked fast path", () => {
    mocks.isNativeTestVaultBootstrapManaged.mockReturnValue(true);
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

  it("hides unlocked vault content while auth session validation is pending", () => {
    mocks.vaultUnlocked = true;
    mocks.authState.loading = true;

    render(
      <VaultLockGuard>
        <div>Protected route</div>
      </VaultLockGuard>,
    );

    expect(screen.getByText("Checking session...")).toBeTruthy();
    expect(screen.queryByText("Protected route")).toBeNull();
  });

  it("keeps an unlocked Vault hidden behind an actionable recovery surface when verification is unavailable", async () => {
    mocks.vaultUnlocked = true;
    mocks.authState.sessionVerificationRequired = true;

    render(
      <VaultLockGuard>
        <div>Protected route</div>
      </VaultLockGuard>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Reconnect to continue securely",
    );
    expect(screen.queryByText("Protected route")).toBeNull();

    screen.getByRole("button", { name: "Try again" }).click();
    screen.getByRole("button", { name: "Sign out" }).click();
    await waitFor(() => {
      expect(mocks.retrySessionVerification).toHaveBeenCalledTimes(1);
      expect(mocks.signOut).toHaveBeenCalledTimes(1);
    });
  });
});
