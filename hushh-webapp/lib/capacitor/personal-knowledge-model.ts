/**
 * Personal Knowledge Model plugin interface.
 *
 * Supported TypeScript surface for the current PKM runtime contract.
 */

import { registerPlugin } from "@capacitor/core";

export interface HushhPersonalKnowledgeModelPlugin {
  getMetadata(options: { userId: string; vaultOwnerToken?: string }): Promise<{
    userId: string;
    domains: Array<{
      key: string;
      displayName: string;
      icon: string;
      color: string;
      attributeCount: number;
      summary: Record<string, unknown>;
      availableScopes: string[];
      lastUpdated: string | null;
      readableSummary?: string | null;
      readableHighlights?: string[];
      readableUpdatedAt?: string | null;
      readableSourceLabel?: string | null;
      domainContractVersion?: number;
      readableSummaryVersion?: number;
      upgradedAt?: string | null;
    }>;
    totalAttributes: number;
    modelCompleteness: number;
    modelVersion?: number;
    targetModelVersion?: number;
    upgradeStatus?: string;
    upgradableDomains?: Array<{
      domain: string;
      currentDomainContractVersion?: number;
      targetDomainContractVersion?: number;
      currentReadableSummaryVersion?: number;
      targetReadableSummaryVersion?: number;
      upgradedAt?: string | null;
      needsUpgrade?: boolean;
    }>;
    lastUpgradedAt?: string | null;
    suggestedDomains: string[];
    lastUpdated: string | null;
  }>;

  getAvailableScopes(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{
    userId: string;
    availableDomains: Array<{
      domain: string;
      displayName: string;
      scopes: string[];
    }>;
    allScopes: string[];
    wildcardScopes: string[];
  }>;

  getEncryptedData(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{
    ciphertext: string;
    iv: string;
    tag: string;
    algorithm?: string;
    data_version?: number;
    updated_at?: string;
  }>;

  storeDomainData(options: {
    userId: string;
    domain: string;
    encryptedBlob: {
      ciphertext: string;
      iv: string;
      tag: string;
      algorithm?: string;
      segments?: Record<
        string,
        {
          ciphertext: string;
          iv: string;
          tag: string;
          algorithm?: string;
        }
      >;
    };
    summary: Record<string, unknown>;
    structureDecision?: Record<string, unknown>;
    manifest?: Record<string, unknown>;
    expectedDataVersion?: number;
    upgradeContext?: {
      runId: string;
      priorDomainContractVersion?: number;
      newDomainContractVersion?: number;
      priorReadableSummaryVersion?: number;
      newReadableSummaryVersion?: number;
      retryCount?: number;
    };
    vaultOwnerToken?: string;
  }): Promise<{
    success: boolean;
    conflict?: boolean;
    message?: string;
    dataVersion?: number;
    updatedAt?: string;
  }>;

  getDomainData(options: {
    userId: string;
    domain: string;
    segmentIds?: string[];
    vaultOwnerToken?: string;
  }): Promise<{
    encrypted_blob?: {
      ciphertext: string;
      iv: string;
      tag: string;
      algorithm?: string;
      segments?: Record<
        string,
        {
          ciphertext: string;
          iv: string;
          tag: string;
          algorithm?: string;
        }
      >;
    };
    storage_mode?: string;
    data_version?: number;
    updated_at?: string;
    manifest_revision?: number;
    segment_ids?: string[];
  }>;

  clearDomain(options: {
    userId: string;
    domain: string;
    vaultOwnerToken?: string;
  }): Promise<{ success: boolean }>;
}

export const HushhPersonalKnowledgeModel = registerPlugin<HushhPersonalKnowledgeModelPlugin>(
  "PersonalKnowledgeModel",
  {
    web: () =>
      import("./plugins/personal-knowledge-model-web").then(
        (m) => new m.HushhPersonalKnowledgeModelWeb()
      ),
  }
);
