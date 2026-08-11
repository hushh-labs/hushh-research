"use client";

import type { PkmWriteCoordinatorResult } from "@/lib/services/pkm-write-coordinator";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

export const KYC_IDENTITY_PKM_DOMAIN = "identity" as const;

export type KycIdentityProfile = {
  legalName?: string;
  dateOfBirth?: string;
  citizenshipCountryCode?: string;
  citizenshipCountryName?: string;
  employmentStatus?: KycEmploymentStatus;
  aboutMe?: string;
};

export type KycEmploymentStatus =
  | "employed"
  | "self_employed"
  | "student"
  | "retired"
  | "not_currently_employed";

export function isValidDateOfBirth(value: string, now = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const candidate = new Date(Date.UTC(year, month - 1, day));
  const isCalendarDate =
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day;
  if (!isCalendarDate) return false;

  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return value < today;
}

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
    if (params.profile.dateOfBirth && !isValidDateOfBirth(params.profile.dateOfBirth)) {
      return Promise.reject(new Error("Date of birth must be a real past date."));
    }

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
            full_name: params.profile.legalName ?? "",
            legal_name: params.profile.legalName ?? "",
            date_of_birth: params.profile.dateOfBirth ?? "",
            citizenship_country_code: params.profile.citizenshipCountryCode ?? "",
            country_of_citizenship: params.profile.citizenshipCountryName ?? "",
            employment_status: params.profile.employmentStatus ?? "not_currently_employed",
            about_me: params.profile.aboutMe ?? "",
            updated_at: savedAt,
            schema_version: 2,
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

/**
 * Holds a completed KYC preface only in this JavaScript process until the
 * person chooses the master setup action and unlocks their vault. It never
 * writes sensitive identity information to browser or server pre-vault state.
 * A refresh before vault setup deliberately asks for the details again.
 */
const pendingProfiles = new Map<string, KycIdentityProfile>();

export class KycIdentityProfileDraftService {
  static stage(userId: string, profile: KycIdentityProfile): void {
    if (profile.dateOfBirth && !isValidDateOfBirth(profile.dateOfBirth)) return;
    pendingProfiles.set(userId, profile);
  }

  static clear(userId: string): void {
    pendingProfiles.delete(userId);
  }

  static hasPending(userId: string): boolean {
    return pendingProfiles.has(userId);
  }

  static async flushToVault(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<boolean> {
    const profile = pendingProfiles.get(params.userId);
    if (!profile) return false;

    const result = await KycIdentityProfilePkmService.saveProfile({
      ...params,
      profile,
    });
    if (!result.success) {
      throw new Error(result.message || "KYC details could not be saved.");
    }
    pendingProfiles.delete(params.userId);
    return true;
  }
}
