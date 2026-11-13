import { expect, it, vi } from "vitest";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  KaiProfileService,
  selectProfileFromFinancialDomain,
} from "@/lib/services/kai-profile-service";

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: vi.fn() },
}));

it("preserves loss capacity and other financial data when an older editor saves one answer", async () => {
  const base = {
    financial: {
      profile: {
        schema_version: 3,
        preferences: {
          loss_capacity: "essentials",
          advisor_service: "tax_planning",
        },
      },
      portfolio: { source: "statement" },
    },
  };
  vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockImplementation(
    async ({ build }) => {
      const result = await build({ baseFullBlob: base } as Parameters<
        typeof build
      >[0]);
      expect(result?.domainData.portfolio).toEqual(base.financial.portfolio);
      expect(result?.summary).not.toHaveProperty("loss_capacity");
      expect(result?.summary).not.toHaveProperty("advisor_service");
      expect(
        selectProfileFromFinancialDomain(result?.domainData).preferences,
      ).toMatchObject({
        loss_capacity: "essentials",
        drawdown_response: "stay",
        advisor_service: "tax_planning",
      });
      return { success: true };
    },
  );

  const profile = await KaiProfileService.savePreferences({
    userId: "synthetic-owner",
    vaultKey: "synthetic",
    mode: "edit",
    updates: { drawdown_response: "stay" },
  });
  expect(profile.preferences.loss_capacity).toBe("essentials");
});

it("saves only a bounded advisor service while preserving the latest portfolio and assessment", async () => {
  const base = {
    financial: {
      profile: {
        schema_version: 3,
        setup: { completed: true, skipped_preferences: true },
        preferences: {
          investment_horizon: "long_term",
          loss_capacity: "flexible",
          risk_score: 4,
          risk_profile: "balanced",
        },
      },
      portfolio: { retained: true },
    },
  };
  vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockImplementation(
    async ({ build }) => {
      const result = await build({ baseFullBlob: base } as Parameters<
        typeof build
      >[0]);
      expect(result?.domainData.portfolio).toEqual({ retained: true });
      expect(result?.summary).not.toHaveProperty("advisor_service");
      return { success: true };
    },
  );
  const saved = await KaiProfileService.savePreferences({
    userId: "synthetic-owner",
    vaultKey: "synthetic",
    mode: "edit",
    updates: { advisor_service: "estate_planning" },
  });
  expect(saved.preferences).toMatchObject({
    advisor_service: "estate_planning",
    investment_horizon: "long_term",
    loss_capacity: "flexible",
    risk_score: 4,
    risk_profile: "balanced",
  });
  expect(saved.setup.skipped_preferences).toBe(true);
  const unknown = selectProfileFromFinancialDomain({
    profile: {
      schema_version: 3,
      preferences: { advisor_service: "I'm not sure yet" },
    },
  });
  expect(unknown.preferences.advisor_service).toBeNull();
});
