import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectedSystemsOnboardingSetupClient } from "@/app/one/setup/connected-systems/connected-systems-onboarding-setup-client";

const params = { system: null as string | null };
let setupResolved = false;
const routerReplaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === "system" ? params.system : null),
  }),
  useRouter: () => ({ replace: routerReplaceMock }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "user-1" } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "owner-token" }),
}));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () =>
      setupResolved ? { setupCompleted: true } : null,
    isSetupResolved: () => setupResolved,
  },
}));
vi.mock("@/components/profile/connected-systems-panel", () => ({
  ConnectedSystemsPanel: ({
    mode,
    onSetupReadinessChange,
  }: {
    mode: string;
    onSetupReadinessChange: (ready: boolean) => void;
  }) => (
    <div>
      CRM panel {mode}
      <button type="button" onClick={() => onSetupReadinessChange(true)}>
        Bind CRM record
      </button>
    </div>
  ),
}));
vi.mock("@/components/onboarding/setup/setup-capability-coordinator", () => ({
  SetupCapabilityLoading: () => <div>loading</div>,
  useSetupCapabilityCoordinator: (input: {
    isOperationallyReady: boolean;
  }) => ({
    isReady: true,
    input,
  }),
  SetupCapabilityTerminalFooter: ({
    isOperationallyReady,
  }: {
    isOperationallyReady: boolean;
  }) => <div>Finish CRM setup {String(isOperationallyReady)}</div>,
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));
vi.mock("@/components/app-ui/vault-status-inline", () => ({
  VaultStatusInline: () => <div>vault status</div>,
}));

describe("Connected Systems onboarding", () => {
  beforeEach(() => {
    params.system = null;
    setupResolved = false;
    routerReplaceMock.mockReset();
  });

  it("requires a real linked profile before finishing from the list", () => {
    render(<ConnectedSystemsOnboardingSetupClient />);
    expect(screen.getByText("CRM panel list")).toBeTruthy();
    expect(screen.getByText("Finish CRM setup false")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bind CRM record" }));
    expect(screen.getByText("Finish CRM setup true")).toBeTruthy();
  });

  it("keeps the finish action off CRM detail screens", () => {
    params.system = "crm-1";
    render(<ConnectedSystemsOnboardingSetupClient />);
    expect(screen.getByText("CRM panel detail")).toBeTruthy();
    expect(screen.queryByText(/Finish CRM setup/)).toBeNull();
  });

  it("returns completed accounts to the canonical CRM workspace", () => {
    setupResolved = true;
    params.system = "crm-1";

    render(<ConnectedSystemsOnboardingSetupClient />);

    expect(routerReplaceMock).toHaveBeenCalledWith(
      "/one/connected-systems/crm-1",
    );
    expect(screen.getByText("loading")).toBeTruthy();
  });
});
