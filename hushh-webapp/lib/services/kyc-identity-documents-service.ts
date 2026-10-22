"use client";

/**
 * Files a government id number the owner kept in Secrets into their KYC
 * identity documents (`identity.identity_documents`), with the owner's tap on
 * the KYC screen. The writer is the registered feature writer
 * `kyc_identity_document_file`; the reserved registry lets no memory agent
 * write this branch, and One sees it by label only (`send_to_model: label_only`).
 */

import type { PkmWriteCoordinatorResult } from "@/lib/services/pkm-write-coordinator";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

export type IdentityDocumentType = "passport" | "ssn" | "aadhaar" | "government_id";

const DOCUMENT_TYPE_BY_PATTERN: Readonly<Record<string, IdentityDocumentType>> = {
  passport_number: "passport",
  ssn: "ssn",
  aadhaar: "aadhaar",
};

export function identityDocumentTypeFor(patternId: string): IdentityDocumentType {
  return DOCUMENT_TYPE_BY_PATTERN[patternId] ?? "government_id";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class KycIdentityDocumentsService {
  static async fileDocument(params: {
    userId: string;
    vaultKey: string | null;
    vaultOwnerToken: string | null;
    documentType: IdentityDocumentType;
    number: string;
    label: string;
    beforeEffect?: () => Promise<void>;
    /** Existing encrypted source reference supplies retry identity, never a value. */
    sourceSecretId?: string;
  }): Promise<PkmWriteCoordinatorResult> {
    if (params.sourceSecretId !== undefined && !/^sec_[a-f0-9]{16}$/.test(params.sourceSecretId)) throw new Error("invalid_secret_reference");
    const documentId = params.sourceSecretId ? `doc_${params.sourceSecretId.slice(4)}` : `doc_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const filedAt = new Date().toISOString();
    return PkmWriteCoordinator.saveMergedDomain({
      userId: params.userId,
      domain: "identity",
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      confirmation: { confirmedByUser: true, surface: "web", source: "kyc_identity_document_file" },
      beforeEffect: params.beforeEffect,
      build: (context) => {
        const base = isRecord(context.currentDomainData) ? context.currentDomainData : {};
        const documents = isRecord(base.identity_documents) ? { ...base.identity_documents } : {};
        // An uncertain/repeated filing must not append another record or
        // overwrite edits made to the first committed identity document.
        if (!Object.hasOwn(documents, documentId)) documents[documentId] = {
          document_type: params.documentType,
          number: params.number,
          label: params.label,
          filed_at: filedAt,
          filed_from: "secrets",
        };
        return {
          domainData: { ...base, identity_documents: documents },
          // Keep identity values out of the readable projection, as the KYC profile does.
          summary: { identity_documents_updated: true },
          scopePath: "identity_documents",
        };
      },
    });
  }
}
