"use client";

import { toast } from "sonner";

import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import {
  type DomainSummary,
  PkmDomainManifestError,
  PersonalKnowledgeModelService,
} from "@/lib/services/personal-knowledge-model-service";
import {
  type PkmUpgradeMode,
  PkmUpgradeRouteUnavailableError,
  PkmUpgradeService,
  type PkmUpgradeStatus,
} from "@/lib/services/pkm-upgrade-service";
import {
  buildReadableUpgradeSummary,
  runDomainUpgrade,
} from "@/lib/personal-knowledge-model/upgrade-registry";
import {
  buildPersonalKnowledgeModelStructureArtifacts,
  type DomainManifest,
} from "@/lib/personal-knowledge-model/manifest";
import {
  getLocalItem,
  getSessionItem,
  removeLocalItem,
  removeSessionItem,
  setLocalItem,
  setSessionItem,
} from "@/lib/utils/session-storage";

const PKM_UPGRADE_TASK_KIND = "pkm_upgrade";
const PKM_UPGRADE_SNAPSHOT_PREFIX = "pkm_upgrade_snapshot_v1";
const PKM_UPGRADE_REHEARSAL_SESSION_PREFIX = "pkm_upgrade_rehearsal_v1";
const PKM_UPGRADE_ROUTE = "/profile/pkm-agent-lab?tab=overview";
const MAX_CONFLICT_RETRIES = 3;
export const PKM_UPGRADE_COMPLETED_EVENT = "pkm-upgrade-completed";

type PkmUpgradeTimings = {
  manifestReadMs: number;
  decryptLoadMs: number;
  transformMs: number;
  structureRebuildMs: number;
  validationMs: number;
  totalMs: number;
};

type PkmUpgradeStepPlan = {
  currentDomainContractVersion: number;
  targetDomainContractVersion: number;
  currentReadableSummaryVersion: number;
  targetReadableSummaryVersion: number;
};

export type PkmUpgradeCompletedEventDetail = {
  userId: string;
  mode: PkmUpgradeMode;
  runId: string | null;
  occurredAt: string;
};

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
  mode: PkmUpgradeMode;
  status: string;
  currentDomain: string | null;
  timings: PkmUpgradeTimings | null;
  updatedAt: string;
};

function snapshotKey(userId: string): string {
  return `${PKM_UPGRADE_SNAPSHOT_PREFIX}:${userId}`;
}

function rehearsalSessionKey(userId: string): string {
  return `${PKM_UPGRADE_REHEARSAL_SESSION_PREFIX}:${userId}`;
}

