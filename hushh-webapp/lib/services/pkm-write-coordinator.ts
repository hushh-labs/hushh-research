"use client";

import type {
  DomainManifest,
} from "@/lib/personal-knowledge-model/manifest";
import {
  CURRENT_READABLE_SUMMARY_VERSION,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import type {
  EncryptedDomainBlob,
  PkmMergeDecision,
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
  manifest?: DomainManifest;
  writeProjections?: PkmWriteProjection[];
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
  fullBlob: Record<string, unknown>;
};

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

  const domainStatus = metadata?.upgradableDomains.find(
    (entry) => entry.domain === params.domain
  );
  const manifestContractVersion = Number(manifest?.domain_contract_version || 0);
  const manifestReadableVersion = Number(manifest?.readable_summary_version || 0);
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
    build: (context: BaseContext) => Promise<MergedWritePlan> | MergedWritePlan;
  }): Promise<PkmWriteCoordinatorResult> {
    if (!params.vaultKey || !params.vaultOwnerToken) {
      return emptyResult("blocked_pending_unlock", "Unlock your vault before saving.");
    }

    let upgradedInSession = false;
    let retryingAfterConflict = false;
    let upgradeContext: PkmUpgradeContext | undefined;

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
      const result = await PersonalKnowledgeModelService.storeMergedDomainWithPreparedBlob({
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        domain: params.domain,
        domainData: plan.domainData,
        summary: plan.summary,
        manifest: plan.manifest,
        writeProjections: plan.writeProjections,
        baseFullBlob: context.baseFullBlob,
        expectedDataVersion: context.currentEncryptedDomain?.dataVersion ?? context.expectedDataVersion,
        upgradeContext: context.upgradeContext,
        cacheFullBlob: false,
      });

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
          fullBlob: result.fullBlob,
        };
      }
      retryingAfterConflict = true;
    }

    return emptyResult("failed", "Failed to save PKM domain.");
  }

  static async savePreparedDomain(params: {
    userId: string;
    domain: string;
    vaultKey?: string | null;
    vaultOwnerToken?: string | null;
    build: (context: BaseContext) => Promise<PreparedWritePlan> | PreparedWritePlan;
  }): Promise<PkmWriteCoordinatorResult> {
    if (!params.vaultKey || !params.vaultOwnerToken) {
      return emptyResult("blocked_pending_unlock", "Unlock your vault before saving.");
    }

    let upgradedInSession = false;
    let retryingAfterConflict = false;
    let upgradeContext: PkmUpgradeContext | undefined;

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
        cacheFullBlob: false,
      });

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
          fullBlob: result.fullBlob,
        };
      }
      retryingAfterConflict = true;
    }

    return emptyResult("failed", "Failed to save PKM domain.");
  }
}
