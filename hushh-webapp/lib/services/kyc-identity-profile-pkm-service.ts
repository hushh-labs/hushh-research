"use client";

import type { PkmWriteCoordinatorResult } from "@/lib/services/pkm-write-coordinator";
import { isUnresolvedSourceBlock, prepareNaturalLanguagePkm } from "@/lib/pkm/pkm-natural-language-ingestion";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import { loadMarkdownMemory, MARKDOWN_MEMORY_DOMAIN, markdownFactsFromCards, peekMarkdownMemory, recoverMarkdownMemorySync, stageMarkdownMemoryFacts } from "@/lib/pkm/markdown-memory";
import { isNonPersistableCredentialKind, planSecretCaptures } from "@/lib/pkm/secret-span-guard";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";

export const KYC_IDENTITY_PKM_DOMAIN = "identity" as const;

export type KycIdentityProfile = {
  legalName?: string;
  dateOfBirth?: string;
  /**
   * Sex, only as the person typed or chose it.
   *
   * Optional on purpose, and never derived: not from a name, not from a
   * pronoun, not from a photo, and never substituted by gender, which is a
   * different thing about a person. Absent means absent, and a question about
   * it is answered "not recorded" rather than guessed.
   */
  sex?: string;
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

function suppliedIdentityFacts(profile: KycIdentityProfile): string[] {
  return [
    profile.legalName ? `Legal name: ${profile.legalName}` : "",
    profile.dateOfBirth ? `Date of birth: ${profile.dateOfBirth}` : "",
    profile.sex?.trim() ? `Sex: ${profile.sex.trim()}` : "",
    profile.citizenshipCountryName || profile.citizenshipCountryCode
      ? `Citizenship: ${[profile.citizenshipCountryName, profile.citizenshipCountryCode].filter(Boolean).join(" / ")}` : "",
    profile.employmentStatus ? `Employment status: ${profile.employmentStatus.replaceAll("_", " ")}` : "",
  ].filter(Boolean);
}

export function isKycIdentityPrefaceComplete(value: unknown): boolean {
  const profile = asRecord(value);
  return Boolean(
    (typeof profile.about_me === "string" && profile.about_me.trim()) ||
      (typeof profile.freeform_import_completed_at === "string" &&
        profile.freeform_import_completed_at.trim())
  );
}

/** KYC personal information uses the same plain Soul.md as ordinary chat. */
export class KycIdentityProfilePkmService {
  static async hasCompletedIntake(params: {
    userId: string; vaultKey: string; vaultOwnerToken: string;
  }): Promise<boolean> {
    const guard = createAgentPkmCaptureGuard({
      userId: params.userId, signal: new AbortController().signal, isEnabled: () => true,
    });
    await guard.assertCurrent();
    const memory = await loadMarkdownMemory(params);
    await guard.assertCurrent();
    if (!memory) throw new Error("Private memory unavailable.");
    await recoverMarkdownMemorySync(params);
    await guard.assertCurrent();
    const current = peekMarkdownMemory(params.userId) ?? memory;
    if (current.kycIntakeCompletedAt) return true;
    if (current.syncStatus === "saving" || current.syncStatus === "retryable")
      throw new Error("Private memory is still syncing.");
    // Read only the old completion signal for existing accounts. No personal
    // values are copied into Soul and no legacy domain is written.
    const legacy = await PkmDomainResourceService.getStaleFirst({
      ...params, domain: KYC_IDENTITY_PKM_DOMAIN, backgroundRefresh: false,
    });
    await guard.assertCurrent();
    return hasCompletedKycIdentityIntake(legacy?.data?.identity_profile);
  }

  static async saveProfile(params: KycIdentityProfilePkmWriteParams): Promise<PkmWriteCoordinatorResult> {
    if (params.profile.dateOfBirth && !isValidDateOfBirth(params.profile.dateOfBirth))
      throw new Error("Date of birth must be a real past date.");
    if (!params.vaultKey || !params.vaultOwnerToken) return {
      success: false, saveState: "failed", fullBlob: {},
      message: "Identity details need an unlocked vault before they can be saved.",
    };
    const session = { userId: params.userId, vaultKey: params.vaultKey, vaultOwnerToken: params.vaultOwnerToken };
    const guard = createAgentPkmCaptureGuard({
      userId: params.userId, signal: new AbortController().signal, isEnabled: () => true,
    });
    await guard.assertCurrent();
    const memory = await loadMarkdownMemory(session);
    await guard.assertCurrent();
    if (!memory) throw new Error("Private memory unavailable.");

    const aboutMe = params.profile.aboutMe?.trim() || "";
    const protectedInput = planSecretCaptures([aboutMe]);
    const identifierFacts = protectedInput.captures
      .filter(capture => !isNonPersistableCredentialKind(capture.kind))
      .map(capture => `${capture.label}: ${capture.value}`);
    const prepared = aboutMe ? await prepareNaturalLanguagePkm({
      userId: params.userId,
      message: protectedInput.render(capture => ({
        id: capture.id,
        label: isNonPersistableCredentialKind(capture.kind) ? "Credential omitted" : capture.label,
      }))[0]!,
      currentDomains: [MARKDOWN_MEMORY_DOMAIN],
      currentManifests: [],
      vaultOwnerToken: params.vaultOwnerToken,
      source: "kyc_identity_onboarding",
      allowEmpty: true,
      beforeEffect: guard.assertCurrent,
      isEffectCurrent: guard.isCurrent,
    }) : null;
    await guard.assertCurrent();
    if (prepared && ((prepared.sourceCoverage ?? []).some(isUnresolvedSourceBlock) ||
      (prepared.previews ?? []).some(preview => preview.used_fallback || preview.error) ||
      prepared.cards.some(card => card.preparation_requires_review))) return {
      success: false, saveState: "failed", fullBlob: {},
      message: "The full summary couldn't be processed. Nothing new was added; retry the import.",
    };
    const facts = [
      ...suppliedIdentityFacts(params.profile),
      ...identifierFacts,
      ...markdownFactsFromCards(prepared?.cards ?? []),
    ];
    if (!facts.length) return {
      success: false, saveState: "failed", fullBlob: {},
      message: "No private details could be recognized. Edit the summary and try again.",
    };
    const result = await stageMarkdownMemoryFacts({
      ...session, facts, completeKycIntake: true, beforeEffect: guard.assertCurrent,
      confirmation: { confirmedByUser: true, surface: "web", source: "kyc_identity_onboarding" },
    });
    return {
      success: result.success, saveState: result.success ? "saved" : "failed", fullBlob: {},
      message: result.success ? "Your details are available in memory.md and syncing privately."
        : result.message || "Your details could not be added to memory.md.",
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
