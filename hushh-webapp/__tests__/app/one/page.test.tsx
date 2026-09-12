import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  useCapabilitySetupStates: vi.fn(() => ({ byId: {} })),
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

vi.mock("@/lib/onboarding/use-capability-setup-states", () => ({
  useCapabilitySetupStates: mocks.useCapabilitySetupStates,
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
  });

  it("keeps home capability state coarse and renders the dashboard", async () => {
    const { getByText } = render(<OneHomePage />);

    await waitFor(() => {
      expect(getByText("One dashboard")).toBeTruthy();
    });
    expect(mocks.useCapabilitySetupStates).toHaveBeenCalledWith();
  });
});
