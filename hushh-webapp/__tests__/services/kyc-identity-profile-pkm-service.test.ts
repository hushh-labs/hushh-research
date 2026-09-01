import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: vi.fn() },
}));
const ingestionMocks = vi.hoisted(() => ({ ingestNaturalLanguagePkm: vi.fn() }));
vi.mock("@/lib/pkm/pkm-natural-language-ingestion", () => ({
  ingestNaturalLanguagePkm: ingestionMocks.ingestNaturalLanguagePkm,
}));

import {
  KycIdentityProfilePkmService,
  isKycIdentityPrefaceComplete,
  isValidDateOfBirth,
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

describe("KycIdentityProfilePkmService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recognizes a segmented import completion marker and legacy profile", () => {
    expect(isKycIdentityPrefaceComplete({ freeform_import_completed_at: "2026-08-20T00:00:00Z" })).toBe(true);
    expect(isKycIdentityPrefaceComplete({ about_me: "legacy profile" })).toBe(true);
    expect(isKycIdentityPrefaceComplete({ about_me: "" })).toBe(false);
  });

  it("accepts only real past dates", () => {
    expect(isValidDateOfBirth("2000-02-29", new Date("2026-08-03"))).toBe(true);
    expect(isValidDateOfBirth("2099-01-01", new Date("2026-08-03"))).toBe(false);
  });

  it("segments free-form KYC text through the canonical ingestion path", async () => {
    (PkmWriteCoordinator.saveMergedDomain as Mock).mockResolvedValue({ success: true, saveState: "saved", fullBlob: {} });
    ingestionMocks.ingestNaturalLanguagePkm.mockResolvedValue({
      preview: { cards: [] },
      save: { attempted: 3, saved: 3, failed: 0, domains: ["education"], results: [] },
    });

    await expect(KycIdentityProfilePkmService.saveProfile({
      userId: "user_1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      profile: { aboutMe: "I study Mechanical Engineering at IIT Bombay and play Rocket League." },
    })).resolves.toMatchObject({ success: true, message: "Saved 3 separate memory details." });

    expect(ingestionMocks.ingestNaturalLanguagePkm).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1", currentDomains: ["identity"], source: "kyc_identity_onboarding", writePolicy: "auto_save_only",
    }));
    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1);
  });

  it("reports a partial import as saved with an explicit retry message", async () => {
    (PkmWriteCoordinator.saveMergedDomain as Mock).mockResolvedValue({ success: true, saveState: "saved", fullBlob: {} });
    ingestionMocks.ingestNaturalLanguagePkm.mockResolvedValue({
      preview: { cards: [] },
      save: { attempted: 2, saved: 1, failed: 1, domains: ["education"], results: [] },
    });

    await expect(KycIdentityProfilePkmService.saveProfile({
      userId: "user_1", vaultKey: "vault-key", vaultOwnerToken: "owner-token",
      profile: { aboutMe: "I study at IIT Bombay and prefer gaming laptops." },
    })).resolves.toMatchObject({
      success: true,
      message: "Saved 1 separate memory detail. 1 detail was skipped and can be retried later.",
    });
  });

  it("completes KYC without writing junk when no cards qualify for auto-save", async () => {
    (PkmWriteCoordinator.saveMergedDomain as Mock).mockResolvedValue({ success: true, saveState: "saved", fullBlob: {} });
    ingestionMocks.ingestNaturalLanguagePkm.mockResolvedValue({
      preview: { cards: [] },
      save: { attempted: 0, saved: 0, failed: 0, domains: [], results: [] },
    });

    await expect(KycIdentityProfilePkmService.saveProfile({
      userId: "user_1", vaultKey: "vault-key", vaultOwnerToken: "owner-token",
      profile: { aboutMe: "Thanks for helping with this form." },
    })).resolves.toMatchObject({
      success: true,
      message: "No durable personal details were found to save.",
    });
    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1);
  });
});
