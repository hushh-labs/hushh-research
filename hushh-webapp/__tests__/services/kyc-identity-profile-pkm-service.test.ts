import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: vi.fn(),
  },
}));

const ingestionMocks = vi.hoisted(() => ({
  ingestNaturalLanguagePkm: vi.fn(),
}));

vi.mock("@/lib/pkm/pkm-natural-language-ingestion", () => ({
  ingestNaturalLanguagePkm: ingestionMocks.ingestNaturalLanguagePkm,
}));

import {
  KYC_IDENTITY_PKM_DOMAIN,
  KycIdentityProfileDraftService,
  KycIdentityProfilePkmService,
  isKycIdentityPrefaceComplete,
  isValidDateOfBirth,
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("KycIdentityProfilePkmService", () => {
  it("accepts only real past calendar dates of birth", () => {
    const now = new Date("2026-08-03T12:00:00");

    expect(isValidDateOfBirth("1994-04-15", now)).toBe(true);
    expect(isValidDateOfBirth("2000-02-29", now)).toBe(true);
    expect(isValidDateOfBirth("1994-02-29", now)).toBe(false);
    expect(isValidDateOfBirth("2026-08-03", now)).toBe(false);
    expect(isValidDateOfBirth("2099-01-01", now)).toBe(false);
  });

  it("recognizes segmented free-form imports without retaining the raw blob", () => {
    expect(isKycIdentityPrefaceComplete({ about_me: "legacy profile" })).toBe(true);
    expect(isKycIdentityPrefaceComplete({ freeform_import_completed_at: "2026-08-20T00:00:00Z" })).toBe(true);
    expect(isKycIdentityPrefaceComplete({ about_me: "", updated_at: "2026-08-20T00:00:00Z" })).toBe(false);
  });

  it("merges the completed identity preface into the encrypted identity domain", async () => {
    let writtenDomainData: Record<string, unknown> | null = null;
    let writtenSummary: Record<string, unknown> | null = null;

    (PkmWriteCoordinator.saveMergedDomain as Mock).mockImplementationOnce(async (params) => {
      const plan = await params.build({
        currentDomainData: {
          existing_identity_fact: "preserved",
          identity_profile: {
            existing_field: "preserved",
          },
        },
      });
      writtenDomainData = plan.domainData;
      writtenSummary = plan.summary;
      return {
        saveState: "saved",
        success: true,
        fullBlob: {},
      };
    });

    await KycIdentityProfilePkmService.saveProfile({
      userId: "user_1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      profile: {
        legalName: "Avery Example",
        dateOfBirth: "1994-04-15",
        citizenshipCountryCode: "IN",
        citizenshipCountryName: "India",
        employmentStatus: "employed",
      },
    });

    expect(KYC_IDENTITY_PKM_DOMAIN).toBe("identity");
    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        domain: "identity",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
        confirmation: expect.objectContaining({
          confirmedByUser: true,
          source: "kyc_identity_onboarding",
        }),
      }),
    );
    expect(writtenDomainData).toMatchObject({
      existing_identity_fact: "preserved",
      identity_profile: {
        existing_field: "preserved",
        full_name: "Avery Example",
        legal_name: "Avery Example",
        date_of_birth: "1994-04-15",
        citizenship_country_code: "IN",
        country_of_citizenship: "India",
        employment_status: "employed",
        schema_version: 2,
      },
    });
    expect(writtenSummary).toEqual({ identity_profile_updated: true });
  });

  it("decomposes an imported KYC profile through the canonical PKM proposal path", async () => {
    let writtenDomainData: Record<string, unknown> | null = null;
    (PkmWriteCoordinator.saveMergedDomain as Mock).mockImplementationOnce(async (params) => {
      const plan = await params.build({
        currentDomainData: {
          identity_profile: {
            full_name: "Existing Person",
            employment_status: "employed",
          },
        },
      });
      writtenDomainData = plan.domainData;
      return { saveState: "saved", success: true, fullBlob: {} };
    });
    ingestionMocks.ingestNaturalLanguagePkm.mockResolvedValueOnce({
      preview: { cards: [] },
      save: { attempted: 3, saved: 3, failed: 0, domains: ["education", "interests"], results: [] },
    });

    const result = await KycIdentityProfilePkmService.saveProfile({
      userId: "user_1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      profile: {
        aboutMe: "I study Mechanical Engineering at IIT Bombay, work at Hushh, and play Rocket League.",
      },
    });

    expect(ingestionMocks.ingestNaturalLanguagePkm).toHaveBeenCalledWith({
      userId: "user_1",
      message: "I study Mechanical Engineering at IIT Bombay, work at Hushh, and play Rocket League.",
      currentDomains: ["identity"],
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      source: "kyc_identity_onboarding",
      confirmation: expect.objectContaining({
        confirmedByUser: true,
        source: "kyc_identity_onboarding",
      }),
    });
    expect(writtenDomainData).toMatchObject({
      identity_profile: {
        full_name: "Existing Person",
        employment_status: "employed",
        freeform_import_completed_at: expect.any(String),
      },
    });
    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, message: "Saved 3 separate memory details." });
  });

  it("reports saved memories accurately when a later imported detail is skipped", async () => {
    ingestionMocks.ingestNaturalLanguagePkm.mockResolvedValueOnce({
      preview: { cards: [] },
      save: { attempted: 2, saved: 1, failed: 1, domains: ["education"], results: [] },
    });
    (PkmWriteCoordinator.saveMergedDomain as Mock).mockResolvedValueOnce({
      saveState: "saved",
      success: true,
      fullBlob: {},
    });

    const result = await KycIdentityProfilePkmService.saveProfile({
      userId: "user_1",
      vaultKey: "vault-key",
      vaultOwnerToken: "owner-token",
      profile: { aboutMe: "I study at IIT Bombay and prefer gaming laptops." },
    });

    expect(result).toMatchObject({
      success: true,
      saveState: "saved",
      message: "Saved 1 separate memory detail. 1 detail was skipped and can be retried later.",
    });
    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1);
  });

  it("keeps a pre-vault identity draft only in process memory until its encrypted save settles", async () => {
    KycIdentityProfileDraftService.stage("user_draft", {
      legalName: "Avery Example",
      dateOfBirth: "1994-04-15",
      citizenshipCountryCode: "IN",
      citizenshipCountryName: "India",
      employmentStatus: "employed",
    });

    (PkmWriteCoordinator.saveMergedDomain as Mock).mockResolvedValueOnce({
      saveState: "saved",
      success: true,
      fullBlob: {},
    });

    await expect(
      KycIdentityProfileDraftService.flushToVault({
        userId: "user_draft",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    ).resolves.toBe(true);
    expect(KycIdentityProfileDraftService.hasPending("user_draft")).toBe(false);
  });

  it("rejects an invalid date before writing the encrypted identity profile", async () => {
    const callsBefore = (PkmWriteCoordinator.saveMergedDomain as Mock).mock.calls.length;

    await expect(
      KycIdentityProfilePkmService.saveProfile({
        userId: "user_1",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
        profile: {
          legalName: "Avery Example",
          dateOfBirth: "2099-01-01",
          citizenshipCountryCode: "IN",
          citizenshipCountryName: "India",
          employmentStatus: "employed",
        },
      }),
    ).rejects.toThrow("Date of birth must be a real past date.");

    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(callsBefore);
  });

  it("does not retain an invalid pre-vault identity draft", () => {
    KycIdentityProfileDraftService.stage("user_invalid", {
      legalName: "Avery Example",
      dateOfBirth: "2099-01-01",
      citizenshipCountryCode: "IN",
      citizenshipCountryName: "India",
      employmentStatus: "employed",
    });

    expect(KycIdentityProfileDraftService.hasPending("user_invalid")).toBe(false);
  });

  it("retains an in-memory draft when its encrypted save fails", async () => {
    KycIdentityProfileDraftService.stage("user_retry", {
      legalName: "Avery Example",
      dateOfBirth: "1994-04-15",
      citizenshipCountryCode: "IN",
      citizenshipCountryName: "India",
      employmentStatus: "employed",
    });
    (PkmWriteCoordinator.saveMergedDomain as Mock).mockResolvedValueOnce({
      saveState: "failed",
      success: false,
      message: "retry",
    });

    await expect(
      KycIdentityProfileDraftService.flushToVault({
        userId: "user_retry",
        vaultKey: "vault-key",
        vaultOwnerToken: "owner-token",
      }),
    ).rejects.toThrow("retry");
    expect(KycIdentityProfileDraftService.hasPending("user_retry")).toBe(true);
    KycIdentityProfileDraftService.clear("user_retry");
  });
});
