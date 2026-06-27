import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RiaClientAccountDetail } from "@/components/ria/ria-client-account-detail";
import { useRiaClientWorkspaceState } from "@/components/ria/use-ria-client-workspace-state";

vi.mock("@/components/ria/use-ria-client-workspace-state", () => ({
  useRiaClientWorkspaceState: vi.fn(),
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));

describe("RiaClientAccountDetail", () => {
  it("covers loading detail state", () => {
    vi.mocked(useRiaClientWorkspaceState).mockReturnValue({
      user: { uid: "advisor-1" },
      riaCapability: "active",
      personaLoading: false,
      detail: null,
      workspace: null,
      loading: true,
      detailError: null,
      iamUnavailable: false,
      isTestProfile: false,
      refreshWorkspace: vi.fn(),
    } as unknown as ReturnType<typeof useRiaClientWorkspaceState>);

    const { container } = render(
      <RiaClientAccountDetail clientId="client-1" accountId="account-1" />,
    );

    expect(screen.getByText("Loading account detail...")).toBeTruthy();

    const beacon = container.querySelector(
      '[data-testid="native-route-ria-client-account-detail"]',
    );
    expect(beacon?.getAttribute("data-native-data-state")).toBe("loading");
  });
});
