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
    if (
      params.profile.dateOfBirth &&
      !isValidDateOfBirth(params.profile.dateOfBirth)
    ) {
      return Promise.reject(
        new Error("Date of birth must be a real past date."),
      );
    }

    const completedAt = new Date().toISOString();

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
            citizenship_country_code:
              params.profile.citizenshipCountryCode ?? "",
            country_of_citizenship: params.profile.citizenshipCountryName ?? "",
            employment_status:
              params.profile.employmentStatus ?? "not_currently_employed",
            // Free-form onboarding input is organized into typed PKM facts by
            // the background intake service. It must not become a monolithic
            // identity_profile.about_me value.
            // Completing KYC and extracting additional facts are separate
            // operations. The extraction runs in the background and must not
            // make a completed KYC flow appear again if it needs a retry.
            about_me: undefined,
            // Setting to null ensures it is removed from typed extraction but
            // prevents any partial payload drops if strict JSON is expected.
            about_me: null,
            identity_intake_status: "completed",
            identity_intake_completed_at: completedAt,
            updated_at: completedAt,
            schema_version: 3,
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

export function hasCompletedKycIdentityIntake(profile: unknown): boolean {
  const identityProfile = asRecord(profile);
  return (
    identityProfile.identity_intake_status === "completed" ||
    typeof identityProfile.identity_intake_completed_at === "string" ||
    (typeof identityProfile.about_me === "string" &&
      identityProfile.about_me.trim().length > 0)
  );
}
