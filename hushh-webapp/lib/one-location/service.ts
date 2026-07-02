import { HushhLocation } from "@/lib/capacitor";
import { ApiError, apiJson } from "@/lib/services/api-client";
import type {
  ActionResult,
  LocationChatResponse,
  SelectionResult,
  OneLocationAccessRequest,
  OneLocationActivityRange,
  OneLocationActivityResponse,
  OneLocationCircleInvite,
  OneLocationEncryptedEnvelope,
  OneLocationGrant,
  OneLocationNetworkConnection,
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

  static async requestLocationPermission() {
    return HushhLocation.requestLocationPermission();
  }

  static async openAppSettings() {
    return HushhLocation.openAppSettings();
  }

  static async openLocationSettings() {
    return HushhLocation.openLocationSettings();
  }

  static async captureCurrentPosition(): Promise<PlainLocationPoint> {
    return HushhLocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeoutMs: 15_000,
    });
  }

  /**
   * Start continuous, movement-driven location tracking. `onPoint` fires every
   * time the device reports a new fix (as the user moves), powering true live
   * location instead of a fixed-interval re-fetch. Returns a watch id; pass it
   * to `clearLocationWatch` to stop. Foreground-only.
   */
  static async watchCurrentPosition(
    onPoint: (point: PlainLocationPoint) => void,
    onError?: (error: { message: string; code?: number }) => void,
  ): Promise<string> {
    return HushhLocation.watchPosition(
      { enableHighAccuracy: true, timeoutMs: 20_000 },
      (point, error) => {
        if (point) {
          onPoint(point);
          return;
        }
        if (error && onError) onError(error);
      },
    );
  }

  static async clearLocationWatch(id: string): Promise<void> {
    if (!id) return;
    return HushhLocation.clearWatch({ id });
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

  static async chat(params: {
    vaultOwnerToken: string;
    message?: string;
    conversationId?: string | null;
    actionResult?: ActionResult;
    selectionResult?: SelectionResult;
  }): Promise<LocationChatResponse> {
    return apiJson<LocationChatResponse>("/api/one/location/chat", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        message: params.message ?? null,
        conversationId: params.conversationId ?? null,
        actionResult: params.actionResult ?? null,
        selectionResult: params.selectionResult ?? null,
      }),
    });
  }

  static async getActivity(params: {
    vaultOwnerToken: string;
    range: OneLocationActivityRange;
  }): Promise<OneLocationActivityResponse> {
    const searchParams = new URLSearchParams({ range: params.range });
    return apiJsonWithRetry<OneLocationActivityResponse>(
      `/api/one/location/activity?${searchParams.toString()}`,
      {
        headers: jsonAuthHeaders(params.vaultOwnerToken),
      },
    );
  }

  static async createPublicInvite(params: {
    vaultOwnerToken: string;
    durationHours: number;
    locationSnapshot: PlainLocationPoint;
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
        body: JSON.stringify({
          durationHours: params.durationHours,
          locationSnapshot: params.locationSnapshot,
        }),
      },
      1,
    );
  }

  static async resolvePublicInvite(publicToken: string): Promise<{
    invite: OneLocationPublicInvite;
    publicLocation?: PlainLocationPoint | null;
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
    publicLocation?: PlainLocationPoint | null;
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

  static async createCircleInvite(params: {
    vaultOwnerToken: string;
    durationHours: number;
    message?: string;
  }): Promise<{
    invite: OneLocationCircleInvite;
    inviteToken: string;
    inviteUrl: string;
  }> {
    return apiJsonWithRetry(
      "/api/one/location/circle-invites",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          durationHours: params.durationHours,
          message: params.message,
        }),
      },
      1,
    );
  }

  static async resolveCircleInvite(inviteToken: string): Promise<{
    invite: OneLocationCircleInvite;
  }> {
    return apiJsonWithRetry(
      `/api/one/location/circle-invites/${encodeURIComponent(inviteToken)}`,
      {},
      1,
    );
  }

  static async claimCircleInvite(params: {
    vaultOwnerToken: string;
    inviteToken: string;
    message?: string;
  }): Promise<{
    invite: OneLocationCircleInvite;
    connection: OneLocationNetworkConnection;
  }> {
    return apiJsonWithRetry(
      `/api/one/location/circle-invites/${encodeURIComponent(params.inviteToken)}/claim`,
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ message: params.message }),
      },
      1,
    );
  }

  static async revokeCircleInvite(params: {
    vaultOwnerToken: string;
    inviteId: string;
  }): Promise<OneLocationCircleInvite> {
    const response = await apiJson<{ invite: OneLocationCircleInvite }>(
      `/api/one/location/circle-invites/${encodeURIComponent(params.inviteId)}`,
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
