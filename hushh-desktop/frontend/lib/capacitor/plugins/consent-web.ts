/**
 * HushhConsent Web Fallback Implementation
 *
 * This implementation is used when running in a browser (web/cloud mode).
 * It calls the existing API routes instead of native Swift plugins.
 *
 * NOTE: In native iOS mode, the Swift plugin implementation is used instead.
 */

import { WebPlugin } from "@capacitor/core";
import type {
  IssueTokenOptions,
  IssueTokenResult,
  ValidateTokenOptions,
  ValidateTokenResult,
  RevokeTokenOptions,
  CreateTrustLinkOptions,
  TrustLink,
  VerifyTrustLinkOptions,
  VerifyTrustLinkResult,
} from "../types";

const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "")
  .trim()
  .replace(/\/$/, "");

export class HushhConsentWeb extends WebPlugin {
  async issueToken(options: IssueTokenOptions): Promise<IssueTokenResult> {
    const response = await fetch(`${BACKEND_URL}/api/consent/issue-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: options.userId,
        agent_id: options.agentId,
        scope: options.scope,
        expires_in_ms: options.expiresInMs,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to issue token: ${error}`);
    }

    const data = await response.json();
    return {
      token: data.token,
      tokenId: data.token_id || data.token.slice(0, 32),
      expiresAt: data.expires_at,
    };
  }

  async validateToken(
    options: ValidateTokenOptions
  ): Promise<ValidateTokenResult> {
    const response = await fetch(`${BACKEND_URL}/api/consent/validate-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: options.token,
        expected_scope: options.expectedScope,
      }),
    });

    if (!response.ok) {
      return {
        valid: false,
        reason: "Token validation failed",
      };
    }

    const data = await response.json();
    return {
      valid: data.valid,
      reason: data.reason,
      agentId: data.agent_id,
      userId: data.user_id,
      scope: data.scope,
    };
  }

  async revokeToken(options: RevokeTokenOptions): Promise<void> {
    const response = await fetch(`${BACKEND_URL}/api/consent/revoke-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: options.token }),
    });

    if (!response.ok) {
      throw new Error("Failed to revoke token");
    }
  }

  async isTokenRevoked(options: {
    token: string;
  }): Promise<{ revoked: boolean }> {
    const response = await fetch(`${BACKEND_URL}/api/consent/is-revoked`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: options.token }),
    });

    if (!response.ok) {
      return { revoked: false };
    }

    const data = await response.json();
    return { revoked: data.revoked };
  }

  /**
   * Revoke consent by scope
   * Calls backend POST /api/consent/revoke
   * Returns { success: boolean, lockVault: boolean }
   */
  async revokeConsent(options: {
    userId: string;
    scope: string;
    vaultOwnerToken?: string;
  }): Promise<{ success: boolean; lockVault?: boolean }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.vaultOwnerToken) {
      headers["Authorization"] = `Bearer ${options.vaultOwnerToken}`;
    }

    const response = await fetch(`${BACKEND_URL}/api/consent/revoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: options.userId,
        scope: options.scope,
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to revoke consent");
    }

    const data = await response.json();
    return {
      success: true,
      lockVault: data.lockVault ?? false,
    };
  }

  /**
   * Approve a pending consent request
   */
  async approve(options: {
    requestId: string;
    userId?: string;
    encryptedData?: string;
    encryptedIv?: string;
    encryptedTag?: string;
    wrappedExportKey?: string;
    wrappedKeyIv?: string;
    wrappedKeyTag?: string;
    senderPublicKey?: string;
    wrappingAlg?: string;
    connectorKeyId?: string;
    sourceContentRevision?: number;
    sourceManifestRevision?: number;
    durationHours?: number;
    vaultOwnerToken?: string;
  }): Promise<{ success: boolean }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.vaultOwnerToken) {
      headers["Authorization"] = `Bearer ${options.vaultOwnerToken}`;
    }

    const response = await fetch(`${BACKEND_URL}/api/consent/pending/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: options.userId,
        requestId: options.requestId,
        encryptedData: options.encryptedData,
        encryptedIv: options.encryptedIv,
        encryptedTag: options.encryptedTag,
        wrappedExportKey: options.wrappedExportKey,
        wrappedKeyIv: options.wrappedKeyIv,
        wrappedKeyTag: options.wrappedKeyTag,
        senderPublicKey: options.senderPublicKey,
        wrappingAlg: options.wrappingAlg,
        connectorKeyId: options.connectorKeyId,
        sourceContentRevision: options.sourceContentRevision,
        sourceManifestRevision: options.sourceManifestRevision,
        durationHours: options.durationHours,
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to approve consent");
    }

    return { success: true };
  }

  /**
   * Deny a pending consent request
   */
  async deny(options: {
    requestId: string;
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{ success: boolean }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.vaultOwnerToken) {
      headers["Authorization"] = `Bearer ${options.vaultOwnerToken}`;
    }

    const response = await fetch(
      `${BACKEND_URL}/api/consent/pending/deny?userId=${options.userId}&requestId=${options.requestId}`,
      {
        method: "POST",
        headers,
      }
    );

    if (!response.ok) {
      throw new Error("Failed to deny consent");
    }

    return { success: true };
  }

  /**
   * Cancel a pending consent request
   */
  async cancel(options: {
    requestId: string;
    vaultOwnerToken?: string;
  }): Promise<{ success: boolean }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.vaultOwnerToken) {
      headers["Authorization"] = `Bearer ${options.vaultOwnerToken}`;
    }

    const response = await fetch(`${BACKEND_URL}/api/consent/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: options.requestId }),
    });

    if (!response.ok) {
      throw new Error("Failed to cancel consent");
    }

    return { success: true };
  }

  /**
   * Get pending consent requests
   */
  async getPending(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{ pending: any[] }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.vaultOwnerToken) {
      headers["Authorization"] = `Bearer ${options.vaultOwnerToken}`;
    }

    const response = await fetch(
      `${BACKEND_URL}/api/consent/pending?userId=${options.userId}`,
      { headers }
    );

    if (!response.ok) {
      throw new Error("Failed to get pending consents");
    }

    const data = await response.json();
    return { pending: data.pending || [] };
  }

  /**
   * Get active consents
   */
  async getActive(options: {
    userId: string;
    vaultOwnerToken?: string;
  }): Promise<{ consents: any[] }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.vaultOwnerToken) {
      headers["Authorization"] = `Bearer ${options.vaultOwnerToken}`;
    }

    const response = await fetch(
      `${BACKEND_URL}/api/consent/active?userId=${options.userId}`,
      { headers }
    );

    if (!response.ok) {
      throw new Error("Failed to get active consents");
    }

    const data = await response.json();
    return { consents: data.active || [] };
  }

  /**
   * Get consent history
   */
  async getHistory(options: {
    userId: string;
    vaultOwnerToken?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: any[] }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.vaultOwnerToken) {
      headers["Authorization"] = `Bearer ${options.vaultOwnerToken}`;
    }

    const params = new URLSearchParams({ userId: options.userId });
    if (options.page) params.append("page", options.page.toString());
    if (options.limit) params.append("limit", options.limit.toString());

    const response = await fetch(
      `${BACKEND_URL}/api/consent/history?${params}`,
      { headers }
    );

    if (!response.ok) {
      throw new Error("Failed to get consent history");
    }

    const data = await response.json();
    return { items: data.items || [] };
  }

  async createTrustLink(options: CreateTrustLinkOptions): Promise<TrustLink> {
    const response = await fetch(`${BACKEND_URL}/api/trust/create-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: options.fromAgent,
        to_agent: options.toAgent,
        scope: options.scope,
        signed_by_user: options.signedByUser,
        expires_in_ms: options.expiresInMs,
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to create trust link");
    }

    const data = await response.json();
    return {
      fromAgent: data.from_agent,
      toAgent: data.to_agent,
      scope: data.scope,
      createdAt: data.created_at,
      expiresAt: data.expires_at,
      signedByUser: data.signed_by_user,
      signature: data.signature,
    };
  }

  async verifyTrustLink(
    options: VerifyTrustLinkOptions
  ): Promise<VerifyTrustLinkResult> {
    const response = await fetch(`${BACKEND_URL}/api/trust/verify-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        link: {
          from_agent: options.link.fromAgent,
          to_agent: options.link.toAgent,
          scope: options.link.scope,
          created_at: options.link.createdAt,
          expires_at: options.link.expiresAt,
          signed_by_user: options.link.signedByUser,
          signature: options.link.signature,
        },
        required_scope: options.requiredScope,
      }),
    });

    if (!response.ok) {
      return { valid: false, reason: "Verification failed" };
    }

    const data = await response.json();
    return {
      valid: data.valid,
      reason: data.reason,
    };
  }
}