function readSnapshot(userId: string): PkmUpgradeSnapshot | null {
  const raw = getLocalItem(snapshotKey(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PkmUpgradeSnapshot>;
    if (parsed.version !== 1 || !parsed.taskId) return null;
    return {
      version: 1,
      userId,
      runId: typeof parsed.runId === "string" ? parsed.runId : "",
      taskId: String(parsed.taskId),
      mode: parsed.mode === "rehearsal_no_write" ? "rehearsal_no_write" : "real",
      status: String(parsed.status || "running"),
      currentDomain: typeof parsed.currentDomain === "string" ? parsed.currentDomain : null,
      timings:
        parsed.timings && typeof parsed.timings === "object"
          ? {
              manifestReadMs: Number((parsed.timings as Partial<PkmUpgradeTimings>).manifestReadMs || 0),
              decryptLoadMs: Number((parsed.timings as Partial<PkmUpgradeTimings>).decryptLoadMs || 0),
              transformMs: Number((parsed.timings as Partial<PkmUpgradeTimings>).transformMs || 0),
              structureRebuildMs: Number(
                (parsed.timings as Partial<PkmUpgradeTimings>).structureRebuildMs || 0
              ),
              validationMs: Number((parsed.timings as Partial<PkmUpgradeTimings>).validationMs || 0),
              totalMs: Number((parsed.timings as Partial<PkmUpgradeTimings>).totalMs || 0),
            }
          : null,
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

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function canUseRehearsalMode(userId: string): boolean {
  const kaiTestUserId = String(process.env.NEXT_PUBLIC_KAI_TEST_USER_ID || "").trim();
  const rehearsalEnabled = process.env.NEXT_PUBLIC_PKM_UPGRADE_REHEARSAL === "true";
  const appEnv = String(process.env.NEXT_PUBLIC_APP_ENV || "").trim().toLowerCase();
  const rehearsalEligibleEnvironment = appEnv === "development" || appEnv === "uat";
  return rehearsalEnabled && rehearsalEligibleEnvironment && Boolean(kaiTestUserId) && userId === kaiTestUserId;
}

function syncRehearsalRequestFromLocation(userId: string): void {
  if (typeof window === "undefined") return;
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("pkm_rehearsal");
    if (value === "1" || value === "true") {
      setSessionItem(rehearsalSessionKey(userId), "true");
      return;
    }
    if (value === "0" || value === "false") {
      removeSessionItem(rehearsalSessionKey(userId));
    }
  } catch {
    // Ignore URL parsing issues and fall back to the current session state.
  }
}

function isRehearsalRequestedForSession(userId: string): boolean {
  if (!canUseRehearsalMode(userId)) return false;
  syncRehearsalRequestFromLocation(userId);
  return getSessionItem(rehearsalSessionKey(userId)) === "true";
}

function resolveUpgradeMode(userId: string): PkmUpgradeMode {
  if (isRehearsalRequestedForSession(userId)) {
    return "rehearsal_no_write";
  }
  return "real";
}

function titleForMode(mode: PkmUpgradeMode): string {
  return mode === "rehearsal_no_write"
    ? "Checking your Personal Knowledge Model upgrade"
    : "Updating your Personal Knowledge Model";
}

function descriptionForStatus(
  mode: PkmUpgradeMode,
  status: string,
  currentDomain?: string | null
): string {
  const domainLabel = currentDomain
    ? currentDomain.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase())
    : "your Personal Knowledge Model";
  if (mode === "rehearsal_no_write") {
    if (status === "completed") {
      return "Kai finished a no-write upgrade check so your latest PKM shape is ready to verify on screen.";
    }
    if (status === "failed") {
      return `Kai paused a no-write upgrade check while validating ${domainLabel}.`;
    }
    return `Checking ${domainLabel} against the latest PKM contract without saving changes.`;
  }
  if (status === "awaiting_local_auth_resume") {
    return `Kai will continue updating ${domainLabel} the next time you unlock your vault.`;
  }
  if (status === "completed") {
    return "Your Personal Knowledge Model is current.";
  }
  if (status === "failed") {
    return `We paused while updating ${domainLabel}.`;
  }
  return `Updating ${domainLabel} in the background.`;
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
  mode: PkmUpgradeMode;
}): Record<string, unknown> {
  const base = {
    runId: params.runId,
    route: params.route,
    domain: params.domain,
    stage: params.stage,
    mode: params.mode,
  } as Record<string, unknown>;
  if (params.error instanceof PkmDomainManifestError) {
    return {
      ...base,
      httpStatus: params.error.status,
      detail: params.error.detail,
      correlationId: params.error.correlationId,
      requestId: params.error.requestId,
      traceId: params.error.traceId,
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

function isAmbiguousPkmProxyWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("failed to store domain data") &&
    normalized.includes("failed to proxy request to backend")
  );
}

function needsVisibleMetadataReconciliation(status: PkmUpgradeStatus): boolean {
  return (
    status.upgradeStatus === "current" &&
    status.upgradableDomains.length === 0 &&
    !status.run &&
    status.storedModelVersion < status.effectiveModelVersion
  );
}

function dispatchUpgradeCompletedEvent(detail: PkmUpgradeCompletedEventDetail): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<PkmUpgradeCompletedEventDetail>(PKM_UPGRADE_COMPLETED_EVENT, {
      detail,
    })
  );
}

export class PkmUpgradeOrchestrator {
  private static inFlightByUser = new Map<string, Promise<void>>();
  private static pauseRequestedByUser = new Set<string>();
  private static routeUnavailableForSession = false;

  private static completeTaskAndNotify(params: {
    taskId: string;
    description: string;
    mode: PkmUpgradeMode;
    userId: string;
    metadata?: Record<string, unknown> | null;
  }): void {
    AppBackgroundTaskService.completeTask(params.taskId, params.description, params.metadata ?? null);
    if (params.mode === "real") {
      toast.success("Personal Knowledge Model updated", {
        description: params.description,
        id: `pkm-upgrade-complete:${params.userId}`,
      });
    }
  }

