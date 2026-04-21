"use client";

import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import type { PkmWriteCoordinatorResult } from "@/lib/services/pkm-write-coordinator";

export const KYC_PKM_DOMAIN = "kyc" as const;

export type KycVerificationStatus = "verified" | "pending" | "failed" | "not_started";

export type KycArtifact = {
  identity: {
    status: KycVerificationStatus;
    verified_at: string | null;
    method: string | null;
  };
  address: {
    status: KycVerificationStatus;
    verified_at: string | null;
    method: string | null;
  };
  bank: {
    status: KycVerificationStatus;
    linked_at: string | null;
    method: string | null;
  };
  email: {
    address: string | null;
    verified: boolean;
    verified_at: string | null;
  };
  overall_status: KycVerificationStatus;
  last_updated: string;
  schema_version: 1;
};

export type KycPkmWriteParams = {
  userId: string;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  artifact: Omit<KycArtifact, "last_updated" | "schema_version">;
};

export type KycPkmReadResult = {
  found: boolean;
  artifact: KycArtifact | null;
};

function buildKycSummary(artifact: KycArtifact): Record<string, unknown> {
  return {
    overall_status: artifact.overall_status,
    identity_verified: artifact.identity.status === "verified",
    address_verified: artifact.address.status === "verified",
    bank_linked: artifact.bank.status === "verified",
    email_verified: artifact.email.verified,
    last_updated: artifact.last_updated,
  };
}

export class KycPkmWriteService {
  static async writeKycArtifact(
    params: KycPkmWriteParams
  ): Promise<PkmWriteCoordinatorResult> {
    const now = new Date().toISOString();

    const artifact: KycArtifact = {
      ...params.artifact,
      last_updated: now,
      schema_version: 1,
    };

    return PkmWriteCoordinator.saveMergedDomain({
      userId: params.userId,
      domain: KYC_PKM_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      build: (context) => {
        const existing = (context.currentDomainData ?? {}) as Partial<KycArtifact>;
        const merged: KycArtifact = {
          identity: artifact.identity.status !== "not_started"
            ? artifact.identity
            : (existing.identity ?? artifact.identity),
          address: artifact.address.status !== "not_started"
            ? artifact.address
            : (existing.address ?? artifact.address),
          bank: artifact.bank.status !== "not_started"
            ? artifact.bank
            : (existing.bank ?? artifact.bank),
          email: artifact.email.verified
            ? artifact.email
            : (existing.email ?? artifact.email),
          overall_status: artifact.overall_status,
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

  static readKycArtifact(
    domainData: Record<string, unknown> | null
  ): KycPkmReadResult {
    if (!domainData) {
      return { found: false, artifact: null };
    }

    const identity = domainData.identity as KycArtifact["identity"] | undefined;
    const address = domainData.address as KycArtifact["address"] | undefined;
    const bank = domainData.bank as KycArtifact["bank"] | undefined;
    const email = domainData.email as KycArtifact["email"] | undefined;

    if (!identity && !address && !bank && !email) {
      return { found: false, artifact: null };
    }

    const artifact: KycArtifact = {
      identity: identity ?? { status: "not_started", verified_at: null, method: null },
      address: address ?? { status: "not_started", verified_at: null, method: null },
      bank: bank ?? { status: "not_started", linked_at: null, method: null },
      email: email ?? { address: null, verified: false, verified_at: null },
      overall_status: (domainData.overall_status as KycVerificationStatus) ?? "not_started",
      last_updated: (domainData.last_updated as string) ?? new Date().toISOString(),
      schema_version: 1,
    };

    return { found: true, artifact };
  }
}