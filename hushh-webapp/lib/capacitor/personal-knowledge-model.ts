/**
 * Personal Knowledge Model plugin interface.
 *
 * Supported TypeScript surface for the current PKM runtime contract.
 */

import { registerPlugin } from "@capacitor/core";

export interface PkmSyncCheckpointPluginMetadata {
  schemaVersion: "pkm_sync_checkpoint.v1";
  checkpointKey: string;
  domain: string;
  source: string;
  attempt: number;
  expectedDataVersion: number | null;
  resultDataVersion?: number | null;
  currentManifestVersion: number | null;
  targetManifestVersion: number | null;
  upgradedInSession: boolean;
  conflictRetry: boolean;
  upgradeRunId?: string | null;
}

export interface HushhPersonalKnowledgeModelPlugin {
  /**
   * Legacy PKM index read surface retained for native bridge compatibility.
   * New callers should prefer getMetadata() plus getDomainData().
   */
  getIndex(options: { userId: string; vaultOwnerToken?: string }): Promise<Record<string, unknown>>;

  /**
   * Legacy attribute read surface retained for native bridge compatibility.
   * New callers should prefer getDomainData().
   */
  getAttributes(options: { userId: string; vaultOwnerToken?: string }): Promise<Record<string, unknown>>;

  /**
   * Legacy attribute write surface retained for native bridge compatibility.
   * New callers should prefer storeDomainData().
   */
  storeAttribute(options: {
    userId: string;
    domain?: string;
    attributeKey?: string;
    ciphertext?: string;
    iv?: string;
    tag?: string;
    vaultOwnerToken?: string;
  }): Promise<Record<string, unknown>>;

  /**
   * Legacy attribute delete surface retained for native bridge compatibility.
   * New callers should prefer clearDomain() or domain-level writes.
   */
  deleteAttribute(options: {
    userId: string;
    domain?: string;
    attributeKey?: string;
    vaultOwnerToken?: string;
  }): Promise<Record<string, unknown>>;

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
    scopeEntries?: Array<Record<string, unknown>>;
  }>;

  /**
   * Legacy Kai chat bootstrap surface retained for native bridge compatibility.
   * Current callers should use the Kai plugin or service-layer methods.
   */
  getInitialChatState(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<Record<string, unknown>>;

  /**
   * Legacy portfolio import surface retained for native bridge compatibility.
   * Current callers should use the Kai plugin import path.
   */
  importPortfolio(options: {
    userId: string;
    fileData?: string;
    fileName?: string;
    fileBase64?: string;
    mimeType?: string;
    vaultOwnerToken?: string;
  }): Promise<Record<string, unknown>>;

  listDomains(options: { vaultOwnerToken?: string }): Promise<Record<string, unknown>>;

  getUserDomains(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<Record<string, unknown>>;

  getPortfolio(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<Record<string, unknown>>;

  listPortfolios(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<Record<string, unknown>>;

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
    writeProjections?: Array<{
      projectionType: string;
      projectionVersion?: number;
      payload: Record<string, unknown>;
    }>;
    expectedDataVersion?: number;
    upgradeContext?: {
      runId: string;
      priorDomainContractVersion?: number;
      newDomainContractVersion?: number;
      priorReadableSummaryVersion?: number;
      newReadableSummaryVersion?: number;
      retryCount?: number;
    };
    syncCheckpoint?: PkmSyncCheckpointPluginMetadata;
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
