"use client";

import type { PkmWriteCoordinatorResult } from "@/lib/services/pkm-write-coordinator";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

export const KYC_IDENTITY_PKM_DOMAIN = "identity" as const;

export type KycIdentityProfile = {
  legalName: string;
  dateOfBirth: string;
  countryCode: string;
  countryName: string;
};

type KycIdentityProfilePkmWriteParams = {
  userId: string;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  profile: KycIdentityProfile;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Persists user-entered identity onboarding fields in the encrypted identity domain. */
export class KycIdentityProfilePkmService {
  static saveProfile(
    params: KycIdentityProfilePkmWriteParams,
  ): Promise<PkmWriteCoordinatorResult> {
    const savedAt = new Date().toISOString();

    return PkmWriteCoordinator.saveMergedDomain({
      userId: params.userId,
      domain: KYC_IDENTITY_PKM_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "kyc_identity_onboarding",
      },
      build: (context) => ({
        domainData: {
          ...(context.currentDomainData ?? {}),
          identity_profile: {
            ...asRecord(context.currentDomainData?.identity_profile),
            full_name: params.profile.legalName,
            legal_name: params.profile.legalName,
            date_of_birth: params.profile.dateOfBirth,
            country_code: params.profile.countryCode,
            country_of_residence: params.profile.countryName,
            updated_at: savedAt,
            schema_version: 1,
          },
        },
        // Keep sensitive identity values out of the readable PKM projection.
        summary: {
          identity_profile_updated: true,
        },
      }),
    });
  }
}
