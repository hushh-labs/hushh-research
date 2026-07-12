"use client";

import { ApiService } from "@/lib/services/api-service";

export type ConsentExportRefreshJob = {
  jobClaimId: string;
  grantedScope: string;
  connectorPublicKey: string;
  connectorKeyId: string | null;
  connectorWrappingAlg: string;
  status: string;
  triggerDomain: string | null;
  triggerPaths: string[];
  requestedAt: string | null;
  attemptCount: number;
  lastError: string | null;
  exportRevision: number | null;
  exportRefreshStatus: string | null;
  exportId: string;
  grantId: string;
  appId: string;
  scopeHandle: string;
  recipientKeyFingerprint: string;
  expiresAtMs: number;
  refreshPolicy: "continuous_until_expiry";
};

function authHeaders(vaultOwnerToken?: string): HeadersInit {
  return vaultOwnerToken ? { Authorization: `Bearer ${vaultOwnerToken}` } : {};
}

function mapJob(job: Record<string, unknown>): ConsentExportRefreshJob {
  return {
    jobClaimId: String(job.jobClaimId || ""),
    grantedScope: String(job.grantedScope || ""),
    connectorPublicKey: String(job.connectorPublicKey || ""),
    connectorKeyId:
      typeof job.connectorKeyId === "string" && job.connectorKeyId.trim().length > 0
        ? job.connectorKeyId
        : null,
    connectorWrappingAlg:
      typeof job.connectorWrappingAlg === "string" && job.connectorWrappingAlg.trim().length > 0
        ? job.connectorWrappingAlg
        : "X25519-AES256-GCM",
    status: String(job.status || "pending"),
    triggerDomain:
      typeof job.triggerDomain === "string" && job.triggerDomain.trim().length > 0
        ? job.triggerDomain
        : null,
    triggerPaths: Array.isArray(job.triggerPaths)
      ? job.triggerPaths
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean)
      : [],
    requestedAt:
      typeof job.requestedAt === "string" && job.requestedAt.trim().length > 0
        ? job.requestedAt
        : null,
    attemptCount: Number(job.attemptCount || 0),
    lastError:
      typeof job.lastError === "string" && job.lastError.trim().length > 0
        ? job.lastError
        : null,
    exportRevision: typeof job.exportRevision === "number" ? job.exportRevision : null,
    exportRefreshStatus:
      typeof job.exportRefreshStatus === "string" && job.exportRefreshStatus.trim().length > 0
        ? job.exportRefreshStatus
        : null,
    exportId: String(job.exportId || ""),
    grantId: String(job.grantId || ""),
    appId: String(job.appId || ""),
    scopeHandle: String(job.scopeHandle || ""),
    recipientKeyFingerprint: String(job.recipientKeyFingerprint || ""),
    expiresAtMs: Number(job.expiresAtMs || 0),
    refreshPolicy: "continuous_until_expiry",
  };
}

export class ConsentExportRefreshService {
  private static readonly API_PREFIX = "/api/consent/export-refresh";

  static async listJobs(params: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<ConsentExportRefreshJob[]> {
    const response = await ApiService.apiFetch(
      `${this.API_PREFIX}/jobs?userId=${encodeURIComponent(params.userId)}`,
      {
        headers: authHeaders(params.vaultOwnerToken),
      }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Failed to list consent export refresh jobs: ${response.status}${
          detail ? ` - ${detail}` : ""
        }`
      );
    }
    const payload = (await response.json()) as { jobs?: Array<Record<string, unknown>> };
    return Array.isArray(payload.jobs) ? payload.jobs.map(mapJob) : [];
  }

  static async uploadRefreshedExport(params: {
    userId: string;
    jobClaimId: string;
    expectedPriorRevision: number;
    encryptedData: string;
    encryptedIv: string;
    encryptedTag: string;
    wrappedExportKey: string;
    wrappedKeyIv: string;
    wrappedKeyTag: string;
    senderPublicKey: string;
    wrappingAlg?: string;
    connectorKeyId?: string | null;
    sourceContentRevision?: number;
    sourceManifestRevision?: number;
    vaultOwnerToken?: string;
    exportEnvelope: import("@/lib/consent/export-envelope-v2").ConsentExportEnvelopeSubmissionV2;
  }): Promise<{ success: boolean; exportRevision: number | null }> {
    const response = await ApiService.apiFetch(`${this.API_PREFIX}/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(params.vaultOwnerToken),
      },
      body: JSON.stringify({
        userId: params.userId,
        jobClaimId: params.jobClaimId,
        expectedPriorRevision: params.expectedPriorRevision,
        encryptedData: params.encryptedData,
        encryptedIv: params.encryptedIv,
        encryptedTag: params.encryptedTag,
        wrappedExportKey: params.wrappedExportKey,
        wrappedKeyIv: params.wrappedKeyIv,
        wrappedKeyTag: params.wrappedKeyTag,
        senderPublicKey: params.senderPublicKey,
        wrappingAlg: params.wrappingAlg,
        connectorKeyId: params.connectorKeyId,
        sourceContentRevision: params.sourceContentRevision,
        sourceManifestRevision: params.sourceManifestRevision,
        exportEnvelope: params.exportEnvelope,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Failed to upload refreshed export: ${response.status}${detail ? ` - ${detail}` : ""}`
      );
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      success: payload.success !== false,
      exportRevision:
        typeof payload.exportRevision === "number" ? payload.exportRevision : null,
    };
  }

  static async failJob(params: {
    userId: string;
    jobClaimId: string;
    lastError?: string | null;
    vaultOwnerToken?: string;
  }): Promise<void> {
    const response = await ApiService.apiFetch(`${this.API_PREFIX}/fail`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(params.vaultOwnerToken),
      },
      body: JSON.stringify({
        userId: params.userId,
        jobClaimId: params.jobClaimId,
        lastError: params.lastError || null,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Failed to report consent export refresh failure: ${response.status}${
          detail ? ` - ${detail}` : ""
        }`
      );
    }
  }
}
