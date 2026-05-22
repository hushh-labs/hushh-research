import { HushhLocation } from "@/lib/capacitor";
import { ApiError, apiJson } from "@/lib/services/api-client";
import type {
  OneLocationAccessRequest,
  OneLocationEncryptedEnvelope,
  OneLocationGrant,
  OneLocationPublicInvite,
  OneLocationPublicInviteSubmission,
  OneLocationRecipient,
  OneLocationReferral,
  OneLocationState,
  PlainLocationPoint,
} from "@/lib/one-location/types";

function authHeaders(vaultOwnerToken: string): Record<string, string> {
  return { Authorization: `Bearer ${vaultOwnerToken}` };
}

function jsonAuthHeaders(vaultOwnerToken: string): Record<string, string> {
  return {
    ...authHeaders(vaultOwnerToken),
    "Content-Type": "application/json",
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientOneLocationError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (![502, 503, 504].includes(error.status)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("one api unavailable") ||
    message.includes("could not be completed") ||
    message.includes("temporarily unavailable") ||
    error.status === 504
  );
}

async function apiJsonWithRetry<T>(
  path: string,
  options: RequestInit = {},
  retries = 1,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await apiJson<T>(path, options);
    } catch (error) {
      if (attempt >= retries || !isTransientOneLocationError(error)) {
        throw error;
      }
      attempt += 1;
      await wait(450 * attempt);
    }
  }
}

export class OneLocationService {
  static async getPermissionState() {
    return HushhLocation.getPermissionState();
  }

  static async captureCurrentPosition(): Promise<PlainLocationPoint> {
    return HushhLocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeoutMs: 15_000,
    });
  }

  static async registerRecipientKey(params: {
    vaultOwnerToken: string;
    keyId: string;
    publicKeyJwk: JsonWebKey;
    algorithm: string;
  }): Promise<OneLocationRecipient> {
    const response = await apiJson<{ recipientKey: OneLocationRecipient }>(
      "/api/one/location/recipient-keys",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          keyId: params.keyId,
          publicKeyJwk: params.publicKeyJwk,
          algorithm: params.algorithm,
        }),
      },
    );
    return response.recipientKey;
  }

  static async getState(vaultOwnerToken: string): Promise<OneLocationState> {
    return apiJsonWithRetry<OneLocationState>("/api/one/location/state", {
      headers: jsonAuthHeaders(vaultOwnerToken),
    });
  }

  static async createPublicInvite(params: {
    vaultOwnerToken: string;
    durationHours: number;
  }): Promise<{
    invite: OneLocationPublicInvite;
    publicToken: string;
    publicUrl: string;
  }> {
    return apiJsonWithRetry(
      "/api/one/location/public-invites",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ durationHours: params.durationHours }),
      },
      1,
    );
  }

  static async resolvePublicInvite(publicToken: string): Promise<{
    invite: OneLocationPublicInvite;
  }> {
    return apiJsonWithRetry(
      `/api/one/location/public-invites/${encodeURIComponent(publicToken)}`,
      {},
      1,
    );
  }

  static async submitPublicInviteRequest(params: {
    publicToken: string;
    visitorDisplayName: string;
    phoneNumber: string;
    message?: string;
  }): Promise<{
    submission: OneLocationPublicInviteSubmission;
    request?: OneLocationAccessRequest | null;
  }> {
    return apiJsonWithRetry(
      `/api/one/location/public-invites/${encodeURIComponent(params.publicToken)}/submit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          visitorDisplayName: params.visitorDisplayName,
          phoneNumber: params.phoneNumber,
          message: params.message,
        }),
      },
      1,
    );
  }

  static async revokePublicInvite(params: {
    vaultOwnerToken: string;
    inviteId: string;
  }): Promise<OneLocationPublicInvite> {
    const response = await apiJson<{ invite: OneLocationPublicInvite }>(
      `/api/one/location/public-invites/${encodeURIComponent(params.inviteId)}`,
      {
        method: "DELETE",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
      },
    );
    return response.invite;
  }

  static async createGrant(params: {
    vaultOwnerToken: string;
    recipientUserId: string;
    recipientKeyId: string;
    durationHours: number;
  }): Promise<OneLocationGrant> {
    const response = await apiJson<{ grant: OneLocationGrant }>(
      "/api/one/location/grants",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          recipientUserId: params.recipientUserId,
          recipientKeyId: params.recipientKeyId,
          durationHours: params.durationHours,
        }),
      },
    );
    return response.grant;
  }

  static async storeEnvelope(params: {
    vaultOwnerToken: string;
    grantId: string;
    envelope: OneLocationEncryptedEnvelope;
  }): Promise<OneLocationEncryptedEnvelope> {
    const response = await apiJson<{ envelope: OneLocationEncryptedEnvelope }>(
      `/api/one/location/grants/${encodeURIComponent(params.grantId)}/envelopes`,
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ envelope: params.envelope }),
      },
    );
    return response.envelope;
  }

  static async viewEnvelope(params: {
    vaultOwnerToken: string;
    grantId: string;
  }): Promise<{
    grant: OneLocationGrant;
    envelope: OneLocationEncryptedEnvelope;
  }> {
    return apiJson(
      `/api/one/location/grants/${encodeURIComponent(params.grantId)}/envelope`,
      {
        headers: jsonAuthHeaders(params.vaultOwnerToken),
      },
    );
  }

  static async revokeGrant(params: {
    vaultOwnerToken: string;
    grantId: string;
  }): Promise<OneLocationGrant> {
    const response = await apiJson<{ grant: OneLocationGrant }>(
      `/api/one/location/grants/${encodeURIComponent(params.grantId)}`,
      {
        method: "DELETE",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
      },
    );
    return response.grant;
  }

  static async requestAccess(params: {
    vaultOwnerToken: string;
    ownerUserId: string;
    message?: string;
  }): Promise<OneLocationAccessRequest> {
    const response = await apiJsonWithRetry<{
      request: OneLocationAccessRequest;
    }>(
      "/api/one/location/requests",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          ownerUserId: params.ownerUserId,
          message: params.message,
        }),
      },
      1,
    );
    return response.request;
  }

  static async approveRequest(params: {
    vaultOwnerToken: string;
    requestId: string;
    durationHours: number;
  }): Promise<{ request: OneLocationAccessRequest; grant: OneLocationGrant }> {
    return apiJson(
      `/api/one/location/requests/${encodeURIComponent(params.requestId)}/approve`,
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ durationHours: params.durationHours }),
      },
    );
  }

  static async denyRequest(params: {
    vaultOwnerToken: string;
    requestId: string;
  }): Promise<OneLocationAccessRequest> {
    const response = await apiJson<{ request: OneLocationAccessRequest }>(
      `/api/one/location/requests/${encodeURIComponent(params.requestId)}/deny`,
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
      },
    );
    return response.request;
  }

  static async referRecipient(params: {
    vaultOwnerToken: string;
    grantId: string;
    referredUserId: string;
    message?: string;
  }): Promise<{
    referral: OneLocationReferral;
    request: OneLocationAccessRequest;
  }> {
    return apiJson(
      `/api/one/location/grants/${encodeURIComponent(params.grantId)}/refer`,
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          referredUserId: params.referredUserId,
          message: params.message,
        }),
      },
    );
  }
}
