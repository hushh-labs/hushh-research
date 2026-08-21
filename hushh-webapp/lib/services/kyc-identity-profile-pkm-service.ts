"use client";

import type { PkmWriteCoordinatorResult } from "@/lib/services/pkm-write-coordinator";
import { ingestNaturalLanguagePkm } from "@/lib/pkm/pkm-natural-language-ingestion";
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

function suppliedIdentityFields(profile: KycIdentityProfile): Record<string, unknown> {
  return {
    ...(profile.legalName
      ? { full_name: profile.legalName, legal_name: profile.legalName }
      : {}),
    ...(profile.dateOfBirth ? { date_of_birth: profile.dateOfBirth } : {}),
    ...(profile.citizenshipCountryCode
      ? { citizenship_country_code: profile.citizenshipCountryCode }
      : {}),
    ...(profile.citizenshipCountryName
      ? { country_of_citizenship: profile.citizenshipCountryName }
      : {}),
    ...(profile.employmentStatus ? { employment_status: profile.employmentStatus } : {}),
  };
}

export function isKycIdentityPrefaceComplete(value: unknown): boolean {
  const profile = asRecord(value);
  return Boolean(
    (typeof profile.about_me === "string" && profile.about_me.trim()) ||
      (typeof profile.freeform_import_completed_at === "string" &&
        profile.freeform_import_completed_at.trim())
  );
}

/** Persists user-entered identity onboarding fields in the encrypted identity domain. */
export class KycIdentityProfilePkmService {
  static async saveProfile(
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

    const savedAt = new Date().toISOString();

    const importedMemory = params.profile.aboutMe?.trim() || "";
    const identityFields = suppliedIdentityFields(params.profile);
    const profileResult = Object.keys(identityFields).length > 0
      ? await PkmWriteCoordinator.saveMergedDomain({
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
            // The KYC preface currently supplies only free-form text. Never
            // replace previously verified identity attributes with defaults.
            ...identityFields,
            // Free-form imports are saved through the canonical PKM
            // segmentation pipeline below. Preserve a legacy value until an
            // explicit PKM upgrade handles it, but never add new raw blobs to
            // this profile field.
            about_me: typeof asRecord(context.currentDomainData?.identity_profile).about_me === "string"
              ? asRecord(context.currentDomainData?.identity_profile).about_me
              : "",
            updated_at: savedAt,
            schema_version: 2,
          },
        },
        // Keep sensitive identity values out of the readable PKM projection.
        summary: {
          identity_profile_updated: true,
        },
      }),
    })
      : null;
    if (
      (profileResult && !profileResult.success) ||
      !importedMemory ||
      !params.vaultKey ||
      !params.vaultOwnerToken
    ) {
      return profileResult ?? {
        saveState: "failed",
        success: false,
        message: "Identity details need an unlocked vault before they can be saved.",
        fullBlob: {},
      };
    }

    const ingestion = await ingestNaturalLanguagePkm({
      userId: params.userId,
      message: importedMemory,
      currentDomains: [KYC_IDENTITY_PKM_DOMAIN],
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      source: "kyc_identity_onboarding",
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "kyc_identity_onboarding",
      },
    });
    if (ingestion.save.saved === 0) {
      return {
        ...(profileResult ?? { fullBlob: {} }),
        success: false,
        saveState: "failed",
        message: "We couldn't save the imported details as separate memories. Try again.",
      };
    }

    const completionResult = await PkmWriteCoordinator.saveMergedDomain({
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
            freeform_import_completed_at: savedAt,
            updated_at: savedAt,
            schema_version: 2,
          },
        },
        summary: {
          identity_profile_updated: true,
        },
      }),
    });
    if (!completionResult.success) {
      return {
        ...completionResult,
        // Individual PKM memories are already durable. Do not claim that the
        // import failed just because the non-sensitive onboarding marker could
        // not be updated after a long-running import.
        success: true,
        saveState: "saved",
        message:
          `Saved ${ingestion.save.saved} separate memory ${ingestion.save.saved === 1 ? "detail" : "details"}. ` +
          "Your setup status will finish syncing shortly.",
      };
    }

    const skippedMessage = ingestion.save.failed > 0
      ? ` ${ingestion.save.failed} ${ingestion.save.failed === 1 ? "detail was" : "details were"} skipped and can be retried later.`
      : "";
    return {
      ...completionResult,
      message:
        `Saved ${ingestion.save.saved} separate memory ${ingestion.save.saved === 1 ? "detail" : "details"}.` +
        skippedMessage,
    };
  }
}

export function hasCompletedKycIdentityIntake(profile: unknown): boolean {
  const identityProfile = asRecord(profile);
  return (
    identityProfile.identity_intake_status === "completed" ||
    typeof identityProfile.identity_intake_completed_at === "string" ||
    isKycIdentityPrefaceComplete(identityProfile)
  );
}

/**
 * Compatibility-only in-process storage for drafts created before the KYC
 * vault prerequisite. New KYC input must open vault setup instead of staging
 * here; this remains until every legacy caller has drained its pending draft.
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
