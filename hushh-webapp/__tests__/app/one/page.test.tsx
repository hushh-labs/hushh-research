import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  scheduleFinanceWorkspaceWarmup: vi.fn(() => vi.fn()),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: { uid: "one-dashboard-user", displayName: "One Person" },
    loading: false,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: "vault-key",
    vaultOwnerToken: "vault-owner-token",
  }),
}));

vi.mock("@/lib/onboarding/use-capability-setup-states", () => ({
  useCapabilitySetupStates: () => ({ byId: {} }),
}));

vi.mock("@/lib/kai/finance-workspace-warmup", () => ({
  scheduleFinanceWorkspaceWarmup: mocks.scheduleFinanceWorkspaceWarmup,
}));

vi.mock("@/components/app-ui/native-route-marker", () => ({
  NativeRouteMarker: () => null,
}));

vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: () => <div>Loading</div>,
}));

vi.mock("@/components/dashboard/one-dashboard-page", () => ({
  OneDashboardPage: () => <div>One dashboard</div>,
}));

import OneHomePage from "@/app/one/page";

describe("OneHomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scheduleFinanceWorkspaceWarmup.mockReturnValue(vi.fn());
  });

  it("warms the shared Finance cache from One instead of depending on /kai", async () => {
    render(<OneHomePage />);

    await waitFor(() => {
      expect(mocks.scheduleFinanceWorkspaceWarmup).toHaveBeenCalledWith({
        userId: "one-dashboard-user",
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner-token",
        activeTab: "market",
      });
    });
  });
});