  private static async finalizeCompletion(params: {
    taskId: string;
    description: string;
    mode: PkmUpgradeMode;
    userId: string;
    vaultOwnerToken: string;
    metadata?: Record<string, unknown> | null;
    runId?: string | null;
  }): Promise<void> {
    await PersonalKnowledgeModelService.getMetadata(
      params.userId,
      true,
      params.vaultOwnerToken
    ).catch((error) => {
      console.warn("[PkmUpgradeOrchestrator] Final PKM metadata refresh failed.", error);
    });

    this.completeTaskAndNotify({
      taskId: params.taskId,
      description: params.description,
      mode: params.mode,
      userId: params.userId,
      metadata: params.metadata ?? null,
    });

    dispatchUpgradeCompletedEvent({
      userId: params.userId,
      mode: params.mode,
      runId: params.runId ?? null,
      occurredAt: new Date().toISOString(),
    });
  }

  static peekSnapshot(userId: string): PkmUpgradeSnapshot | null {
    return readSnapshot(userId);
  }

  static isRouteUnavailableForSession(): boolean {
    return this.routeUnavailableForSession;
  }

  static enableRehearsalForSession(userId: string): void {
    if (!canUseRehearsalMode(userId)) return;
    setSessionItem(rehearsalSessionKey(userId), "true");
  }

