"use client";

import { ApiService } from "@/lib/services/api-service";
import type { PkmUpgradeDomainState } from "@/lib/services/personal-knowledge-model-service";

export type PkmUpgradeStep = {
  runId: string;
  domain: string;
  status: string;
  fromDomainContractVersion: number;
  toDomainContractVersion: number;
  fromReadableSummaryVersion: number;
  toReadableSummaryVersion: number;
  attemptCount: number;
  lastCompletedContentRevision: number | null;
  lastCompletedManifestVersion: number | null;
  checkpointPayload: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PkmUpgradeRun = {
  runId: string;
  userId: string;
  status: string;
  fromModelVersion: number;
  toModelVersion: number;
  currentDomain: string | null;
  initiatedBy: string;
  resumeCount: number;
  startedAt: string | null;
  lastCheckpointAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  steps: PkmUpgradeStep[];
};

export type PkmUpgradeStatus = {
  userId: string;
  modelVersion: number;
  targetModelVersion: number;
  upgradeStatus: string;
  upgradableDomains: PkmUpgradeDomainState[];
  lastUpgradedAt: string | null;
  run: PkmUpgradeRun | null;
};

function authHeaders(vaultOwnerToken?: string): HeadersInit {
  return vaultOwnerToken ? { Authorization: `Bearer ${vaultOwnerToken}` } : {};
}

function mapDomain(domain: Record<string, unknown>): PkmUpgradeDomainState {
  return {
    domain: String(domain.domain || ""),
    currentDomainContractVersion: Number(domain.current_domain_contract_version || 1),
    targetDomainContractVersion: Number(domain.target_domain_contract_version || 1),
    currentReadableSummaryVersion: Number(domain.current_readable_summary_version || 0),
    targetReadableSummaryVersion: Number(domain.target_readable_summary_version || 0),
    upgradedAt: typeof domain.upgraded_at === "string" ? domain.upgraded_at : null,
    needsUpgrade: Boolean(domain.needs_upgrade),
  };
}

function mapStep(step: Record<string, unknown>): PkmUpgradeStep {
  return {
    runId: String(step.run_id || ""),
    domain: String(step.domain || ""),
    status: String(step.status || "pending"),
    fromDomainContractVersion: Number(step.from_domain_contract_version || 1),
    toDomainContractVersion: Number(step.to_domain_contract_version || 1),
    fromReadableSummaryVersion: Number(step.from_readable_summary_version || 0),
    toReadableSummaryVersion: Number(step.to_readable_summary_version || 0),
    attemptCount: Number(step.attempt_count || 0),
    lastCompletedContentRevision:
      typeof step.last_completed_content_revision === "number"
        ? step.last_completed_content_revision
        : null,
    lastCompletedManifestVersion:
      typeof step.last_completed_manifest_version === "number"
        ? step.last_completed_manifest_version
        : null,
    checkpointPayload:
      step.checkpoint_payload && typeof step.checkpoint_payload === "object"
        ? (step.checkpoint_payload as Record<string, unknown>)
        : {},
    createdAt: typeof step.created_at === "string" ? step.created_at : null,
    updatedAt: typeof step.updated_at === "string" ? step.updated_at : null,
  };
}

function mapRun(run: Record<string, unknown> | null | undefined): PkmUpgradeRun | null {
  if (!run || typeof run !== "object") return null;
  return {
    runId: String(run.run_id || ""),
    userId: String(run.user_id || ""),
    status: String(run.status || "planned"),
    fromModelVersion: Number(run.from_model_version || 1),
    toModelVersion: Number(run.to_model_version || 1),
    currentDomain: typeof run.current_domain === "string" ? run.current_domain : null,
    initiatedBy: String(run.initiated_by || "unlock_warm"),
    resumeCount: Number(run.resume_count || 0),
    startedAt: typeof run.started_at === "string" ? run.started_at : null,
    lastCheckpointAt:
      typeof run.last_checkpoint_at === "string" ? run.last_checkpoint_at : null,
    completedAt: typeof run.completed_at === "string" ? run.completed_at : null,
    lastError: typeof run.last_error === "string" ? run.last_error : null,
    createdAt: typeof run.created_at === "string" ? run.created_at : null,
    updatedAt: typeof run.updated_at === "string" ? run.updated_at : null,
    steps: Array.isArray(run.steps)
      ? run.steps
          .filter((step): step is Record<string, unknown> => !!step && typeof step === "object")
          .map(mapStep)
      : [],
  };
}

function mapStatus(payload: Record<string, unknown>): PkmUpgradeStatus {
  return {
    userId: String(payload.user_id || ""),
    modelVersion: Number(payload.model_version || 1),
    targetModelVersion: Number(payload.target_model_version || 1),
    upgradeStatus: String(payload.upgrade_status || "current"),
    upgradableDomains: Array.isArray(payload.upgradable_domains)
      ? payload.upgradable_domains
          .filter((domain): domain is Record<string, unknown> => !!domain && typeof domain === "object")
          .map(mapDomain)
      : [],
    lastUpgradedAt:
      typeof payload.last_upgraded_at === "string" ? payload.last_upgraded_at : null,
    run: mapRun(
      payload.run && typeof payload.run === "object"
        ? (payload.run as Record<string, unknown>)
        : null
    ),
  };
}

async function requestStatus(
  url: string,
  options: RequestInit,
  context: string
): Promise<PkmUpgradeStatus> {
  const response = await ApiService.apiFetch(url, options);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${context}: ${response.status}${detail ? ` - ${detail}` : ""}`);
  }
  return mapStatus((await response.json()) as Record<string, unknown>);
}

export class PkmUpgradeService {
  private static readonly API_PREFIX = "/api/pkm/upgrade";

  static async getStatus(params: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<PkmUpgradeStatus> {
    return requestStatus(
      `${this.API_PREFIX}/status/${params.userId}`,
      {
        headers: authHeaders(params.vaultOwnerToken),
      },
      "Failed to get PKM upgrade status"
    );
  }

  static async startOrResume(params: {
    userId: string;
    vaultOwnerToken?: string;
    initiatedBy?: string;
  }): Promise<PkmUpgradeStatus> {
    return requestStatus(
      `${this.API_PREFIX}/start-or-resume`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(params.vaultOwnerToken),
        },
        body: JSON.stringify({
          user_id: params.userId,
          initiated_by: params.initiatedBy || "unlock_warm",
        }),
      },
      "Failed to start or resume PKM upgrade"
    );
  }

  static async updateRunStatus(params: {
    runId: string;
    userId: string;
    status: string;
    currentDomain?: string | null;
    lastError?: string | null;
    vaultOwnerToken?: string;
  }): Promise<PkmUpgradeStatus> {
    return requestStatus(
      `${this.API_PREFIX}/runs/${params.runId}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(params.vaultOwnerToken),
        },
        body: JSON.stringify({
          user_id: params.userId,
          status: params.status,
          current_domain: params.currentDomain || null,
          last_error: params.lastError || null,
        }),
      },
      "Failed to update PKM upgrade run"
    );
  }

  static async updateStep(params: {
    runId: string;
    domain: string;
    userId: string;
    status: string;
    checkpointPayload?: Record<string, unknown>;
    attemptCount?: number;
    lastCompletedContentRevision?: number;
    lastCompletedManifestVersion?: number;
    vaultOwnerToken?: string;
  }): Promise<PkmUpgradeStatus> {
    return requestStatus(
      `${this.API_PREFIX}/runs/${params.runId}/steps/${encodeURIComponent(params.domain)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(params.vaultOwnerToken),
        },
        body: JSON.stringify({
          user_id: params.userId,
          status: params.status,
          checkpoint_payload: params.checkpointPayload || {},
          attempt_count: params.attemptCount,
          last_completed_content_revision: params.lastCompletedContentRevision,
          last_completed_manifest_version: params.lastCompletedManifestVersion,
        }),
      },
      "Failed to update PKM upgrade step"
    );
  }

  static async completeRun(params: {
    runId: string;
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<PkmUpgradeStatus> {
    return requestStatus(
      `${this.API_PREFIX}/runs/${params.runId}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(params.vaultOwnerToken),
        },
        body: JSON.stringify({
          user_id: params.userId,
        }),
      },
      "Failed to complete PKM upgrade run"
    );
  }

  static async failRun(params: {
    runId: string;
    userId: string;
    lastError?: string | null;
    vaultOwnerToken?: string;
  }): Promise<PkmUpgradeStatus> {
    return requestStatus(
      `${this.API_PREFIX}/runs/${params.runId}/fail`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(params.vaultOwnerToken),
        },
        body: JSON.stringify({
          user_id: params.userId,
          status: "failed",
          last_error: params.lastError || null,
        }),
      },
      "Failed to fail PKM upgrade run"
    );
  }
}
