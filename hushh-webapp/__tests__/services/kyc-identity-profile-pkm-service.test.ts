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
} from "@/lib/services/kyc-identity-profile-pkm-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

describe("KycIdentityProfilePkmService", () => {
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
        countryCode: "IN",
        countryName: "India",
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
        country_code: "IN",
        country_of_residence: "India",
        schema_version: 1,
      },
    });
    expect(writtenSummary).toEqual({ identity_profile_updated: true });
  });
});
