/**
 * Personal Knowledge Model web implementation.
 *
 * Web fallback for the supported PKM proxy surface.
 */

import { WebPlugin } from "@capacitor/core";
import type { HushhPersonalKnowledgeModelPlugin } from "@/lib/capacitor/personal-knowledge-model";

export class HushhPersonalKnowledgeModelWeb
  extends WebPlugin
  implements HushhPersonalKnowledgeModelPlugin
{
  private async getAuthHeader(overrideToken?: string): Promise<string> {
    return overrideToken ? `Bearer ${overrideToken}` : "";
  }

  async getMetadata(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{
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
  }> {
    const response = await fetch(`/api/pkm/metadata/${options.userId}`, {
      headers: {
        Authorization: await this.getAuthHeader(options.vaultOwnerToken),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get metadata: ${response.status}`);
    }

    const data = await response.json();

    return {
      userId: data.user_id,
      domains: (data.domains || []).map((d: Record<string, unknown>) => ({
        key: (d.domain_key || d.key) as string,
        displayName: (d.display_name || d.displayName) as string,
        icon: (d.icon_name || d.icon) as string,
        color: (d.color_hex || d.color) as string,
        attributeCount: (d.attribute_count || d.attributeCount) as number,
        summary: (d.summary || {}) as Record<string, unknown>,
        availableScopes: (d.available_scopes || []) as string[],
        lastUpdated: (d.last_updated || null) as string | null,
        readableSummary: (d.readable_summary || null) as string | null,
        readableHighlights: Array.isArray(d.readable_highlights)
          ? (d.readable_highlights as string[])
          : [],
        readableUpdatedAt: (d.readable_updated_at || null) as string | null,
        readableSourceLabel: (d.readable_source_label || null) as string | null,
        domainContractVersion: Number(d.domain_contract_version || 0) || undefined,
        readableSummaryVersion: Number(d.readable_summary_version || 0) || undefined,
        upgradedAt: (d.upgraded_at || null) as string | null,
      })),
      totalAttributes: data.total_attributes || 0,
      modelCompleteness: data.model_completeness || 0,
      modelVersion: Number(data.model_version || 0) || undefined,
      targetModelVersion: Number(data.target_model_version || 0) || undefined,
      upgradeStatus:
        typeof data.upgrade_status === "string" ? data.upgrade_status : undefined,
      upgradableDomains: Array.isArray(data.upgradable_domains)
        ? (data.upgradable_domains as Record<string, unknown>[]).map((domain) => ({
            domain: String(domain.domain || ""),
            currentDomainContractVersion:
              Number(domain.current_domain_contract_version || 0) || undefined,
            targetDomainContractVersion:
              Number(domain.target_domain_contract_version || 0) || undefined,
            currentReadableSummaryVersion:
              Number(domain.current_readable_summary_version || 0) || undefined,
            targetReadableSummaryVersion:
              Number(domain.target_readable_summary_version || 0) || undefined,
            upgradedAt:
              typeof domain.upgraded_at === "string" ? domain.upgraded_at : null,
            needsUpgrade: Boolean(domain.needs_upgrade),
          }))
        : [],
      lastUpgradedAt:
        typeof data.last_upgraded_at === "string" ? data.last_upgraded_at : null,
      suggestedDomains: data.suggested_domains || [],
      lastUpdated: data.last_updated,
    };
  }

  async getAvailableScopes(options: {
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
  }> {
    const response = await fetch(`/api/pkm/scopes/${options.userId}`, {
      headers: {
        Authorization: await this.getAuthHeader(options.vaultOwnerToken),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get scopes: ${response.status}`);
    }

    const data = await response.json();
    const rawScopes: string[] = Array.isArray(data.scopes)
      ? data.scopes
      : Array.isArray(data.all_scopes)
        ? data.all_scopes
        : [];
    const groupedDomains = new Map<string, string[]>();
    for (const scope of rawScopes) {
      const match = /^attr\.([a-zA-Z0-9_]+)/.exec(scope);
      if (!match) continue;
      const domain = match[1] ?? "";
      if (!domain) continue;
      const existing = groupedDomains.get(domain) || [];
      existing.push(scope);
      groupedDomains.set(domain, existing);
    }

    return {
      userId: data.user_id,
      availableDomains:
        data.available_domains ||
        [...groupedDomains.entries()].map(([domain, scopes]) => ({
          domain,
          displayName: domain.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
          scopes,
        })),
      allScopes: rawScopes,
      wildcardScopes:
        data.wildcard_scopes ||
        rawScopes.filter(
          (scope) => scope === "pkm.read" || scope.endsWith(".*")
        ),
    };
  }

  async getEncryptedData(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{
    ciphertext: string;
    iv: string;
    tag: string;
    algorithm?: string;
    data_version?: number;
    updated_at?: string;
  }> {
    const response = await fetch(`/api/pkm/data/${options.userId}`, {
      headers: {
        Authorization: await this.getAuthHeader(options.vaultOwnerToken),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get encrypted data: ${response.status}`);
    }

    return response.json();
  }

  async storeDomainData(options: {
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
  }> {
    const response = await fetch("/api/pkm/store-domain", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await this.getAuthHeader(options.vaultOwnerToken),
      },
      body: JSON.stringify({
        user_id: options.userId,
        domain: options.domain,
        encrypted_blob: {
          ciphertext: options.encryptedBlob.ciphertext,
          iv: options.encryptedBlob.iv,
          tag: options.encryptedBlob.tag,
          algorithm: options.encryptedBlob.algorithm || "aes-256-gcm",
          segments: options.encryptedBlob.segments || {},
        },
        summary: options.summary,
        structure_decision: options.structureDecision,
        manifest: options.manifest,
        expected_data_version:
          Number.isFinite(options.expectedDataVersion) && options.expectedDataVersion !== undefined
            ? Math.max(0, Number(options.expectedDataVersion))
            : undefined,
        upgrade_context: options.upgradeContext
          ? {
              run_id: options.upgradeContext.runId,
              prior_domain_contract_version:
                options.upgradeContext.priorDomainContractVersion,
              new_domain_contract_version:
                options.upgradeContext.newDomainContractVersion,
              prior_readable_summary_version:
                options.upgradeContext.priorReadableSummaryVersion,
              new_readable_summary_version:
                options.upgradeContext.newReadableSummaryVersion,
              retry_count: options.upgradeContext.retryCount,
            }
          : undefined,
      }),
    });

    if (!response.ok) {
      if (response.status === 409) {
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const detail =
          payload.detail && typeof payload.detail === "object"
            ? (payload.detail as Record<string, unknown>)
            : {};
        return {
          success: false,
          conflict: true,
          message:
            typeof detail.message === "string" ? detail.message : "PKM version conflict.",
          dataVersion:
            typeof detail.current_data_version === "number"
              ? detail.current_data_version
              : undefined,
          updatedAt:
            typeof detail.updated_at === "string" ? detail.updated_at : undefined,
        };
      }
      throw new Error(`Failed to store domain data: ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    return {
      success: data.success !== false,
      conflict: data.conflict === true,
      message: typeof data.message === "string" ? data.message : undefined,
      dataVersion: typeof data.data_version === "number" ? data.data_version : undefined,
      updatedAt: typeof data.updated_at === "string" ? data.updated_at : undefined,
    };
  }

  async getDomainData(options: {
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
  }> {
    const params = new URLSearchParams();
    for (const segmentId of options.segmentIds || []) {
      if (segmentId) {
        params.append("segment_ids", segmentId);
      }
    }
    const response = await fetch(
      `/api/pkm/domain-data/${options.userId}/${options.domain}${
        params.toString() ? `?${params.toString()}` : ""
      }`,
      {
        headers: {
          Authorization: await this.getAuthHeader(options.vaultOwnerToken),
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get domain data: ${response.status}`);
    }

    return response.json();
  }

  async clearDomain(options: {
    userId: string;
    domain: string;
    vaultOwnerToken?: string;
  }): Promise<{ success: boolean }> {
    const response = await fetch(
      `/api/pkm/domain-data/${options.userId}/${options.domain}`,
      {
        method: "DELETE",
        headers: {
          Authorization: await this.getAuthHeader(options.vaultOwnerToken),
        },
      }
    );

    return { success: response.ok };
  }
}
