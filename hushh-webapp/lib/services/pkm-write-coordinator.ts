"use client";

import type {
  DomainManifest,
} from "@/lib/personal-knowledge-model/manifest";
import {
  buildConfirmedPkmMutationPlanV2,
  type PkmMutationOperation,
  type PkmUserConfirmation,
} from "@/lib/personal-knowledge-model/mutation-plan";
import {
  CURRENT_PKM_CONTRACT_VERSION,
  CURRENT_READABLE_PROJECTION_VERSION,
  CURRENT_READABLE_SUMMARY_VERSION,
  comparePkmSemanticVersions,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import type {
  EncryptedDomainBlob,
  PkmMergeDecision,
  PkmSyncCheckpointMetadata,
  PkmUpgradeContext,
  PkmWriteProjection,
} from "@/lib/services/personal-knowledge-model-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmUpgradeOrchestrator } from "@/lib/services/pkm-upgrade-orchestrator";
import { PkmUpgradeService } from "@/lib/services/pkm-upgrade-service";

const MAX_CONFLICT_RETRIES = 2;

export type PkmWriteCoordinatorSaveState =
  | "saved"
  | "upgraded_and_saved"
  | "retrying_after_conflict"
  | "blocked_pending_unlock"
  | "failed";

type BaseContext = {
  currentDomainData: Record<string, unknown>;
  currentManifest: DomainManifest | null;
  currentEncryptedDomain: EncryptedDomainBlob | null;
  baseFullBlob: Record<string, unknown>;
  expectedDataVersion?: number;
  upgradeContext?: PkmUpgradeContext;
  attempt: number;
  upgradedInSession: boolean;
};

type MergedWritePlan = {
  domainData: Record<string, unknown>;
  summary: Record<string, unknown>;
  mergeDecision?: PkmMergeDecision;
  manifest?: DomainManifest;
  writeProjections?: PkmWriteProjection[];
  operation?: PkmMutationOperation;
  scopePath?: string;
};

type PreparedWritePlan = MergedWritePlan & {
  mergeDecision?: PkmMergeDecision;
  structureDecision?: Record<string, unknown>;
};

export type PkmWriteCoordinatorResult = {
  saveState: PkmWriteCoordinatorSaveState;
  success: boolean;
  conflict?: boolean;
  message?: string;
  dataVersion?: number;
  updatedAt?: string;
  syncCheckpoint?: PkmSyncCheckpointMetadata;
  fullBlob: Record<string, unknown>;
};

function toNullableVersion(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function buildSyncCheckpoint(params: {
  source: "merged_domain" | "prepared_domain";
  domain: string;
  attempt: number;
  context: BaseContext;
  plan: MergedWritePlan | PreparedWritePlan;
  resultDataVersion?: number;
  conflictRetry: boolean;
}): PkmSyncCheckpointMetadata {
  const expectedDataVersion = toNullableVersion(
    params.context.currentEncryptedDomain?.dataVersion ?? params.context.expectedDataVersion
  );
  const currentManifestVersion = toNullableVersion(params.context.currentManifest?.manifest_version);
  const targetManifestVersion = toNullableVersion(params.plan.manifest?.manifest_version);
  const upgradeRunId = params.context.upgradeContext?.runId || null;

  return {
    schemaVersion: "pkm_sync_checkpoint.v1",
    checkpointKey: [
      "pkm_sync_checkpoint.v1",
      params.source,
      params.domain,
      `attempt:${params.attempt}`,
      `expected:${expectedDataVersion ?? "none"}`,
      `current_manifest:${currentManifestVersion ?? "none"}`,
      `target_manifest:${targetManifestVersion ?? "none"}`,
      `upgrade:${upgradeRunId ?? "none"}`,
    ].join("|"),
    domain: params.domain,
    source: params.source,
    attempt: params.attempt,
    expectedDataVersion,
    resultDataVersion: toNullableVersion(params.resultDataVersion),
    currentManifestVersion,
    targetManifestVersion,
    upgradedInSession: params.context.upgradedInSession,
    conflictRetry: params.conflictRetry,
    upgradeRunId,
  };
}

function emptyResult(
  saveState: PkmWriteCoordinatorSaveState,
  message?: string
): PkmWriteCoordinatorResult {
  return {
    saveState,
    success: false,
    message,
    fullBlob: {},
  };
}

/**
 * The backend write call (`storeDomainData` and friends) throws a raw
 * `Failed to store domain data: 500 - {...}` Error on any non-conflict
 * failure. Surfacing that string verbatim to the user is a stack-trace
 * leak, not a UX. Callers should get one consistent, actionable message and
 * a `failed` result they can retry, instead of an uncaught rejection.
 */
function pkmWriteFailureResult(error: unknown): PkmWriteCoordinatorResult {
  const rawMessage = error instanceof Error ? error.message : String(error || "");
  if (rawMessage.includes("PKM_SHARING_IMPACT_CHANGED")) {
    console.warn("[PkmWriteCoordinator] Sharing impact changed during confirmation.");
    return emptyResult(
      "failed",
      "Sharing changed while you were reviewing this detail. Review the current recipients and confirm again."
    );
  }
  console.error("[PkmWriteCoordinator] PKM write failed:", error);
  return emptyResult(
    "failed",
    "We couldn't save this to your vault. Try again, or make sure your vault is set up.",
  );
}

async function buildWriteContext(params: {
  userId: string;
  domain: string;
  vaultKey: string;
  vaultOwnerToken: string;
  attempt: number;
  upgradedInSession: boolean;
  upgradeContext?: PkmUpgradeContext;
}): Promise<BaseContext> {
  const [{ baseFullBlob, domainData, expectedDataVersion }, currentManifest, currentEncryptedDomain] =
    await Promise.all([
      PkmDomainResourceService.prepareDomainWriteContext({
        userId: params.userId,
        domain: params.domain,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
      }),
      PersonalKnowledgeModelService.getDomainManifest(
        params.userId,
        params.domain,
        params.vaultOwnerToken
      ).catch(() => null),
      PersonalKnowledgeModelService.getDomainData(
        params.userId,
        params.domain,
        params.vaultOwnerToken
      ).catch(() => null),
    ]);

  return {
    currentDomainData: domainData ?? {},
    currentManifest,
    currentEncryptedDomain,
    baseFullBlob,
    expectedDataVersion,
    attempt: params.attempt,
    upgradedInSession: params.upgradedInSession,
    upgradeContext: params.upgradeContext,
  };
}

async function ensureWritableVersion(params: {
  userId: string;
  domain: string;
  vaultKey: string;
  vaultOwnerToken: string;
}): Promise<{ upgraded: boolean; upgradeContext?: PkmUpgradeContext }> {
  const metadata = await PersonalKnowledgeModelService.getMetadata(
    params.userId,
    true,
    params.vaultOwnerToken
  ).catch(() => null);
  const manifest = await PersonalKnowledgeModelService.getDomainManifest(
    params.userId,
    params.domain,
    params.vaultOwnerToken
  ).catch(() => null);

  if (metadata?.upgradeStatus === "client_update_required") {
    throw new Error(
      "This saved information was created by a newer app version. Update the app before changing it."
    );
  }

  const domainStatus = metadata?.upgradableDomains.find(
    (entry) => entry.domain === params.domain
  );
  const manifestContractVersion = Number(manifest?.domain_contract_version || 0);
  const manifestReadableVersion = Number(manifest?.readable_summary_version || 0);
  const hasUnsupportedFutureVersion =
    manifestContractVersion > currentDomainContractVersion(params.domain) ||
    manifestReadableVersion > CURRENT_READABLE_SUMMARY_VERSION ||
    comparePkmSemanticVersions(
      String(manifest?.pkm_contract_version || "0.0.0"),
      CURRENT_PKM_CONTRACT_VERSION
    ) > 0 ||
    comparePkmSemanticVersions(
      String(manifest?.readable_projection_version || "0.0.0"),
      CURRENT_READABLE_PROJECTION_VERSION
    ) > 0;
  if (hasUnsupportedFutureVersion) {
    throw new Error(
      "This saved information was created by a newer app version. Update the app before changing it."
    );
  }
  const needsUpgrade =
    domainStatus?.needsUpgrade === true ||
    (manifest !== null &&
      (manifestContractVersion < currentDomainContractVersion(params.domain) ||
        manifestReadableVersion < CURRENT_READABLE_SUMMARY_VERSION));

  if (!needsUpgrade) {
    return { upgraded: false };
  }

  await PkmUpgradeOrchestrator.ensureRunning({
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    initiatedBy: "pkm_write_coordinator",
  });

  const refreshedStatus = await PkmUpgradeService.getStatus({
    userId: params.userId,
    vaultOwnerToken: params.vaultOwnerToken,
    force: true,
  }).catch(() => null);
  if (refreshedStatus?.upgradeStatus === "client_update_required") {
    throw new Error(
      "This saved information was created by a newer app version. Update the app before changing it."
    );
  }
  const upgradedDomain = refreshedStatus?.upgradableDomains.find(
    (entry) => entry.domain === params.domain
  );

  return {
    upgraded: true,
    upgradeContext: refreshedStatus?.run?.runId
      ? {
          runId: refreshedStatus.run.runId,
          priorDomainContractVersion:
            domainStatus?.currentDomainContractVersion || manifestContractVersion || undefined,
          newDomainContractVersion:
            upgradedDomain?.targetDomainContractVersion ||
            domainStatus?.targetDomainContractVersion ||
            currentDomainContractVersion(params.domain),
          priorReadableSummaryVersion:
            domainStatus?.currentReadableSummaryVersion || manifestReadableVersion || undefined,
          newReadableSummaryVersion:
            upgradedDomain?.targetReadableSummaryVersion ||
            domainStatus?.targetReadableSummaryVersion ||
            CURRENT_READABLE_SUMMARY_VERSION,
        }
      : undefined,
  };
}

export class PkmWriteCoordinator {
  static async saveMergedDomain(params: {
    userId: string;
    domain: string;
    vaultKey?: string | null;
    vaultOwnerToken?: string | null;
    confirmation: PkmUserConfirmation;
    build: (context: BaseContext) => Promise<MergedWritePlan> | MergedWritePlan;
  }): Promise<PkmWriteCoordinatorResult> {
    if (!params.vaultKey || !params.vaultOwnerToken) {
      return emptyResult("blocked_pending_unlock", "Unlock your vault before saving.");
    }

    let upgradedInSession = false;
    let retryingAfterConflict = false;
    let upgradeContext: PkmUpgradeContext | undefined;

    try {
      for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
        if (!upgradedInSession) {
          const upgrade = await ensureWritableVersion({
            userId: params.userId,
            domain: params.domain,
            vaultKey: params.vaultKey,
            vaultOwnerToken: params.vaultOwnerToken,
          });
          upgradedInSession = upgrade.upgraded;
          upgradeContext = upgrade.upgradeContext;
        }

        const context = await buildWriteContext({
          userId: params.userId,
          domain: params.domain,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          attempt,
          upgradedInSession,
          upgradeContext,
        });
        const plan = await params.build(context);
        const mutationPlan = await buildConfirmedPkmMutationPlanV2({
          userId: params.userId,
          domain: params.domain,
          currentManifest: context.currentManifest,
          targetManifest: plan.manifest,
          operation: plan.operation || (context.currentManifest ? "update" : "create"),
          scopePath: plan.scopePath,
          sourceRevision: context.currentEncryptedDomain?.dataVersion,
          confirmation: params.confirmation,
        });
        const syncCheckpoint = buildSyncCheckpoint({
          source: "merged_domain",
          domain: params.domain,
          attempt,
          context,
          plan,
          conflictRetry: retryingAfterConflict,
        });
        const result = await PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
          userId: params.userId,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          domain: params.domain,
          domainData: plan.domainData,
          summary: plan.summary,
          mergeDecision: plan.mergeDecision,
          manifest: plan.manifest,
          writeProjections: plan.writeProjections,
          baseFullBlob: context.baseFullBlob,
          expectedDataVersion: context.currentEncryptedDomain?.dataVersion ?? context.expectedDataVersion,
          upgradeContext: context.upgradeContext,
          syncCheckpoint,
          mutationPlan,
          cacheFullBlob: false,
        });
        const resultCheckpoint = {
          ...syncCheckpoint,
          resultDataVersion: toNullableVersion(result.dataVersion),
        };

        if (result.success) {
          return {
            saveState: upgradedInSession
              ? "upgraded_and_saved"
              : retryingAfterConflict
                ? "retrying_after_conflict"
                : "saved",
            success: true,
            conflict: false,
            message: result.message,
            dataVersion: result.dataVersion,
            updatedAt: result.updatedAt,
            syncCheckpoint: resultCheckpoint,
            fullBlob: result.fullBlob,
          };
        }
        if (!result.conflict || attempt >= MAX_CONFLICT_RETRIES) {
          return {
            saveState: "failed",
            success: false,
            conflict: result.conflict,
            message: result.message,
            dataVersion: result.dataVersion,
            updatedAt: result.updatedAt,
            syncCheckpoint: resultCheckpoint,
            fullBlob: result.fullBlob,
          };
        }
        retryingAfterConflict = true;
      }
    } catch (error) {
      return pkmWriteFailureResult(error);
    }

    return emptyResult("failed", "Failed to save PKM domain.");
  }

  static async savePreparedDomain(params: {
    userId: string;
    domain: string;
    vaultKey?: string | null;
    vaultOwnerToken?: string | null;
    confirmation: PkmUserConfirmation;
    build: (context: BaseContext) => Promise<PreparedWritePlan> | PreparedWritePlan;
  }): Promise<PkmWriteCoordinatorResult> {
    if (!params.vaultKey || !params.vaultOwnerToken) {
      return emptyResult("blocked_pending_unlock", "Unlock your vault before saving.");
    }

    let upgradedInSession = false;
    let retryingAfterConflict = false;
    let upgradeContext: PkmUpgradeContext | undefined;

    try {
      for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
        if (!upgradedInSession) {
          const upgrade = await ensureWritableVersion({
            userId: params.userId,
            domain: params.domain,
            vaultKey: params.vaultKey,
            vaultOwnerToken: params.vaultOwnerToken,
          });
          upgradedInSession = upgrade.upgraded;
          upgradeContext = upgrade.upgradeContext;
        }

        const context = await buildWriteContext({
          userId: params.userId,
          domain: params.domain,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          attempt,
          upgradedInSession,
          upgradeContext,
        });
        const plan = await params.build(context);
        const mergeMode = String(plan.mergeDecision?.merge_mode || "").trim().toLowerCase();
        const operation = mergeMode === "delete_entity"
          ? "delete"
          : mergeMode === "correct_entity"
            ? "update"
            : context.currentManifest
              ? "update"
              : "create";
        const mutationPlan = await buildConfirmedPkmMutationPlanV2({
          userId: params.userId,
          domain: params.domain,
          currentManifest: context.currentManifest,
          targetManifest: plan.manifest,
          operation,
          confidence: Number(plan.structureDecision?.confidence ?? 1),
          explanation: String(plan.structureDecision?.explanation || "").trim() || undefined,
          sourceRevision: context.currentEncryptedDomain?.dataVersion,
          confirmation: params.confirmation,
        });
        const syncCheckpoint = buildSyncCheckpoint({
          source: "prepared_domain",
          domain: params.domain,
          attempt,
          context,
          plan,
          conflictRetry: retryingAfterConflict,
        });
        const result = await PersonalKnowledgeModelService.storePreparedDomainWithPreparedBlob({
          userId: params.userId,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          domain: params.domain,
          domainData: plan.domainData,
          summary: plan.summary,
          mergeDecision: plan.mergeDecision,
          structureDecision: plan.structureDecision,
          manifest: plan.manifest,
          writeProjections: plan.writeProjections,
          baseFullBlob: context.baseFullBlob,
          expectedDataVersion: context.currentEncryptedDomain?.dataVersion ?? context.expectedDataVersion,
          upgradeContext: context.upgradeContext,
          syncCheckpoint,
          mutationPlan,
          cacheFullBlob: false,
        });
        const resultCheckpoint = {
          ...syncCheckpoint,
          resultDataVersion: toNullableVersion(result.dataVersion),
        };

        if (result.success) {
          return {
            saveState: upgradedInSession
              ? "upgraded_and_saved"
              : retryingAfterConflict
                ? "retrying_after_conflict"
                : "saved",
            success: true,
            conflict: false,
            message: result.message,
            dataVersion: result.dataVersion,
            updatedAt: result.updatedAt,
            syncCheckpoint: resultCheckpoint,
            fullBlob: result.fullBlob,
          };
        }
        if (!result.conflict || attempt >= MAX_CONFLICT_RETRIES) {
          return {
            saveState: "failed",
            success: false,
            conflict: result.conflict,
            message: result.message,
            dataVersion: result.dataVersion,
            updatedAt: result.updatedAt,
            syncCheckpoint: resultCheckpoint,
            fullBlob: result.fullBlob,
          };
        }
        retryingAfterConflict = true;
      }
    } catch (error) {
      return pkmWriteFailureResult(error);
    }

    return emptyResult("failed", "Failed to save PKM domain.");
  }
}
