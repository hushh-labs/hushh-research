"use client";

import { isAccountDeletionActive } from "@/lib/auth/account-deletion-activity";
import type {
  DomainManifest,
} from "@/lib/personal-knowledge-model/manifest";
import { PkmMetadataReviewRequired } from "@/lib/personal-knowledge-model/manifest";
import {
  buildConfirmedPkmMutationPlanV2,
  isAutomaticPkmWriteAuthorization,
  type KycReplyAuthorizationV1,
  type PkmMutationOperation,
  type PkmUserConfirmation,
  type PkmWriteAuthorization,
} from "@/lib/personal-knowledge-model/mutation-plan";
import {
  CURRENT_PKM_CONTRACT_VERSION,
  CURRENT_READABLE_PROJECTION_VERSION,
  CURRENT_READABLE_SUMMARY_VERSION,
  comparePkmSemanticVersions,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import {
  RESERVED_ENFORCEMENT_MODE,
  ReservedBranchWriteBlocked,
  assertReservedBranchesUntouched,
  reservedEntryFor,
  type ReservedRefusal,
} from "@/lib/pkm/reserved-branches";
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
import type { LocationPkmFinalizeAuthorizationV1 } from "@/lib/services/one-location-onboarding-run-client";

const MAX_CONFLICT_RETRIES = 2;

export type PkmWriteCoordinatorSaveState =
  | "saved"
  | "upgraded_and_saved"
  | "retrying_after_conflict"
  | "blocked_pending_unlock"
  | "blocked_pending_upgrade"
  /** The reserved-branch registry refused this writer (enforce mode only). */
  | "blocked_reserved_branch"
  | "failed";

class PkmAutomaticUpgradeRequired extends Error {}

type BaseContext = {
  currentDomainData: Record<string, unknown>;
  currentManifest: DomainManifest | null;
  currentEncryptedDomain: EncryptedDomainBlob | null;
  baseFullBlob: Record<string, unknown>;
  expectedDataVersion?: number;
  attempt: number;
  upgradedInSession: boolean;
  upgradeContext?: PkmUpgradeContext;
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
  commitId?: string;
  locationRunRevision?: number;
  locationPlaceReceiptId?: string;
  /** Labels only: which app-owned branches refused this writer. */
  reservedRefusals?: readonly ReservedRefusal[];
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
  const upgradeRunId = null;

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
function pkmWriteFailureResult(
  error: unknown,
  userId: string,
): PkmWriteCoordinatorResult {
  if (error instanceof PkmMetadataReviewRequired) {
    return emptyResult("failed", "This memory has conflicting labels or sensitivity assessments. Review and prepare it again before saving; nothing was saved.");
  }
  if (error instanceof PkmAutomaticUpgradeRequired) {
    return emptyResult("blocked_pending_upgrade", "Open Memory to update it before saving this detail.");
  }
  if (error instanceof ReservedBranchWriteBlocked) {
    // The store's own writer-versus-scope check (enforce mode only).
    return reservedBlockedResult(error.refusals);
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return emptyResult("blocked_pending_unlock", "Memory saving stopped because the session changed.");
  }
  const rawMessage = error instanceof Error ? error.message : String(error || "");
  if (rawMessage.includes("PKM_SHARING_IMPACT_CHANGED")) {
    console.warn("[PkmWriteCoordinator] Sharing impact changed during confirmation.");
    return emptyResult(
      "failed",
      "Sharing changed while you were reviewing this detail. Review the current recipients and confirm again."
    );
  }
  if (isAccountDeletionActive(userId)) {
    // The account is being erased under this write; nothing is left to save.
    console.warn("[PkmWriteCoordinator] PKM write stopped by account deletion.");
    return emptyResult(
      "blocked_pending_unlock",
      "Memory saving stopped because the session changed.",
    );
  }
  // rawMessage here is our own thrown Error's message (a bare status plus,
  // for a structured backend failure, its code/message -- see
  // storeDomainData) or a fetch/runtime error's message. Neither echoes the
  // encrypted request payload, so it's safe in the console and is the only
  // way a "Backend returned failure on store" report is diagnosable without
  // pulling server logs.
  console.error("[PkmWriteCoordinator] PKM write failed:", rawMessage);
  return emptyResult(
    "failed",
    "We couldn't save this to your vault. Try again, or make sure your vault is set up.",
  );
}

let reservedWouldRefuseShadowCount = 0;

/** How many writes this session the reserved-branch registry WOULD have refused. */
export function getReservedWouldRefuseShadowCount(): number {
  return reservedWouldRefuseShadowCount;
}

function reservedBlockedResult(refusals: readonly ReservedRefusal[]): PkmWriteCoordinatorResult {
  const entry = refusals[0] ? reservedEntryFor(refusals[0].domain, refusals[0].branch) : null;
  const owner = entry?.ownerFeature ? ` in ${entry.ownerFeature.replace(/_/g, " ")}` : "";
  return {
    ...emptyResult(
      "blocked_reserved_branch",
      `This belongs to an app screen. Open it${owner} to save it there; nothing was changed.`,
    ),
    reservedRefusals: refusals,
  };
}

/**
 * `contracts/pkm/reserved-branches.v1.json` on the device, after `build`.
 *
 * Diffs every reserved branch before and after the write and judges the
 * writer, through `assertReservedBranchesUntouched`. In `shadow` it counts and
 * never blocks, and any failure is swallowed. In `enforce` a refusal returns
 * `blocked_reserved_branch`, and a failure of the check itself fails closed:
 * the write is not sent. Only labels reach the console, never a stored value.
 */
function guardReservedBranchWrite(params: {
  domain: string;
  context: BaseContext;
  plan: MergedWritePlan | PreparedWritePlan;
  writerId: string;
  authorizationMode?: string | null;
  capabilities: readonly string[];
}): PkmWriteCoordinatorResult | null {
  const enforce = RESERVED_ENFORCEMENT_MODE === "enforce";
  try {
    const refusals = assertReservedBranchesUntouched({
      domain: params.domain,
      before: params.context.currentDomainData,
      after: params.plan.domainData,
      writerId: params.writerId,
      mergeMode: params.plan.mergeDecision?.merge_mode,
      deleteTargetPath: params.plan.mergeDecision?.target_entity_path,
      authorizationMode: params.authorizationMode,
      capabilities: params.capabilities,
      mode: RESERVED_ENFORCEMENT_MODE,
    });
    for (const refusal of refusals) {
      reservedWouldRefuseShadowCount += 1;
      console.debug("[PkmWriteCoordinator] pkm.reserved_would_refuse", {
        domain: refusal.domain,
        branch: refusal.branch,
        writer: refusal.writerId,
        reason: refusal.reason,
      });
    }
    return null;
  } catch (error) {
    if (error instanceof ReservedBranchWriteBlocked) {
      console.warn("[PkmWriteCoordinator] pkm.reserved_refused", error.refusals.map((refusal) => ({
        domain: refusal.domain,
        branch: refusal.branch,
        writer: refusal.writerId,
        reason: refusal.reason,
      })));
      return reservedBlockedResult(error.refusals);
    }
    // Shadow mode must not be able to block or fail a save; enforce fails closed.
    return enforce ? reservedBlockedResult([]) : null;
  }
}

function kycReplyAuthorizationOf(confirmation: PkmWriteAuthorization): KycReplyAuthorizationV1 | undefined {
  return "kycReplyAuthorization" in confirmation ? confirmation.kycReplyAuthorization : undefined;
}

function writeCapabilities(params: {
  confirmation: PkmWriteAuthorization;
  locationFinalizeAuthorization?: LocationPkmFinalizeAuthorizationV1;
}): string[] {
  const held: string[] = [];
  if (params.locationFinalizeAuthorization) held.push("location_finalize_authorization");
  if ("kycReplyAuthorization" in params.confirmation && params.confirmation.kycReplyAuthorization) {
    held.push("information_request_id");
  }
  return held;
}

async function buildWriteContext(params: {
  userId: string;
  domain: string;
  vaultKey: string;
  vaultOwnerToken: string;
  attempt: number;
  upgradedInSession: boolean;
}): Promise<BaseContext> {
  const {
    baseFullBlob,
    domainData,
    expectedDataVersion,
    manifest: currentManifest,
    encryptedDomain: currentEncryptedDomain,
  } = await PkmDomainResourceService.prepareDomainWriteContext({
    userId: params.userId,
    domain: params.domain,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
  });

  return {
    currentDomainData: domainData ?? {},
    currentManifest,
    currentEncryptedDomain,
    baseFullBlob,
    expectedDataVersion,
    attempt: params.attempt,
    upgradedInSession: params.upgradedInSession,
  };
}

async function ensureWritableVersion(params: {
  userId: string;
  domain: string;
  vaultKey: string;
  vaultOwnerToken: string;
  allowImplicitUpgrade?: boolean;
}): Promise<{ upgraded: boolean }> {
  const [metadata, manifest] = await Promise.all([
    PersonalKnowledgeModelService.getMetadata(
      params.userId,
      true,
      params.vaultOwnerToken,
      { allowStaleFallback: params.allowImplicitUpgrade !== false },
    ).catch((error) => { if (params.allowImplicitUpgrade === false) throw error; return null; }),
    PersonalKnowledgeModelService.getDomainManifest(
      params.userId,
      params.domain,
      params.vaultOwnerToken
    ).catch((error) => { if (params.allowImplicitUpgrade === false) throw error; return null; }),
  ]);

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

  // Background capture must not start/resume an independent upgrade with
  // captured credentials. The owner can use the governed upgrade surface.
  if (params.allowImplicitUpgrade === false) throw new PkmAutomaticUpgradeRequired();

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
  return { upgraded: true };
}

export class PkmWriteCoordinator {
  static async saveMergedDomain(params: {
    userId: string;
    domain: string;
    vaultKey?: string | null;
    vaultOwnerToken?: string | null;
    confirmation:
      | PkmUserConfirmation
      | import("@/lib/personal-knowledge-model/mutation-plan").PkmRequestedWorkflowAuthorization
      | import("@/lib/personal-knowledge-model/mutation-plan").PkmConnectedSourceSyncAuthorization;
    idempotencyScope?: string;
    locationFinalizeAuthorization?: LocationPkmFinalizeAuthorizationV1;
    beforeEffect?: () => Promise<void>;
    build: (context: BaseContext) => Promise<MergedWritePlan> | MergedWritePlan;
  }): Promise<PkmWriteCoordinatorResult> {
    if (!params.vaultKey || !params.vaultOwnerToken) {
      return emptyResult("blocked_pending_unlock", "Unlock your vault before saving.");
    }

    let upgradedInSession = false;
    let retryingAfterConflict = false;

    try {
      for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
        if (!upgradedInSession) {
          const upgrade = await ensureWritableVersion({
            userId: params.userId,
            domain: params.domain,
            vaultKey: params.vaultKey,
            vaultOwnerToken: params.vaultOwnerToken,
            // A background refresh of a linked source never triggers a memory
            // upgrade on the owner's behalf.
            allowImplicitUpgrade:
              params.confirmation.authorizationMode !== "owner_connected_source_sync",
          });
          upgradedInSession = upgrade.upgraded;
        }

        const context = await buildWriteContext({
          userId: params.userId,
          domain: params.domain,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          attempt,
          upgradedInSession,
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
          idempotencyScope: params.idempotencyScope,
        });
        const reservedBlock = guardReservedBranchWrite({
          domain: params.domain,
          context,
          plan,
          writerId: mutationPlan.writer_id,
          authorizationMode: mutationPlan.confirmation_receipt.authorization_mode,
          capabilities: writeCapabilities({
            confirmation: params.confirmation,
            locationFinalizeAuthorization: params.locationFinalizeAuthorization,
          }),
        });
        if (reservedBlock) return reservedBlock;
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
          syncCheckpoint,
          mutationPlan,
          locationFinalizeAuthorization: params.locationFinalizeAuthorization,
          kycReplyAuthorization: kycReplyAuthorizationOf(params.confirmation),
          beforeEffect: params.beforeEffect,
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
            commitId: result.commitId,
            locationRunRevision: result.locationRunRevision,
            locationPlaceReceiptId: result.locationPlaceReceiptId,
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
      return pkmWriteFailureResult(error, params.userId);
    }

    return emptyResult("failed", "Failed to save PKM domain.");
  }

  static async savePreparedDomain(params: {
    userId: string;
    domain: string;
    vaultKey?: string | null;
    vaultOwnerToken?: string | null;
    confirmation: PkmWriteAuthorization;
    /** Deterministic plan id (and so commit id) for a replay-safe write. */
    idempotencyScope?: string;
    beforeEffect?: () => Promise<void>;
    mayPublish?: () => boolean;
    build: (context: BaseContext) => Promise<PreparedWritePlan> | PreparedWritePlan;
  }): Promise<PkmWriteCoordinatorResult> {
    if (!params.vaultKey || !params.vaultOwnerToken) {
      return emptyResult("blocked_pending_unlock", "Unlock your vault before saving.");
    }

    let upgradedInSession = false;
    let retryingAfterConflict = false;

    try {
      for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
        await params.beforeEffect?.();
        if (!upgradedInSession) {
          const upgrade = await ensureWritableVersion({
            userId: params.userId,
            domain: params.domain,
            vaultKey: params.vaultKey,
            vaultOwnerToken: params.vaultOwnerToken,
            allowImplicitUpgrade: !isAutomaticPkmWriteAuthorization(params.confirmation),
          });
          upgradedInSession = upgrade.upgraded;
        }

        await params.beforeEffect?.();

        const context = await buildWriteContext({
          userId: params.userId,
          domain: params.domain,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          attempt,
          upgradedInSession,
        });
        await params.beforeEffect?.();
        const plan = await params.build(context);
        await params.beforeEffect?.();
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
          scopePath: plan.scopePath,
          sourceRevision: context.currentEncryptedDomain?.dataVersion,
          confirmation: params.confirmation,
          idempotencyScope: params.idempotencyScope,
        });
        const reservedBlock = guardReservedBranchWrite({
          domain: params.domain,
          context,
          plan,
          writerId: mutationPlan.writer_id,
          authorizationMode: mutationPlan.confirmation_receipt.authorization_mode,
          capabilities: writeCapabilities({ confirmation: params.confirmation }),
        });
        if (reservedBlock) return reservedBlock;
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
          syncCheckpoint,
          mutationPlan,
          kycReplyAuthorization: kycReplyAuthorizationOf(params.confirmation),
          cacheFullBlob: false,
          beforeEffect: params.beforeEffect,
          mayPublish: params.mayPublish,
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
      return pkmWriteFailureResult(error, params.userId);
    }

    return emptyResult("failed", "Failed to save PKM domain.");
  }
}