  static disableRehearsalForSession(userId: string): void {
    removeSessionItem(rehearsalSessionKey(userId));
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
        description: descriptionForStatus(
          snapshot?.mode || "real",
          "awaiting_local_auth_resume",
          currentDomain
        ),
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
      mode: snapshot?.mode || "real",
      status: "awaiting_local_auth_resume",
      currentDomain,
      timings: snapshot?.timings || null,
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
    const mode = resolveUpgradeMode(params.userId);
    if (mode === "rehearsal_no_write") {
      await this.runRehearsalInternal({ ...params, mode });
      return;
    }
    let priorStatus: PkmUpgradeStatus;
    try {
      priorStatus = await PkmUpgradeService.getStatus({
        userId: params.userId,
        vaultOwnerToken: params.vaultOwnerToken,
        force: true,
      });
    } catch (error) {
      if (error instanceof PkmUpgradeRouteUnavailableError) {
        this.disableForSession(error);
        clearSnapshot(params.userId);
        return;
      }
      throw error;
    }

    const needsMetadataRepair = needsVisibleMetadataReconciliation(priorStatus);
    if (!priorStatus.run && priorStatus.upgradableDomains.length === 0 && !needsMetadataRepair) {
      const snapshot = readSnapshot(params.userId);
      if (snapshot?.taskId) {
        this.completeTaskAndNotify({
          taskId: snapshot.taskId,
          description: descriptionForStatus(snapshot.mode || mode, "completed", null),
          mode: snapshot.mode || mode,
          userId: params.userId,
        });
      }
      clearSnapshot(params.userId);
      return;
    }

    const repairTaskId = needsMetadataRepair
      ? this.ensureTask(
        params.userId,
        {
          ...priorStatus,
          upgradeStatus: "running",
        },
        mode
      )
      : null;

    let status: PkmUpgradeStatus;
    try {
      status = await PkmUpgradeService.startOrResume({
        userId: params.userId,
        vaultOwnerToken: params.vaultOwnerToken,
        initiatedBy: params.initiatedBy || "unlock_warm",
        mode,
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
      const completedTaskId = snapshot?.taskId || repairTaskId;
      if (completedTaskId) {
        await this.finalizeCompletion({
          taskId: completedTaskId,
          description: descriptionForStatus(snapshot?.mode || mode, "completed", null),
          mode: snapshot?.mode || mode,
          userId: params.userId,
          vaultOwnerToken: params.vaultOwnerToken,
          runId: status.run?.runId || null,
        });
      }
      clearSnapshot(params.userId);
      return;
    }

    const taskId = this.ensureTask(params.userId, status, mode);
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
      await this.finalizeCompletion({
        taskId,
        description: descriptionForStatus(mode, "completed", null),
        mode,
        userId: params.userId,
        vaultOwnerToken: params.vaultOwnerToken,
        metadata: {
          runId: status.run?.runId || completedRunId,
          mode,
        },
        runId: status.run?.runId || completedRunId,
      });
      writeSnapshot({
        version: 1,
        userId: params.userId,
        runId: status.run?.runId || "",
        taskId,
        mode,
        status: "completed",
        currentDomain: null,
        timings: null,
        updatedAt: new Date().toISOString(),
      });
      clearSnapshot(params.userId);
    } catch (error) {
      if (error instanceof PkmUpgradePausedForLocalAuthError) {
        const snapshot = readSnapshot(params.userId);
        if (snapshot?.taskId) {
          AppBackgroundTaskService.updateTask(snapshot.taskId, {
            description: descriptionForStatus(
              snapshot.mode || "real",
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
        mode,
      });
      console.error("[PkmUpgradeOrchestrator] PKM upgrade failed", metadata);
      if (runId) {
        await PkmUpgradeService.failRun({
          runId,
          userId: params.userId,
          lastError: message,
          errorContext: metadata,
          vaultOwnerToken: params.vaultOwnerToken,
        }).catch(() => undefined);
      }
      AppBackgroundTaskService.failTask(
        taskId,
        message,
        descriptionForStatus(mode, "failed", status.run?.currentDomain),
        metadata
      );
      writeSnapshot({
        version: 1,
        userId: params.userId,
        runId: status.run?.runId || "",
        taskId,
        mode,
        status: "failed",
        currentDomain: status.run?.currentDomain || null,
        timings: null,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  private static ensureTask(
    userId: string,
    status: PkmUpgradeStatus,
    mode: PkmUpgradeMode
  ): string {
    const snapshot = readSnapshot(userId);
    const taskId =
      snapshot?.runId === status.run?.runId && snapshot?.taskId
        ? snapshot.taskId
        : `${PKM_UPGRADE_TASK_KIND}_${status.run?.runId || `${mode}_${userId}`}`;
    const task = AppBackgroundTaskService.getTask(taskId);
    const description = descriptionForStatus(
      mode,
      status.run?.status || status.upgradeStatus,
      status.run?.currentDomain
    );
    if (!task) {
        AppBackgroundTaskService.startTask({
        taskId,
        userId,
        kind: PKM_UPGRADE_TASK_KIND,
        title: titleForMode(mode),
        description,
        routeHref: PKM_UPGRADE_ROUTE,
        metadata: {
          runId: status.run?.runId || null,
          mode,
        },
      });
    } else {
      AppBackgroundTaskService.updateTask(taskId, {
        title: titleForMode(mode),
        description,
        routeHref: PKM_UPGRADE_ROUTE,
        metadata: {
          ...(task.metadata || {}),
          runId: status.run?.runId || null,
          mode,
        },
      });
    }
    writeSnapshot({
      version: 1,
      userId,
      runId: status.run?.runId || "",
      taskId,
      mode,
      status: status.run?.status || status.upgradeStatus,
      currentDomain: status.run?.currentDomain || null,
      timings: snapshot?.timings || null,
      updatedAt: new Date().toISOString(),
    });
    return taskId;
  }

  private static async prepareUpgradeArtifacts(params: {
    taskId: string;
    userId: string;
    stepDomain: string;
    vaultKey: string;
    vaultOwnerToken: string;
    metadata: { domains: DomainSummary[] };
    stepPlan: PkmUpgradeStepPlan;
    mode: PkmUpgradeMode;
    runId: string | null;
  }): Promise<{
    domainBlobDataVersion: number | undefined;
    upgradedDomainData: Record<string, unknown>;
    nextManifest: DomainManifest;
    nextSummary: Record<string, unknown>;
    structureDecision: Record<string, unknown>;
    timings: PkmUpgradeTimings;
  }> {
    const totalStart = nowMs();
    AppBackgroundTaskService.updateTask(params.taskId, {
      description: descriptionForStatus(params.mode, "running", params.stepDomain),
      routeHref: PKM_UPGRADE_ROUTE,
      metadata: {
        runId: params.runId,
        currentDomain: params.stepDomain,
        stage: "loading_domain",
        mode: params.mode,
      },
    });

    const decryptStart = nowMs();
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
    const decryptLoadMs = Math.round(nowMs() - decryptStart);

    AppBackgroundTaskService.updateTask(params.taskId, {
      metadata: {
        runId: params.runId,
        currentDomain: params.stepDomain,
        stage: "loading_manifest",
        mode: params.mode,
      },
    });
    const manifestStart = nowMs();
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
        runId: params.runId,
        mode: params.mode,
      });
      AppBackgroundTaskService.updateTask(params.taskId, { metadata });
      throw error;
    }
    const manifestReadMs = Math.round(nowMs() - manifestStart);

    const domainSummary =
      params.metadata.domains.find((entry) => entry.key === params.stepDomain) || null;
    const transformStart = nowMs();
    const upgradeResult = runDomainUpgrade({
      domain: params.stepDomain,
      domainData,
      currentVersion: params.stepPlan.currentDomainContractVersion,
    });
    const upgradedAt = new Date().toISOString();
    const transformMs = Math.round(nowMs() - transformStart);

    AppBackgroundTaskService.updateTask(params.taskId, {
      metadata: {
        runId: params.runId,
        currentDomain: params.stepDomain,
        stage: "rebuilding_structure",
        mode: params.mode,
      },
    });
    const structureStart = nowMs();
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
    const nextManifest: DomainManifest = {
      ...structureArtifacts.manifest,
      domain_contract_version: params.stepPlan.targetDomainContractVersion,
      readable_summary_version: params.stepPlan.targetReadableSummaryVersion,
      upgraded_at: upgradedAt,
      summary_projection: {
        ...(structureArtifacts.manifest.summary_projection || {}),
        ...readableMetadata,
        domain_contract_version: params.stepPlan.targetDomainContractVersion,
        readable_summary_version: params.stepPlan.targetReadableSummaryVersion,
        upgraded_at: upgradedAt,
      },
    };
    const nextSummary = {
      ...(domainSummary?.summary || {}),
      ...nextManifest.summary_projection,
      ...readableMetadata,
      domain_contract_version: params.stepPlan.targetDomainContractVersion,
      readable_summary_version: params.stepPlan.targetReadableSummaryVersion,
      upgraded_at: upgradedAt,
    };
    const structureRebuildMs = Math.round(nowMs() - structureStart);

    return {
      domainBlobDataVersion: domainBlob.dataVersion,
      upgradedDomainData: upgradeResult.domainData,
      nextManifest,
      nextSummary,
      structureDecision:
        (nextManifest.structure_decision as Record<string, unknown> | undefined) ||
        structureArtifacts.structureDecision,
      timings: {
        manifestReadMs,
        decryptLoadMs,
        transformMs,
        structureRebuildMs,
        validationMs: 0,
        totalMs: Math.round(nowMs() - totalStart),
      },
    };
  }

  private static async runRehearsalInternal(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    initiatedBy?: string;
    mode: "rehearsal_no_write";
  }): Promise<void> {
    let status: PkmUpgradeStatus;
    try {
      status = await PkmUpgradeService.getStatus({
        userId: params.userId,
        vaultOwnerToken: params.vaultOwnerToken,
        force: true,
      });
    } catch (error) {
      if (error instanceof PkmUpgradeRouteUnavailableError) {
        this.disableForSession(error);
        clearSnapshot(params.userId);
        return;
      }
      throw error;
    }

    if (status.upgradableDomains.length === 0) {
      clearSnapshot(params.userId);
      return;
    }
    const metadata = await PersonalKnowledgeModelService.getMetadata(
      params.userId,
      true,
      params.vaultOwnerToken
    ).catch(() => PersonalKnowledgeModelService.emptyMetadata(params.userId));
    const rehearsalPlans = status.upgradableDomains;

    const pseudoStatus: PkmUpgradeStatus = {
      ...status,
      upgradeStatus: "running",
      upgradableDomains: rehearsalPlans.map((plan) => ({
        ...plan,
        upgradedAt: null,
        needsUpgrade: true,
      })),
      run: {
        runId: "",
        userId: params.userId,
        status: "running",
        mode: params.mode,
        fromModelVersion: status.modelVersion,
        toModelVersion: status.targetModelVersion,
        currentDomain: rehearsalPlans[0]?.domain || null,
        initiatedBy: params.initiatedBy || "app_entry",
        resumeCount: 0,
        startedAt: new Date().toISOString(),
        lastCheckpointAt: new Date().toISOString(),
        completedAt: null,
        lastError: null,
        errorContext: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: rehearsalPlans.map((plan) => ({
          runId: "",
          domain: plan.domain,
          status: "planned",
          fromDomainContractVersion: plan.currentDomainContractVersion,
          toDomainContractVersion: plan.targetDomainContractVersion,
          fromReadableSummaryVersion: plan.currentReadableSummaryVersion,
          toReadableSummaryVersion: plan.targetReadableSummaryVersion,
          attemptCount: 0,
          lastCompletedContentRevision: null,
          lastCompletedManifestVersion: null,
          checkpointPayload: {},
          createdAt: null,
          updatedAt: null,
        })),
      },
    };

    const taskId = this.ensureTask(params.userId, pseudoStatus, params.mode);
    const totalTimings: PkmUpgradeTimings = {
      manifestReadMs: 0,
      decryptLoadMs: 0,
      transformMs: 0,
      structureRebuildMs: 0,
      validationMs: 0,
      totalMs: 0,
    };

    try {
      for (const plan of rehearsalPlans) {
        this.throwIfPauseRequested(params.userId);
        const timings = await this.runRehearsalStep({
          taskId,
          stepDomain: plan.domain,
          stepPlan: plan,
          userId: params.userId,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          metadata,
          mode: params.mode,
        });
        totalTimings.manifestReadMs += timings.manifestReadMs;
        totalTimings.decryptLoadMs += timings.decryptLoadMs;
        totalTimings.transformMs += timings.transformMs;
        totalTimings.structureRebuildMs += timings.structureRebuildMs;
        totalTimings.validationMs += timings.validationMs;
        totalTimings.totalMs += timings.totalMs;
      }

      AppBackgroundTaskService.completeTask(
        taskId,
        descriptionForStatus(params.mode, "completed", null),
        {
          mode: params.mode,
          dummySaveValidated: true,
          timings: totalTimings,
        }
      );
      writeSnapshot({
        version: 1,
        userId: params.userId,
        runId: "",
        taskId,
        mode: params.mode,
        status: "completed",
        currentDomain: null,
        timings: totalTimings,
        updatedAt: new Date().toISOString(),
      });
      clearSnapshot(params.userId);
    } catch (error) {
      const message = failureMessage(error);
      const metadata = failureMetadata({
        error,
        route: PKM_UPGRADE_ROUTE,
        domain: readSnapshot(params.userId)?.currentDomain || null,
        stage: "rehearsal",
        runId: null,
        mode: params.mode,
      });
      console.error("[PkmUpgradeOrchestrator] PKM no-write rehearsal failed", metadata);
      AppBackgroundTaskService.failTask(
        taskId,
        message,
        descriptionForStatus(params.mode, "failed", readSnapshot(params.userId)?.currentDomain),
        metadata
      );
      writeSnapshot({
        version: 1,
        userId: params.userId,
        runId: "",
        taskId,
        mode: params.mode,
        status: "failed",
        currentDomain: readSnapshot(params.userId)?.currentDomain || null,
        timings: totalTimings,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
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
      description: descriptionForStatus(run.mode || "real", "running", params.stepDomain),
      routeHref: PKM_UPGRADE_ROUTE,
      metadata: {
        runId: run.runId,
        currentDomain: params.stepDomain,
        stage: "loading_domain",
        mode: run.mode || "real",
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

      const prepared = await this.prepareUpgradeArtifacts({
        taskId: params.taskId,
        userId: params.userId,
        stepDomain: params.stepDomain,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
        metadata: params.metadata,
        stepPlan: domainState,
        mode: run.mode || "real",
        runId: run.runId,
      });

      let stored: Awaited<ReturnType<typeof PersonalKnowledgeModelService.storeMergedDomain>>;
      try {
        stored = await PersonalKnowledgeModelService.storeMergedDomain({
          userId: params.userId,
          vaultKey: params.vaultKey,
          domain: params.stepDomain,
          domainData: prepared.upgradedDomainData,
          summary: prepared.nextSummary,
          manifest: prepared.nextManifest,
          expectedDataVersion: prepared.domainBlobDataVersion,
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
      } catch (error) {
        if (!isAmbiguousPkmProxyWriteError(error)) {
          throw error;
        }

        const persistedManifest = await PersonalKnowledgeModelService.getDomainManifest(
          params.userId,
          params.stepDomain,
          params.vaultOwnerToken
        ).catch(() => null);
        const persistedBlob = await PersonalKnowledgeModelService.getDomainData(
          params.userId,
          params.stepDomain,
          params.vaultOwnerToken
        ).catch(() => null);
        const persistedDomainVersion = Number(
          persistedManifest?.domain_contract_version || 0
        );
        const persistedReadableVersion = Number(
          persistedManifest?.readable_summary_version || 0
        );
        const landedUpgrade =
          persistedDomainVersion >= domainState.targetDomainContractVersion &&
          persistedReadableVersion >= domainState.targetReadableSummaryVersion;

        if (!landedUpgrade) {
          throw error;
        }

        stored = {
          success: true,
          conflict: false,
          message:
            "Recovered after an ambiguous PKM proxy timeout once the upgraded domain was confirmed.",
          dataVersion: persistedBlob?.dataVersion,
          updatedAt: persistedBlob?.updatedAt,
          fullBlob: {},
        };
      }

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
          timings_ms: prepared.timings,
        },
        attemptCount: attempt,
        lastCompletedContentRevision: stored.dataVersion,
        lastCompletedManifestVersion: prepared.nextManifest.manifest_version,
        vaultOwnerToken: params.vaultOwnerToken,
      });
      AppBackgroundTaskService.updateTask(params.taskId, {
        metadata: {
          runId: run.runId,
          currentDomain: params.stepDomain,
          stage: "completed",
          mode: "real",
          timings: prepared.timings,
        },
      });
      writeSnapshot({
        version: 1,
        userId: params.userId,
        runId: run.runId,
        taskId: params.taskId,
        mode: "real",
        status: currentStatus.run?.status || currentStatus.upgradeStatus,
        currentDomain: params.stepDomain,
        timings: prepared.timings,
        updatedAt: new Date().toISOString(),
      });
      return currentStatus;
    }

    throw new Error(`PKM upgrade exhausted retries for ${params.stepDomain}.`);
  }

  private static async runRehearsalStep(params: {
    taskId: string;
    stepDomain: string;
    stepPlan: PkmUpgradeStepPlan;
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    metadata: { domains: DomainSummary[] };
    mode: "rehearsal_no_write";
  }): Promise<PkmUpgradeTimings> {
    const prepared = await this.prepareUpgradeArtifacts({
      taskId: params.taskId,
      userId: params.userId,
      stepDomain: params.stepDomain,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      metadata: params.metadata,
      stepPlan: params.stepPlan,
      mode: params.mode,
      runId: null,
    });

    AppBackgroundTaskService.updateTask(params.taskId, {
      metadata: {
        currentDomain: params.stepDomain,
        stage: "validating_no_write",
        mode: params.mode,
      },
    });
    const validationStart = nowMs();
    const validation = await PersonalKnowledgeModelService.validatePreparedDomainStore({
      userId: params.userId,
      vaultKey: params.vaultKey,
      domain: params.stepDomain,
      domainData: prepared.upgradedDomainData,
      summary: prepared.nextSummary,
      manifest: prepared.nextManifest,
      structureDecision: prepared.structureDecision,
      expectedDataVersion: prepared.domainBlobDataVersion,
      upgradeContext: {
        runId: `rehearsal_${params.userId}`,
        priorDomainContractVersion: params.stepPlan.currentDomainContractVersion,
        newDomainContractVersion: params.stepPlan.targetDomainContractVersion,
        priorReadableSummaryVersion: params.stepPlan.currentReadableSummaryVersion,
        newReadableSummaryVersion: params.stepPlan.targetReadableSummaryVersion,
        retryCount: 0,
      },
      vaultOwnerToken: params.vaultOwnerToken,
    });
    const validationMs = Math.round(nowMs() - validationStart);
    const timings: PkmUpgradeTimings = {
      ...prepared.timings,
      validationMs,
      totalMs: prepared.timings.totalMs + validationMs,
    };
    AppBackgroundTaskService.updateTask(params.taskId, {
      metadata: {
        currentDomain: params.stepDomain,
        stage: "completed",
        mode: params.mode,
        dummySaveValidated: validation.success,
        validationMessage: validation.message || null,
        timings,
      },
    });
    writeSnapshot({
      version: 1,
      userId: params.userId,
      runId: "",
      taskId: params.taskId,
      mode: params.mode,
      status: "running",
      currentDomain: params.stepDomain,
      timings,
      updatedAt: new Date().toISOString(),
    });
    return timings;
  }

  private static throwIfPauseRequested(userId: string): void {
    if (this.pauseRequestedByUser.has(userId)) {
      throw new PkmUpgradePausedForLocalAuthError(userId);
    }
  }
}
