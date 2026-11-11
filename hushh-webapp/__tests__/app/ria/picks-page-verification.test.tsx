/**
 * RIA Picks is for verified advisors only. The page renders here with its
 * verification gate closed, so everything it shows an advisor must sit behind
 * the gate; what remains is what the page does on its own: whether it asks the
 * picks API (403 for anyone who is not verified) and what it tells One.
 */
import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  usePersonaState: vi.fn(),
  useStaleResource: vi.fn(),
  publishVoiceSurface: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "ria-user-1", getIdToken: async () => "token-123" },
    userId: "ria-user-1",
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: null, vaultOwnerToken: null, isVaultUnlocked: false }),
}));
vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: mocks.usePersonaState,
}));
vi.mock("@/lib/cache/use-stale-resource", () => ({
  useStaleResource: mocks.useStaleResource,
}));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: mocks.publishVoiceSurface,
}));
vi.mock("@/lib/kai/ticker-universe-cache", () => ({
  preloadTickerUniverse: () => Promise.resolve([]),
  searchTickerUniverseRemote: () => Promise.resolve([]),
}));
vi.mock("@/lib/services/ria-service", () => ({
  isIAMSchemaNotReadyError: () => false,
  RiaService: {
    getRenaissanceUniverse: () => Promise.resolve({ items: [], total: 0 }),
    getRenaissanceAvoid: () => Promise.resolve({ items: [] }),
    getRenaissanceScreening: () => Promise.resolve({ items: [] }),
  },
}));
vi.mock("@/components/ria/ria-page-shell", () => ({
  RiaPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  RiaVerificationGate: () => <div data-testid="ria-verify-gate" />,
  RiaCompatibilityState: () => null,
}));

import RiaPicksPage from "@/app/ria/picks/page";

function renderForAdvisor(advisoryStatus: string) {
  mocks.usePersonaState.mockReturnValue({
    riaCapability: "switch",
    riaOnboardingStatus: { advisory_status: advisoryStatus },
    loading: false,
    refreshing: false,
  });
  render(<RiaPicksPage />);
}

describe("RiaPicksPage verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useStaleResource.mockReturnValue({
      data: null,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it("keeps the editor behind the gate, does not ask for picks and tells One why, for an advisor who is not verified", () => {
    renderForAdvisor("submitted");

    expect(screen.getByTestId("ria-verify-gate")).toBeTruthy();
    expect(screen.queryByTestId("ria-picks-primary")).toBeNull();
    expect(mocks.useStaleResource).toHaveBeenCalledWith(
      expect.objectContaining({ cacheKey: "ria_picks_ria-user-1", enabled: false }),
    );
    expect(mocks.publishVoiceSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deadEnd: expect.objectContaining({ remedyActionId: "route.ria_onboarding" }),
      }),
    );
  });

  it("asks for picks and reports no dead end for a verified advisor", () => {
    renderForAdvisor("finra_verified");

    expect(mocks.useStaleResource).toHaveBeenCalledWith(
      expect.objectContaining({ cacheKey: "ria_picks_ria-user-1", enabled: true }),
    );
    expect(mocks.publishVoiceSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({ deadEnd: null }),
    );
  });
});
