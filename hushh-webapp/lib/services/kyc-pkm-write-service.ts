"use client";

import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import type { PkmWriteCoordinatorResult } from "@/lib/services/pkm-write-coordinator";

export const KYC_WORKFLOW_PKM_DOMAIN = "kyc_workflow" as const;

export type KycWorkflowStatus = "verified" | "pending" | "failed" | "not_started";
export type KycWorkflowCheckKey = "identity" | "address" | "bank" | "email";

export type KycWorkflowCheck = {
  status: KycWorkflowStatus;
  updated_at: string | null;
  method: string | null;
  source_domain: string | null;
};

export type KycWorkflowArtifact = {
  checks: Record<KycWorkflowCheckKey, KycWorkflowCheck>;
  overall_status: KycWorkflowStatus;
  counterparty: string | null;
  request_summary: string | null;
  pending_requirements: string[];
  completed_requirements: string[];
  last_updated: string;
  schema_version: 1;
};

export type KycWorkflowPkmWriteParams = {
  userId: string;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  artifact: Omit<KycWorkflowArtifact, "last_updated" | "schema_version">;
};

export type KycWorkflowPkmReadResult = {
  found: boolean;
  artifact: KycWorkflowArtifact | null;
};

function emptyCheck(): KycWorkflowCheck {
  return {
    status: "not_started",
    updated_at: null,
    method: null,
    source_domain: null,
  };
}

function normalizeCheck(value: unknown): KycWorkflowCheck {
  if (!value || typeof value !== "object") return emptyCheck();
  const record = value as Partial<KycWorkflowCheck>;
  return {
    status: record.status ?? "not_started",
    updated_at: record.updated_at ?? null,
    method: record.method ?? null,
    source_domain: record.source_domain ?? null,
  };
}

function normalizeChecks(value: unknown): KycWorkflowArtifact["checks"] {
  const record = value && typeof value === "object"
    ? value as Partial<Record<KycWorkflowCheckKey, unknown>>
    : {};
  return {
    identity: normalizeCheck(record.identity),
    address: normalizeCheck(record.address),
    bank: normalizeCheck(record.bank),
    email: normalizeCheck(record.email),
  };
}

function buildKycSummary(artifact: KycWorkflowArtifact): Record<string, unknown> {
  return {
    workflow_type: "kyc",
    overall_status: artifact.overall_status,
    identity_verified: artifact.checks.identity.status === "verified",
    address_verified: artifact.checks.address.status === "verified",
    bank_linked: artifact.checks.bank.status === "verified",
    email_verified: artifact.checks.email.status === "verified",
    pending_requirement_count: artifact.pending_requirements.length,
    completed_requirement_count: artifact.completed_requirements.length,
    last_updated: artifact.last_updated,
  };
}

export class KycWorkflowPkmService {
  static async writeWorkflowArtifact(
    params: KycWorkflowPkmWriteParams
  ): Promise<PkmWriteCoordinatorResult> {
    const now = new Date().toISOString();

    const artifact: KycWorkflowArtifact = {
      ...params.artifact,
      last_updated: now,
      schema_version: 1,
    };

    return PkmWriteCoordinator.saveMergedDomain({
      userId: params.userId,
      domain: KYC_WORKFLOW_PKM_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      build: (context) => {
        const existing = this.readWorkflowArtifact(context.currentDomainData).artifact;
        const merged: KycWorkflowArtifact = {
          checks: {
            identity: artifact.checks.identity.status !== "not_started"
              ? artifact.checks.identity
              : existing?.checks.identity ?? artifact.checks.identity,
            address: artifact.checks.address.status !== "not_started"
              ? artifact.checks.address
              : existing?.checks.address ?? artifact.checks.address,
            bank: artifact.checks.bank.status !== "not_started"
              ? artifact.checks.bank
              : existing?.checks.bank ?? artifact.checks.bank,
            email: artifact.checks.email.status !== "not_started"
              ? artifact.checks.email
              : existing?.checks.email ?? artifact.checks.email,
          },
          overall_status: artifact.overall_status,
          counterparty: artifact.counterparty ?? existing?.counterparty ?? null,
          request_summary: artifact.request_summary ?? existing?.request_summary ?? null,
          pending_requirements: artifact.pending_requirements,
          completed_requirements: artifact.completed_requirements,
          last_updated: now,
          schema_version: 1,
        };

        return {
          domainData: merged as unknown as Record<string, unknown>,
          summary: buildKycSummary(merged),
        };
      },
    });
  }

  static readWorkflowArtifact(
    domainData: Record<string, unknown> | null
  ): KycWorkflowPkmReadResult {
    if (!domainData) {
      return { found: false, artifact: null };
    }

    const checks = normalizeChecks(domainData.checks);
    const hasChecks = Object.values(checks).some((check) => check.status !== "not_started");
    const pendingRequirements = Array.isArray(domainData.pending_requirements)
      ? domainData.pending_requirements.filter((item): item is string => typeof item === "string")
      : [];
    const completedRequirements = Array.isArray(domainData.completed_requirements)
      ? domainData.completed_requirements.filter((item): item is string => typeof item === "string")
      : [];

    if (!hasChecks && pendingRequirements.length === 0 && completedRequirements.length === 0) {
      return { found: false, artifact: null };
    }

    const artifact: KycWorkflowArtifact = {
      checks,
      overall_status: (domainData.overall_status as KycWorkflowStatus) ?? "not_started",
      counterparty: typeof domainData.counterparty === "string" ? domainData.counterparty : null,
      request_summary: typeof domainData.request_summary === "string"
        ? domainData.request_summary
        : null,
      pending_requirements: pendingRequirements,
      completed_requirements: completedRequirements,
      last_updated: (domainData.last_updated as string) ?? new Date().toISOString(),
      schema_version: 1,
    };

    return { found: true, artifact };
  }
}
