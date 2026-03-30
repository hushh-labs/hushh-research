"use client";

import { buildConsentExportForScope } from "@/lib/consent/export-builder";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import {
  ConsentExportRefreshService,
  type ConsentExportRefreshJob,
} from "@/lib/services/consent-export-refresh-service";

const TASK_KIND = "consent_export_refresh";
const TASK_ROUTE = "/profile/pkm-agent-lab?tab=natural";

class ConsentExportRefreshPausedError extends Error {
  constructor(userId: string) {
    super(`Consent export refresh paused for local auth resume for ${userId}.`);
    this.name = "ConsentExportRefreshPausedError";
  }
}

function taskIdForUser(userId: string): string {
  return `${TASK_KIND}:${userId}`;
}

function describeJob(job: ConsentExportRefreshJob): string {
  const scopeLabel = job.grantedScope
    .replace(/^attr\./, "")
    .replace(/^pkm\.read$/, "your Personal Knowledge Model");
  return `Refreshing the encrypted shared export for ${scopeLabel}.`;
}

export class ConsentExportRefreshOrchestrator {
  private static inFlightByUser = new Map<string, Promise<void>>();
  private static pauseRequestedByUser = new Set<string>();

  static pauseForLocalAuthResume(params: { userId: string }): void {
    this.pauseRequestedByUser.add(params.userId);
    AppBackgroundTaskService.updateTask(taskIdForUser(params.userId), {
      description: "Unlock your vault to resume refreshing encrypted shared exports.",
      routeHref: TASK_ROUTE,
      metadata: {
        pausedForLocalAuth: true,
      },
    });
  }

  static async ensureRunning(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    initiatedBy?: string;
  }): Promise<void> {
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

  private static throwIfPauseRequested(userId: string): void {
    if (this.pauseRequestedByUser.has(userId)) {
      throw new ConsentExportRefreshPausedError(userId);
    }
  }

  private static ensureTask(userId: string, jobCount: number, initiatedBy?: string): string {
    const taskId = taskIdForUser(userId);
    AppBackgroundTaskService.startTask({
      taskId,
      userId,
      kind: TASK_KIND,
      title: "Refreshing shared encrypted exports",
      description:
        jobCount === 1
          ? "Refreshing 1 encrypted export you have already approved."
          : `Refreshing ${jobCount} encrypted exports you have already approved.`,
      routeHref: TASK_ROUTE,
      metadata: {
        pendingJobCount: jobCount,
        initiatedBy: initiatedBy || "unlock_warm",
      },
    });
    return taskId;
  }

  private static async runInternal(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    initiatedBy?: string;
  }): Promise<void> {
    const jobs = await ConsentExportRefreshService.listJobs({
      userId: params.userId,
      vaultOwnerToken: params.vaultOwnerToken,
    });
    const taskId = taskIdForUser(params.userId);
    if (jobs.length === 0) {
      AppBackgroundTaskService.completeTask(taskId, "Your shared encrypted exports are current.");
      return;
    }

    this.ensureTask(params.userId, jobs.length, params.initiatedBy);
    let successCount = 0;
    let failureCount = 0;

    try {
      for (const job of jobs) {
        this.throwIfPauseRequested(params.userId);
        AppBackgroundTaskService.updateTask(taskId, {
          description: describeJob(job),
          metadata: {
            pendingJobCount: jobs.length,
            currentConsentToken: job.consentToken,
            currentScope: job.grantedScope,
            triggerDomain: job.triggerDomain,
            triggerPaths: job.triggerPaths,
          },
        });

        try {
          if (
            job.connectorWrappingAlg &&
            job.connectorWrappingAlg !== "X25519-AES256-GCM"
          ) {
            throw new Error(
              `Unsupported connector wrapping algorithm: ${job.connectorWrappingAlg}`
            );
          }
          if (!job.connectorPublicKey) {
            throw new Error("Missing connector public key for refresh.");
          }

          const builtExport = await buildConsentExportForScope({
            userId: params.userId,
            scope: job.grantedScope,
            vaultKey: params.vaultKey,
            vaultOwnerToken: params.vaultOwnerToken,
          });
          const {
            encryptForExport,
            generateExportKey,
            wrapExportKeyForConnector,
          } = await import("@/lib/vault/export-encrypt");
          const exportKey = await generateExportKey();
          const encrypted = await encryptForExport(
            JSON.stringify(builtExport.payload),
            exportKey
          );
          const wrappedKeyBundle = await wrapExportKeyForConnector({
            exportKeyHex: exportKey,
            connectorPublicKey: job.connectorPublicKey,
            connectorKeyId: job.connectorKeyId || undefined,
          });

          this.throwIfPauseRequested(params.userId);
          await ConsentExportRefreshService.uploadRefreshedExport({
            userId: params.userId,
            consentToken: job.consentToken,
            encryptedData: encrypted.ciphertext,
            encryptedIv: encrypted.iv,
            encryptedTag: encrypted.tag,
            wrappedExportKey: wrappedKeyBundle.wrappedExportKey,
            wrappedKeyIv: wrappedKeyBundle.wrappedKeyIv,
            wrappedKeyTag: wrappedKeyBundle.wrappedKeyTag,
            senderPublicKey: wrappedKeyBundle.senderPublicKey,
            wrappingAlg: wrappedKeyBundle.wrappingAlg,
            connectorKeyId: wrappedKeyBundle.connectorKeyId || null,
            sourceContentRevision: builtExport.sourceContentRevision,
            sourceManifestRevision: builtExport.sourceManifestRevision,
            vaultOwnerToken: params.vaultOwnerToken,
          });
          successCount += 1;
        } catch (error) {
          if (error instanceof ConsentExportRefreshPausedError) {
            throw error;
          }
          failureCount += 1;
          const message =
            error instanceof Error
              ? error.message
              : "Failed to refresh encrypted shared export.";
          await ConsentExportRefreshService.failJob({
            userId: params.userId,
            consentToken: job.consentToken,
            lastError: message,
            vaultOwnerToken: params.vaultOwnerToken,
          }).catch(() => undefined);
        }
      }
    } catch (error) {
      if (error instanceof ConsentExportRefreshPausedError) {
        AppBackgroundTaskService.updateTask(taskId, {
          description: "Unlock your vault to resume refreshing encrypted shared exports.",
          routeHref: TASK_ROUTE,
          metadata: {
            pausedForLocalAuth: true,
            successCount,
            failureCount,
          },
        });
        return;
      }
      throw error;
    }

    if (successCount > 0 || failureCount > 0) {
      CacheSyncService.onConsentMutated(params.userId);
    }

    if (failureCount > 0) {
      AppBackgroundTaskService.failTask(
        taskId,
        `${failureCount} encrypted export refresh${
          failureCount === 1 ? "" : "es"
        } need another attempt.`,
        successCount > 0
          ? `Refreshed ${successCount} export${
              successCount === 1 ? "" : "s"
            } and left ${failureCount} refresh${
              failureCount === 1 ? "" : "es"
            } pending for retry.`
          : "We paused while refreshing encrypted shared exports. Try again after unlocking your vault."
      );
      return;
    }

    AppBackgroundTaskService.completeTask(
      taskId,
      successCount > 0
        ? `Refreshed ${successCount} encrypted export${successCount === 1 ? "" : "s"}.`
        : "Your shared encrypted exports are current."
    );
  }
}
