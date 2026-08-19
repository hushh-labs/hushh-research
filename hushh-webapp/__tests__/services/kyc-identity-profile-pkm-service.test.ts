import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: vi.fn(),
  },
}));

import {
  KYC_IDENTITY_PKM_DOMAIN,
  KycIdentityProfilePkmService,
  hasCompletedKycIdentityIntake,
  isValidDateOfBirth,
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

describe("KycIdentityProfilePkmService", () => {
  it("accepts only real past calendar dates of birth", () => {
    const now = new Date("2026-08-03T12:00:00");

    expect(isValidDateOfBirth("1994-04-15", now)).toBe(true);
    expect(isValidDateOfBirth("2000-02-29", now)).toBe(true);
    expect(isValidDateOfBirth("1994-02-29", now)).toBe(false);
    expect(isValidDateOfBirth("2026-08-03", now)).toBe(false);
    expect(isValidDateOfBirth("2099-01-01", now)).toBe(false);
  });

  it("merges the completed identity preface into the encrypted identity domain", async () => {
    let writtenDomainData: Record<string, unknown> | null = null;
    let writtenSummary: Record<string, unknown> | null = null;

    (PkmWriteCoordinator.saveMergedDomain as Mock).mockImplementationOnce(
      async (params) => {
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
      },
    );

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
        identity_intake_status: "completed",
        identity_intake_completed_at: expect.any(String),
        schema_version: 3,
      },
    });
    expect(writtenDomainData?.identity_profile).not.toHaveProperty("about_me");
    expect(writtenSummary).toEqual({ identity_profile_updated: true });
  });

  it("recognizes current and legacy completed KYC profiles", () => {
    expect(
      hasCompletedKycIdentityIntake({ identity_intake_status: "completed" }),
    ).toBe(true);
    expect(
      hasCompletedKycIdentityIntake({
        identity_intake_completed_at: "2026-08-15T00:00:00Z",
      }),
    ).toBe(true);
    expect(hasCompletedKycIdentityIntake({ about_me: "Legacy profile" })).toBe(
      true,
    );
    expect(
      hasCompletedKycIdentityIntake({ identity_intake_status: "pending" }),
    ).toBe(false);
  });

  it("rejects an invalid date before writing the encrypted identity profile", async () => {
    const callsBefore = (PkmWriteCoordinator.saveMergedDomain as Mock).mock
      .calls.length;

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

    expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(
      callsBefore,
    );
  });
});
