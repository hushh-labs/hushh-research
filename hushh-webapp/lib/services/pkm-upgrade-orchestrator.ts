"use client";

import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import {
  type DomainSummary,
  PkmDomainManifestError,
  PersonalKnowledgeModelService,
} from "@/lib/services/personal-knowledge-model-service";
import {
  PkmUpgradeRouteUnavailableError,
  PkmUpgradeService,
  type PkmUpgradeStatus,
} from "@/lib/services/pkm-upgrade-service";
import {
  buildReadableUpgradeSummary,
  runDomainUpgrade,
} from "@/lib/personal-knowledge-model/upgrade-registry";
import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";
import { getLocalItem, removeLocalItem, setLocalItem } from "@/lib/utils/session-storage";

const PKM_UPGRADE_TASK_KIND = "pkm_upgrade";
const PKM_UPGRADE_SNAPSHOT_PREFIX = "pkm_upgrade_snapshot_v1";
const PKM_UPGRADE_ROUTE = "/profile/pkm-agent-lab?tab=overview";
const MAX_CONFLICT_RETRIES = 3;

class PkmUpgradePausedForLocalAuthError extends Error {
  constructor(userId: string) {
    super(`PKM upgrade paused for local auth resume for ${userId}.`);
    this.name = "PkmUpgradePausedForLocalAuthError";
  }
}

type PkmUpgradeSnapshot = {
  version: 1;
  userId: string;
  runId: string;
  taskId: string;
  status: string;
  currentDomain: string | null;
  updatedAt: string;
};

function snapshotKey(userId: string): string {
  return `${PKM_UPGRADE_SNAPSHOT_PREFIX}:${userId}`;
}

function readSnapshot(userId: string): PkmUpgradeSnapshot | null {
  const raw = getLocalItem(snapshotKey(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PkmUpgradeSnapshot>;
    if (parsed.version !== 1 || !parsed.runId || !parsed.taskId) return null;
    return {
      version: 1,
      userId,
      runId: String(parsed.runId),
      taskId: String(parsed.taskId),
      status: String(parsed.status || "running"),
      currentDomain: typeof parsed.currentDomain === "string" ? parsed.currentDomain : null,
      updatedAt: String(parsed.updatedAt || new Date().toISOString()),
    };
  } catch {
    return null;
  }
}

function writeSnapshot(snapshot: PkmUpgradeSnapshot): void {
  setLocalItem(snapshotKey(snapshot.userId), JSON.stringify(snapshot));
}

function clearSnapshot(userId: string): void {
  removeLocalItem(snapshotKey(userId));
}

function descriptionForStatus(status: string, currentDomain?: string | null): string {
  const domainLabel = currentDomain
    ? currentDomain.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase())
    : "your Personal Knowledge Model";
  if (status === "awaiting_local_auth_resume") {
    return `Resume the PKM refresh for ${domainLabel} after unlocking your vault.`;
  }
  if (status === "completed") {
    return "Your Personal Knowledge Model is current.";
  }
  if (status === "failed") {
    return `We paused the PKM refresh while updating ${domainLabel}.`;
  }
  return `Refreshing ${domainLabel} in the background.`;
}

