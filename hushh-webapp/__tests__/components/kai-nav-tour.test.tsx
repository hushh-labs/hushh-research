import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KaiNavTour } from "@/components/kai/onboarding/kai-nav-tour";

vi.mock("next/navigation", () => ({
  usePathname: () => "/kai",
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    loading: false,
    user: { uid: "user-1" },
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: false,
    vaultKey: null,
    vaultOwnerToken: null,
  }),
}));

vi.mock("@/lib/services/kai-nav-tour-local-service", () => ({
  KaiNavTourLocalService: {
    load: vi.fn().mockResolvedValue(null),
    markSkipped: vi.fn().mockResolvedValue({
      skipped_at: "2026-06-30T00:00:00.000Z",
    }),
    markSynced: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: vi.fn().mockResolvedValue(null),
    isNavTourResolved: vi.fn(() => false),
    updatePreVaultState: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/services/kai-profile-service", () => ({
  KaiProfileService: {
    getProfile: vi.fn(),
    setNavTourState: vi.fn(),
  },
}));

describe("KaiNavTour", () => {
  it("covers skip action button type", async () => {
    render(<KaiNavTour />);

    const skipButton = (await screen.findByRole("button", {
      name: "Skip",
    })) as HTMLButtonElement;

    expect(skipButton.type).toBe("button");
  });
});
