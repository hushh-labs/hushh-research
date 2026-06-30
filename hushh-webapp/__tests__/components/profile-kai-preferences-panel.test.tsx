import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProfileKaiPreferencesPanel } from "@/components/profile/profile-kai-preferences-panel";
import { KaiProfileService } from "@/lib/services/kai-profile-service";
import type { KaiProfileV2 } from "@/lib/services/kai-profile-service";

vi.mock("@/lib/morphy-ux/hooks/use-fade-in-on-ready", () => ({
  useFadeInOnReady: vi.fn(),
}));

vi.mock("@/lib/services/kai-profile-service", () => ({
  KaiProfileService: {
    getProfile: vi.fn(),
    savePreferences: vi.fn(),
  },
}));

const profile: KaiProfileV2 = {
  schema_version: 2,
  onboarding: {
    completed: true,
    completed_at: "2026-01-01T00:00:00.000Z",
    skipped_preferences: false,
    nav_tour_completed_at: null,
    nav_tour_skipped_at: null,
    version: 2,
  },
  preferences: {
    investment_horizon: "medium_term",
    investment_horizon_selected_at: "2026-01-01T00:00:00.000Z",
    investment_horizon_anchor_at: "2026-01-01T00:00:00.000Z",
    drawdown_response: "stay",
    drawdown_response_selected_at: "2026-01-01T00:00:00.000Z",
    volatility_preference: "moderate",
    volatility_preference_selected_at: "2026-01-01T00:00:00.000Z",
    risk_score: 3,
    risk_profile: "balanced",
    risk_profile_selected_at: "2026-01-01T00:00:00.000Z",
  },
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("ProfileKaiPreferencesPanel", () => {
  it("renders save button with button type", async () => {
    vi.mocked(KaiProfileService.getProfile).mockResolvedValue(profile);

    render(
      <ProfileKaiPreferencesPanel
        userId="user-1"
        vaultKey="vault-key"
        vaultOwnerToken="owner-token"
        canEdit
        onRequestUnlock={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    expect(
      screen.getByRole("button", { name: /save changes/i }).getAttribute("type")
    ).toBe("button");
  });
});