function failureMessage(error: unknown): string {
  if (error instanceof PkmDomainManifestError) {
    return error.detail
      ? `Manifest read failed (${error.status}): ${error.detail}`
      : `Manifest read failed (${error.status}).`;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "Personal Knowledge Model upgrade failed unexpectedly.";
}

function failureMetadata(params: {
  error: unknown;
  route: string | null;
  domain: string | null;
  stage: string;
  runId: string | null;
}): Record<string, unknown> {
  const base = {
    runId: params.runId,
    route: params.route,
    domain: params.domain,
    stage: params.stage,
  } as Record<string, unknown>;
  if (params.error instanceof PkmDomainManifestError) {
    return {
      ...base,
      httpStatus: params.error.status,
      detail: params.error.detail,
      correlationId: params.error.correlationId,
      manifestRoute: params.error.route,
    };
  }
  if (params.error instanceof Error) {
    return {
      ...base,
      detail: params.error.message,
    };
  }
  return base;
}

export class PkmUpgradeOrchestrator {
  private static inFlightByUser = new Map<string, Promise<void>>();
  private static pauseRequestedByUser = new Set<string>();
  private static routeUnavailableForSession = false;

  static peekSnapshot(userId: string): PkmUpgradeSnapshot | null {
    return readSnapshot(userId);
  }

  static isRouteUnavailableForSession(): boolean {
    return this.routeUnavailableForSession;
  }

  private static disableForSession(error: unknown): void {
    if (this.routeUnavailableForSession) {
      return;
    }
    this.routeUnavailableForSession = true;
    console.warn("[PkmUpgradeOrchestrator] Disabling PKM upgrade orchestration for this session.", error);
  }

  static async pauseForLocalAuthResume(params: {
    userId: string;
    vaultOwnerToken?: string | null;
  }): Promise<void> {
    if (this.routeUnavailableForSession) {
      return;
    }
    this.pauseRequestedByUser.add(params.userId);
    if (!params.vaultOwnerToken) {
      return;
    }

    const snapshot = readSnapshot(params.userId);
    const status = await PkmUpgradeService.getStatus({
      userId: params.userId,
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch(() => null);
    const runId = snapshot?.runId || status?.run?.runId || null;
    const currentDomain =
      snapshot?.currentDomain || status?.run?.currentDomain || null;
    const taskId = snapshot?.taskId || null;

    if (!runId || !status?.run || !["planned", "running"].includes(status.run.status)) {
      return;
    }

    await PkmUpgradeService.updateRunStatus({
      runId,
      userId: params.userId,
      status: "awaiting_local_auth_resume",
      currentDomain,
      vaultOwnerToken: params.vaultOwnerToken,
    }).catch(() => undefined);

    if (taskId) {
      AppBackgroundTaskService.updateTask(taskId, {
        description: descriptionForStatus("awaiting_local_auth_resume", currentDomain),
        routeHref: PKM_UPGRADE_ROUTE,
        metadata: {
          runId,
          currentDomain,
          pausedForLocalAuth: true,
        },
      });
    }

    writeSnapshot({
      version: 1,
      userId: params.userId,
      runId,
      taskId: taskId || `${PKM_UPGRADE_TASK_KIND}_${runId}`,
      status: "awaiting_local_auth_resume",
      currentDomain,
      updatedAt: new Date().toISOString(),
    });
  }

  static async ensureRunning(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    initiatedBy?: string;
  }): Promise<void> {
    if (this.routeUnavailableForSession) {
      return;
    }
    this.pauseRequestedByUser.delete(params.userId);
    const existing = this.inFlightByUser.get(params.userId);
    if (existing) {
      return existing;
    }
    const request = this.runInternal(params).finally(() => {
      if (this.inFlightByUser.get(params.userId) === request) {
        this.inFlightByUser.delete(params.userId);
      }
    });
    this.inFlightByUser.set(params.userId, request);
    return request;
  }

  private static async runInternal(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    initiatedBy?: string;
  }): Promise<void> {
    let status: PkmUpgradeStatus;
    try {
      status = await PkmUpgradeService.startOrResume({
        userId: params.userId,
        vaultOwnerToken: params.vaultOwnerToken,
        initiatedBy: params.initiatedBy || "unlock_warm",
      });
    } catch (error) {
      if (error instanceof PkmUpgradeRouteUnavailableError) {
        this.disableForSession(error);
        clearSnapshot(params.userId);
        return;
      }
      throw error;
    }
    if (!status.run || status.upgradableDomains.length === 0) {
      const snapshot = readSnapshot(params.userId);
      if (snapshot?.taskId) {
        AppBackgroundTaskService.completeTask(
          snapshot.taskId,
          "Your Personal Knowledge Model is current."
        );
      }
      clearSnapshot(params.userId);
      return;
    }

    const taskId = this.ensureTask(params.userId, status);
    let metadata = await PersonalKnowledgeModelService.getMetadata(
      params.userId,
      true,
      params.vaultOwnerToken
    ).catch(() => PersonalKnowledgeModelService.emptyMetadata(params.userId));

    try {
      for (const step of status.run.steps.filter((entry) => entry.status !== "completed")) {
        this.throwIfPauseRequested(params.userId);
        status = await this.runStep({
          taskId,
          status,
          stepDomain: step.domain,
          userId: params.userId,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          metadata,
        });
        metadata = await PersonalKnowledgeModelService.getMetadata(
          params.userId,
          true,
          params.vaultOwnerToken
        ).catch(() => metadata);
      }

      const completedRunId = status.run?.runId;
      if (!completedRunId) {
        throw new Error("PKM upgrade run disappeared before completion.");
      }
      status = await PkmUpgradeService.completeRun({
        runId: completedRunId,
        userId: params.userId,
        vaultOwnerToken: params.vaultOwnerToken,
      });
      AppBackgroundTaskService.completeTask(taskId, "Your Personal Knowledge Model is current.");
      writeSnapshot({
        version: 1,
        userId: params.userId,
        runId: status.run?.runId || "",
        taskId,
        status: "completed",
        currentDomain: null,
        updatedAt: new Date().toISOString(),
      });
      clearSnapshot(params.userId);
      await PersonalKnowledgeModelService.getMetadata(params.userId, true, params.vaultOwnerToken);
    } catch (error) {
      if (error instanceof PkmUpgradePausedForLocalAuthError) {
        const snapshot = readSnapshot(params.userId);
        if (snapshot?.taskId) {
          AppBackgroundTaskService.updateTask(snapshot.taskId, {
            description: descriptionForStatus(
              "awaiting_local_auth_resume",
              snapshot.currentDomain
            ),
            routeHref: PKM_UPGRADE_ROUTE,
            metadata: {
              runId: snapshot.runId,
              currentDomain: snapshot.currentDomain,
              pausedForLocalAuth: true,
            },
          });
        }
        return;
      }
      const runId = status.run?.runId;
      const message = failureMessage(error);
      const metadata = failureMetadata({
        error,
        route: PKM_UPGRADE_ROUTE,
        domain: status.run?.currentDomain || null,
        stage: "run",
        runId: runId || null,
      });
      console.error("[PkmUpgradeOrchestrator] PKM upgrade failed", metadata);
      if (runId) {
        await PkmUpgradeService.failRun({
          runId,
          userId: params.userId,
          lastError: message,
          vaultOwnerToken: params.vaultOwnerToken,
        }).catch(() => undefined);
      }
      AppBackgroundTaskService.failTask(
        taskId,
        message,
        descriptionForStatus("failed", status.run?.currentDomain),
        metadata
      );
      writeSnapshot({
        version: 1,
        userId: params.userId,
        runId: status.run?.runId || "",
        taskId,
        status: "failed",
        currentDomain: status.run?.currentDomain || null,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  private static ensureTask(userId: string, status: PkmUpgradeStatus): string {
    const snapshot = readSnapshot(userId);
    const taskId =
      snapshot?.runId === status.run?.runId && snapshot?.taskId
        ? snapshot.taskId
        : `${PKM_UPGRADE_TASK_KIND}_${status.run?.runId || userId}`;
    const task = AppBackgroundTaskService.getTask(taskId);
    const description = descriptionForStatus(
      status.run?.status || status.upgradeStatus,
      status.run?.currentDomain
    );
    if (!task) {
        AppBackgroundTaskService.startTask({
        taskId,
        userId,
        kind: PKM_UPGRADE_TASK_KIND,
        title: "Updating your Personal Knowledge Model",
        description,
        routeHref: PKM_UPGRADE_ROUTE,
        metadata: {
          runId: status.run?.runId || null,
        },
      });
    } else {
      AppBackgroundTaskService.updateTask(taskId, {
        title: "Updating your Personal Knowledge Model",
        description,
        routeHref: PKM_UPGRADE_ROUTE,
        metadata: {
          ...(task.metadata || {}),
          runId: status.run?.runId || null,
        },
      });
    }
    writeSnapshot({
      version: 1,
      userId,
      runId: status.run?.runId || "",
      taskId,
      status: status.run?.status || status.upgradeStatus,
      currentDomain: status.run?.currentDomain || null,
      updatedAt: new Date().toISOString(),
    });
    return taskId;
  }

  private static async runStep(params: {
    taskId: string;
    status: PkmUpgradeStatus;
    stepDomain: string;
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    metadata: { domains: DomainSummary[] };
  }): Promise<PkmUpgradeStatus> {
    const run = params.status.run;
    if (!run) {
      throw new Error("PKM upgrade run is missing.");
    }
    const step = run.steps.find((entry) => entry.domain === params.stepDomain);
    const domainState = params.status.upgradableDomains.find((entry) => entry.domain === params.stepDomain);
    if (!step || !domainState) {
      throw new Error(`PKM upgrade step missing for ${params.stepDomain}.`);
    }

    AppBackgroundTaskService.updateTask(params.taskId, {
      description: descriptionForStatus("running", params.stepDomain),
      routeHref: PKM_UPGRADE_ROUTE,
      metadata: {
        runId: run.runId,
        currentDomain: params.stepDomain,
        stage: "loading_domain",
      },
    });

    let attempt = Math.max(1, step.attemptCount + 1);
    while (attempt <= MAX_CONFLICT_RETRIES) {
      let currentStatus = await PkmUpgradeService.updateStep({
        runId: run.runId,
        domain: params.stepDomain,
        userId: params.userId,
        status: "running",
        checkpointPayload: {
          stage: "loading_domain",
          current_domain: params.stepDomain,
        },
        attemptCount: attempt,
        vaultOwnerToken: params.vaultOwnerToken,
      });

      const domainBlob = await PersonalKnowledgeModelService.getDomainData(
        params.userId,
        params.stepDomain,
        params.vaultOwnerToken
      );
      if (!domainBlob) {
        throw new Error(`No encrypted PKM domain blob found for ${params.stepDomain}.`);
      }

      const domainData = await PersonalKnowledgeModelService.loadDomainData({
        userId: params.userId,
        domain: params.stepDomain,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
      });
      if (!domainData) {
        throw new Error(`Could not decrypt ${params.stepDomain} for upgrade.`);
      }

      AppBackgroundTaskService.updateTask(params.taskId, {
        metadata: {
          runId: run.runId,
          currentDomain: params.stepDomain,
          stage: "loading_manifest",
        },
      });
      let existingManifest = null;
      try {
        existingManifest = await PersonalKnowledgeModelService.getDomainManifest(
          params.userId,
          params.stepDomain,
          params.vaultOwnerToken
        );
      } catch (error) {
        const metadata = failureMetadata({
          error,
          route: PKM_UPGRADE_ROUTE,
          domain: params.stepDomain,
          stage: "loading_manifest",
          runId: run.runId,
        });
        AppBackgroundTaskService.updateTask(params.taskId, { metadata });
        throw error;
      }
      const domainSummary =
        params.metadata.domains.find((entry) => entry.key === params.stepDomain) || null;
      const upgradeResult = runDomainUpgrade({
        domain: params.stepDomain,
        domainData,
        currentVersion: domainState.currentDomainContractVersion,
      });
      const upgradedAt = new Date().toISOString();
      const structureArtifacts = buildPersonalKnowledgeModelStructureArtifacts({
        domain: params.stepDomain,
        domainData: upgradeResult.domainData,
        previousManifest: existingManifest,
      });
      const readableMetadata = buildReadableUpgradeSummary({
        domain: params.stepDomain,
        domainSummary,
        manifest: structureArtifacts.manifest,
        upgradedAt,
        notes: upgradeResult.notes,
      });
      const nextManifest = {
        ...structureArtifacts.manifest,
        domain_contract_version: domainState.targetDomainContractVersion,
        readable_summary_version: domainState.targetReadableSummaryVersion,
        upgraded_at: upgradedAt,
        summary_projection: {
          ...(structureArtifacts.manifest.summary_projection || {}),
          ...readableMetadata,
          domain_contract_version: domainState.targetDomainContractVersion,
          readable_summary_version: domainState.targetReadableSummaryVersion,
          upgraded_at: upgradedAt,
        },
      };
      const nextSummary = {
        ...(domainSummary?.summary || {}),
        ...nextManifest.summary_projection,
        ...readableMetadata,
        domain_contract_version: domainState.targetDomainContractVersion,
        readable_summary_version: domainState.targetReadableSummaryVersion,
        upgraded_at: upgradedAt,
      };

      const stored = await PersonalKnowledgeModelService.storeMergedDomain({
        userId: params.userId,
        vaultKey: params.vaultKey,
        domain: params.stepDomain,
        domainData: upgradeResult.domainData,
        summary: nextSummary,
        manifest: nextManifest,
        expectedDataVersion: domainBlob.dataVersion,
        upgradeContext: {
          runId: run.runId,
          priorDomainContractVersion: domainState.currentDomainContractVersion,
          newDomainContractVersion: domainState.targetDomainContractVersion,
          priorReadableSummaryVersion: domainState.currentReadableSummaryVersion,
          newReadableSummaryVersion: domainState.targetReadableSummaryVersion,
          retryCount: attempt - 1,
        },
        vaultOwnerToken: params.vaultOwnerToken,
      });

      if (stored.conflict) {
        currentStatus = await PkmUpgradeService.updateStep({
          runId: run.runId,
          domain: params.stepDomain,
          userId: params.userId,
          status: "conflict_retry",
          checkpointPayload: {
            stage: "conflict_retry",
            current_domain: params.stepDomain,
            attempt,
          },
          attemptCount: attempt,
          vaultOwnerToken: params.vaultOwnerToken,
        });
        attempt += 1;
        if (attempt > MAX_CONFLICT_RETRIES) {
          throw new Error(
            stored.message || `PKM changed on another device while upgrading ${params.stepDomain}.`
          );
        }
        params.status = currentStatus;
        continue;
      }
      if (!stored.success) {
        throw new Error(stored.message || `Failed to store upgraded ${params.stepDomain} domain.`);
      }

      currentStatus = await PkmUpgradeService.updateStep({
        runId: run.runId,
        domain: params.stepDomain,
        userId: params.userId,
        status: "completed",
        checkpointPayload: {
          stage: "completed",
          current_domain: params.stepDomain,
        },
        attemptCount: attempt,
        lastCompletedContentRevision: stored.dataVersion,
        lastCompletedManifestVersion: nextManifest.manifest_version,
        vaultOwnerToken: params.vaultOwnerToken,
      });
      writeSnapshot({
        version: 1,
        userId: params.userId,
        runId: run.runId,
        taskId: params.taskId,
        status: currentStatus.run?.status || currentStatus.upgradeStatus,
        currentDomain: params.stepDomain,
        updatedAt: new Date().toISOString(),
      });
      return currentStatus;
    }

    throw new Error(`PKM upgrade exhausted retries for ${params.stepDomain}.`);
  }

  private static throwIfPauseRequested(userId: string): void {
    if (this.pauseRequestedByUser.has(userId)) {
      throw new PkmUpgradePausedForLocalAuthError(userId);
    }
  }
}
