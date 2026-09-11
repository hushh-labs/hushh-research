"use client";

import {
  OnboardingBufferService,
  type BufferedOnboardingRecord,
} from "@/lib/services/secure-resource-cache-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

/**
 * Buffer -> PKM migration (dev-only, Workstream D3).
 *
 * What the person told us during onboarding lives encrypted in the browser
 * until their pod is ready. This drains that buffer into PKM through the
 * EXISTING write path (`PkmWriteCoordinator`), never a parallel one.
 *
 * Two properties make a retry safe:
 *
 *  1. Every record carries a stable, client-generated `recordId`, and the write
 *     records it in a set on the domain. Replaying the same record is a no-op
 *     overwrite, not a second entry.
 *  2. A local record is deleted only after the server acknowledges THAT id. A
 *     failure part-way through leaves the unacknowledged remainder on disk, and
 *     the next pass picks up exactly where this one stopped.
 */

/** Where the domain records which buffered ids it has already absorbed. */
export const ONBOARDING_CAPTURE_IDS_KEY = "onboarding_capture_ids";

export type OnboardingMigrationOutcome =
  /** The buffer was already empty — nothing to move. */
  | "nothing_to_migrate"
  /** Every buffered record was acknowledged and cleared. */
  | "migrated"
  /** Records remain and the vault key is required to write them. */
  | "pending_vault"
  /** Some records landed, some did not. Running again is safe. */
  | "partial";

export type OnboardingMigrationResult = {
  outcome: OnboardingMigrationOutcome;
  /** Record ids the server confirmed and the browser then cleared. */
  acknowledgedIds: string[];
  /** Record ids still buffered locally. */
  remainingIds: string[];
  message?: string;
};

function captureIds(domainData: Record<string, unknown> | null | undefined): string[] {
  const raw = domainData?.[ONBOARDING_CAPTURE_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && !!entry);
}

/**
 * Fold one buffered record into a domain blob.
 *
 * Pure, so the duplicate-id guarantee can be asserted directly rather than
 * inferred from a round trip. Replaying an id already present returns the same
 * capture set, which is what makes the retry idempotent.
 */
export function applyBufferedRecordToDomain(params: {
  currentDomainData: Record<string, unknown> | null;
  recordId: string;
  value: unknown;
}): Record<string, unknown> {
  const current = params.currentDomainData ?? {};
  const seen = captureIds(current);
  const value =
    params.value && typeof params.value === "object" && !Array.isArray(params.value)
      ? (params.value as Record<string, unknown>)
      : { value: params.value };

  return {
    ...current,
    ...value,
    [ONBOARDING_CAPTURE_IDS_KEY]: seen.includes(params.recordId)
      ? seen
      : [...seen, params.recordId],
  };
}

function buildSummary(domainData: Record<string, unknown>): Record<string, unknown> {
  return {
    source: "onboarding_local_buffer",
    captured_count: captureIds(domainData).length,
    last_captured_at: new Date().toISOString(),
  };
}

async function writeOneRecord(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  record: BufferedOnboardingRecord;
}) {
  return PkmWriteCoordinator.saveMergedDomain({
    userId: params.userId,
    domain: params.record.domain,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    confirmation: {
      confirmedByUser: true,
      surface: "web",
      source: "onboarding_local_buffer_migration",
    },
    build: (context) => {
      const domainData = applyBufferedRecordToDomain({
        currentDomainData: context.currentDomainData,
        recordId: params.record.recordId,
        value: params.record.value,
      });
      return { domainData, summary: buildSummary(domainData) };
    },
  });
}

/**
 * Drain this user's buffer into PKM. Idempotent and resumable: call it as often
 * as you like, including before a vault exists (it reports `pending_vault` and
 * changes nothing).
 */
export async function migrateOnboardingBuffer(params: {
  userId: string;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
}): Promise<OnboardingMigrationResult> {
  const records = await OnboardingBufferService.list(params.userId);
  if (records.length === 0) {
    return { outcome: "nothing_to_migrate", acknowledgedIds: [], remainingIds: [] };
  }

  const allIds = records.map((record) => record.recordId);
  if (!params.vaultKey || !params.vaultOwnerToken) {
    return {
      outcome: "pending_vault",
      acknowledgedIds: [],
      remainingIds: allIds,
      message: "Set up your vault to finish moving these across.",
    };
  }

  const acknowledgedIds: string[] = [];
  const remainingIds: string[] = [];
  let blockedPendingVault = false;

  for (const record of records) {
    if (blockedPendingVault) {
      remainingIds.push(record.recordId);
      continue;
    }

    let result;
    try {
      result = await writeOneRecord({
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        record,
      });
    } catch (error) {
      console.warn("[OnboardingBufferMigration] PKM write threw:", error);
      remainingIds.push(record.recordId);
      continue;
    }

    if (result.saveState === "blocked_pending_unlock") {
      // The vault closed mid-drain. Stop rather than burn retries per record.
      blockedPendingVault = true;
      remainingIds.push(record.recordId);
      continue;
    }

    if (!result.success) {
      remainingIds.push(record.recordId);
      continue;
    }

    // Acknowledged by the server for THIS id — only now is the local copy
    // redundant. A failed delete keeps the record for the next pass, which
    // re-writes the same id and stays a no-op.
    try {
      await OnboardingBufferService.remove(params.userId, record.recordId);
      acknowledgedIds.push(record.recordId);
    } catch (error) {
      console.warn("[OnboardingBufferMigration] Failed to clear a migrated record:", error);
      remainingIds.push(record.recordId);
    }
  }

  if (remainingIds.length === 0) {
    return { outcome: "migrated", acknowledgedIds, remainingIds };
  }
  if (blockedPendingVault) {
    return {
      outcome: "pending_vault",
      acknowledgedIds,
      remainingIds,
      message: "Set up your vault to finish moving these across.",
    };
  }
  return {
    outcome: "partial",
    acknowledgedIds,
    remainingIds,
    message: "Some details are still waiting. We will try again.",
  };
}

/** True once nothing is left buffered for this user. */
export async function isOnboardingBufferDrained(userId: string): Promise<boolean> {
  return (await OnboardingBufferService.count(userId)) === 0;
}
