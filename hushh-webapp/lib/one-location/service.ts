import { HushhLocation } from "@/lib/capacitor";
import {
  ApiError,
  apiErrorCode,
  apiJson,
} from "@/lib/services/api-client";
import type {
  ActionResult,
  LocationChatResponse,
  SelectionResult,
  OneLocationAccessRequest,
  OneLocationActivityRange,
  OneLocationActivityResponse,
  OneLocationCircleInvite,
  OneLocationCircleDetail,
  OneLocationCircleEligibleConnections,
  OneLocationCircleInviteCode,
  OneLocationCircleInvitePreview,
  OneLocationCircleKind,
  OneLocationCircleMemberInvite,
  OneLocationCircleSummary,
  OneLocationEncryptedEnvelope,
  OneLocationStoredEnvelope,
  OneLocationEncryptedPrivateKey,
  OneLocationNearbyAttendee,
  OneLocationNearbyPlaceCategory,
  OneLocationNearbyPlaceSuggestion,
  OneLocationNearbyPresenceState,
  OneLocationGrant,
  OneLocationMapPreferences,
  OneLocationMapState,
  OneLocationNetworkConnection,
  OneLocationPublicInvite,
  OneLocationPublicInviteSubmission,
  OneLocationRecipient,
  OneLocationReferral,
  OneLocationState,
  PlainLocationPoint,
  DriveDestination,
  RouteEta,
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

  static async requestAlwaysAuthorization() {
    return HushhLocation.requestAlwaysAuthorization();
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

  static async startBackgroundShare(
    session: import("@/lib/capacitor").BackgroundShareSession,
  ) {
    return HushhLocation.startBackgroundShare(session);
  }

  static async stopBackgroundShare(): Promise<void> {
    return HushhLocation.stopBackgroundShare();
  }


  static async registerRecipientKey(params: {
    vaultOwnerToken: string;
    keyId: string;
    publicKeyJwk: JsonWebKey;
    algorithm: string;
    encryptedPrivateKeyJwk?: OneLocationEncryptedPrivateKey | null;
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
          ...(params.encryptedPrivateKeyJwk
            ? { encryptedPrivateKeyJwk: params.encryptedPrivateKeyJwk }
            : {}),
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

  /**
   * Fetch only the canonical Location-sharing recipients.
   *
   * The workspace state contains several independent Location projections and
   * can still be loading when a voice journey reaches the mounted screen.
   * Recipient selection must not turn that loading window into a false
   * "nobody matches" result.
   */
  static async listRecipients(
    vaultOwnerToken: string,
  ): Promise<OneLocationRecipient[]> {
    const response = await apiJson<{ recipients: OneLocationRecipient[] }>(
      "/api/one/location/recipients",
      { headers: authHeaders(vaultOwnerToken) },
    );
    return response.recipients ?? [];
  }

  static async listCircles(
    vaultOwnerToken: string,
  ): Promise<OneLocationCircleSummary[]> {
    const response = await apiJson<{ circles: OneLocationCircleSummary[] }>(
      "/api/one/location/circles",
      { headers: authHeaders(vaultOwnerToken) },
    );
    return response.circles ?? [];
  }

  static async getCircle(params: {
    vaultOwnerToken: string;
    circleId: string;
  }): Promise<OneLocationCircleDetail> {
    const response = await apiJson<{ circle: OneLocationCircleDetail }>(
      `/api/one/location/circles/${encodeURIComponent(params.circleId)}`,
      { headers: authHeaders(params.vaultOwnerToken) },
    );
    return response.circle;
  }

  static async createNamedCircle(params: {
    vaultOwnerToken: string;
    name: string;
    kind: OneLocationCircleKind;
  }): Promise<OneLocationCircleDetail> {
    const response = await apiJson<{ circle: OneLocationCircleDetail }>(
      "/api/one/location/circles",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ name: params.name, kind: params.kind }),
      },
    );
    return response.circle;
  }

  /**
   * Find-or-create the caller's first Circle and return its live code.
   *
   * Takes a Firebase ID token rather than a vault owner token, because
   * onboarding runs before the vault exists — the vault is only introduced once
   * the /one/setup wizard finishes. Every other Circle call here stays
   * vault-gated; this is the single pre-vault entry point, and it can only ever
   * act on a Circle the caller owns.
   */
  static async bootstrapOnboardingCircle(params: {
    idToken: string;
    name: string;
  }): Promise<{ circleId: string; circleName: string; code: string }> {
    const response = await apiJson<{
      invite: { circleId: string; circleName: string; code: string };
    }>("/api/one/location/circles/bootstrap", {
      method: "POST",
      headers: jsonAuthHeaders(params.idToken),
      body: JSON.stringify({ name: params.name }),
    });
    return response.invite;
  }

  /**
   * Show what a circle code points at, before joining it.
   *
   * Firebase-authenticated like the bootstrap call, because someone who was
   * handed a code meets it mid-setup, before any vault exists -- which is
   * precisely the person the vault-gated resolve route would turn away.
   */
  static async previewOnboardingCircleCode(params: {
    idToken: string;
    code: string;
  }): Promise<OneLocationCircleInvitePreview> {
    const response = await apiJson<{ circle: OneLocationCircleInvitePreview }>(
      "/api/one/location/circle-codes/preview",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.idToken),
        body: JSON.stringify({ code: params.code }),
      },
    );
    return response.circle;
  }

  static async updateNamedCircle(params: {
    vaultOwnerToken: string;
    circleId: string;
    name?: string;
    kind?: OneLocationCircleKind;
  }): Promise<OneLocationCircleDetail> {
    const response = await apiJson<{ circle: OneLocationCircleDetail }>(
      `/api/one/location/circles/${encodeURIComponent(params.circleId)}`,
      {
        method: "PATCH",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          ...(params.name ? { name: params.name } : {}),
          ...(params.kind ? { kind: params.kind } : {}),
        }),
      },
    );
    return response.circle;
  }

  static async deleteNamedCircle(params: {
    vaultOwnerToken: string;
    circleId: string;
  }): Promise<void> {
    await apiJson(
      `/api/one/location/circles/${encodeURIComponent(params.circleId)}`,
      {
        method: "DELETE",
        headers: authHeaders(params.vaultOwnerToken),
      },
    );
  }

  static async createNamedCircleInviteCode(params: {
    vaultOwnerToken: string;
    circleId: string;
    rotate?: boolean;
  }): Promise<OneLocationCircleInviteCode> {
    const rotateQuery = params.rotate ? "?rotate=true" : "";
    const response = await apiJson<{
      inviteCode: OneLocationCircleInviteCode;
    }>(
      `/api/one/location/circles/${encodeURIComponent(params.circleId)}/invite-code${rotateQuery}`,
      {
        method: "POST",
        headers: authHeaders(params.vaultOwnerToken),
      },
    );
    return response.inviteCode;
  }

  static async revokeNamedCircleInviteCode(params: {
    vaultOwnerToken: string;
    circleId: string;
  }): Promise<void> {
    await apiJson(
      `/api/one/location/circles/${encodeURIComponent(params.circleId)}/invite-code`,
      {
        method: "DELETE",
        headers: authHeaders(params.vaultOwnerToken),
      },
    );
  }

  static async resolveNamedCircleCode(params: {
    vaultOwnerToken: string;
    code: string;
  }): Promise<OneLocationCircleInvitePreview> {
    const response = await apiJson<{
      preview: OneLocationCircleInvitePreview;
    }>("/api/one/location/circle-codes/resolve", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({ code: params.code }),
    });
    return response.preview;
  }

  static async joinNamedCircle(params: {
    vaultOwnerToken: string;
    code: string;
  }): Promise<{ circle: OneLocationCircleDetail; joined: boolean }> {
    return apiJson("/api/one/location/circle-codes/join", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({ code: params.code }),
    });
  }

  static async leaveNamedCircle(params: {
    vaultOwnerToken: string;
    circleId: string;
  }): Promise<void> {
    await apiJson(
      `/api/one/location/circles/${encodeURIComponent(params.circleId)}/members/me`,
      {
        method: "DELETE",
        headers: authHeaders(params.vaultOwnerToken),
      },
    );
  }

  static async removeNamedCircleMember(params: {
    vaultOwnerToken: string;
    circleId: string;
    memberUserId: string;
  }): Promise<void> {
    await apiJson(
      `/api/one/location/circles/${encodeURIComponent(params.circleId)}/members/${encodeURIComponent(params.memberUserId)}`,
      {
        method: "DELETE",
        headers: authHeaders(params.vaultOwnerToken),
      },
    );
  }

  static async listNamedCircleEligibleConnections(params: {
    vaultOwnerToken: string;
    circleId: string;
  }): Promise<OneLocationCircleEligibleConnections> {
    const response = await apiJson<{
      eligibleConnections?: OneLocationCircleEligibleConnections["eligibleConnections"];
      connections?: OneLocationCircleEligibleConnections["eligibleConnections"];
      pendingInvites?: OneLocationCircleMemberInvite[];
      remainingCapacity?: number;
    }>(
      `/api/one/location/circles/${encodeURIComponent(params.circleId)}/eligible-connections`,
      { headers: authHeaders(params.vaultOwnerToken) },
    );
    return {
      eligibleConnections:
        response.eligibleConnections ?? response.connections ?? [],
      pendingInvites: response.pendingInvites ?? [],
      remainingCapacity: Math.max(
        0,
        Number.isFinite(response.remainingCapacity)
          ? Number(response.remainingCapacity)
          : (response.eligibleConnections ?? response.connections ?? []).length,
      ),
    };
  }

  static async createNamedCircleMemberInvites(params: {
    vaultOwnerToken: string;
    circleId: string;
    inviteeUserIds: string[];
  }): Promise<OneLocationCircleMemberInvite[]> {
    const response = await apiJson<{
      invites?: OneLocationCircleMemberInvite[];
      invite?: OneLocationCircleMemberInvite;
    }>("/api/one/location/circle-member-invites", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        circleId: params.circleId,
        inviteeUserIds: params.inviteeUserIds,
      }),
    });
    return response.invites ?? (response.invite ? [response.invite] : []);
  }

  static async listNamedCircleMemberInvites(params: {
    vaultOwnerToken: string;
    direction: "incoming" | "outgoing";
    status?: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  }): Promise<OneLocationCircleMemberInvite[]> {
    const search = new URLSearchParams({
      direction: params.direction,
      status: params.status ?? "pending",
    });
    const response = await apiJson<{
      invites?: OneLocationCircleMemberInvite[];
    }>(`/api/one/location/circle-member-invites?${search.toString()}`, {
      headers: authHeaders(params.vaultOwnerToken),
    });
    return response.invites ?? [];
  }

  static async acceptNamedCircleMemberInvite(params: {
    vaultOwnerToken: string;
    inviteId: string;
  }): Promise<OneLocationCircleDetail> {
    const response = await apiJson<{ circle: OneLocationCircleDetail }>(
      `/api/one/location/circle-member-invites/${encodeURIComponent(params.inviteId)}/accept`,
      {
        method: "POST",
        headers: authHeaders(params.vaultOwnerToken),
      },
    );
    return response.circle;
  }

  static async declineNamedCircleMemberInvite(params: {
    vaultOwnerToken: string;
    inviteId: string;
  }): Promise<void> {
    await apiJson(
      `/api/one/location/circle-member-invites/${encodeURIComponent(params.inviteId)}/decline`,
      {
        method: "POST",
        headers: authHeaders(params.vaultOwnerToken),
      },
    );
  }

  static async cancelNamedCircleMemberInvite(params: {
    vaultOwnerToken: string;
    inviteId: string;
  }): Promise<void> {
    await apiJson(
      `/api/one/location/circle-member-invites/${encodeURIComponent(params.inviteId)}`,
      {
        method: "DELETE",
        headers: authHeaders(params.vaultOwnerToken),
      },
    );
  }

  static async addSmsContact(params: {
    vaultOwnerToken: string;
    recipientUserId: string;
  }): Promise<string[]> {
    const response = await apiJson<{ smsContactUserIds: string[] }>(
      "/api/one/location/sms-contacts",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ recipientUserId: params.recipientUserId }),
      },
    );
    return response.smsContactUserIds ?? [];
  }

  static async removeSmsContact(params: {
    vaultOwnerToken: string;
    recipientUserId: string;
  }): Promise<string[]> {
    const response = await apiJson<{ smsContactUserIds: string[] }>(
      `/api/one/location/sms-contacts/${encodeURIComponent(params.recipientUserId)}`,
      {
        method: "DELETE",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
      },
    );
    return response.smsContactUserIds ?? [];
  }

  /** Read-only, fresh ciphertext inventory for the immersive Your Map route. */
  static async getMapState(vaultOwnerToken: string): Promise<OneLocationMapState> {
    return apiJson<OneLocationMapState>("/api/one/location/map-state", {
      headers: authHeaders(vaultOwnerToken),
    });
  }

  /** The viewer's own map presence preference, without the marker payload. */
  static async getMapPreferences(
    vaultOwnerToken: string,
  ): Promise<OneLocationMapPreferences> {
    const response = await apiJson<{ preferences: OneLocationMapPreferences }>(
      "/api/one/location/map-preferences",
      { headers: authHeaders(vaultOwnerToken) },
    );
    return response.preferences;
  }

  static async updateMapPreferences(params: {
    vaultOwnerToken: string;
    presenceMode?: OneLocationMapPreferences["presenceMode"];
    rendererConsentVersion?: string;
  }): Promise<OneLocationMapPreferences> {
    const response = await apiJson<{ preferences: OneLocationMapPreferences }>(
      "/api/one/location/map-preferences",
      {
        method: "PATCH",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          ...(params.presenceMode ? { presenceMode: params.presenceMode } : {}),
          ...(params.rendererConsentVersion
            ? { rendererConsentVersion: params.rendererConsentVersion }
            : {}),
        }),
      },
    );
    return response.preferences;
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
    reason?: string;
    shareKind?: string;
    sourceCircleId?: string;
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
          ...(params.reason ? { reason: params.reason } : {}),
          ...(params.shareKind ? { shareKind: params.shareKind } : {}),
          ...(params.sourceCircleId
            ? { sourceCircleId: params.sourceCircleId }
            : {}),
        }),
      },
    );
    return response.grant;
  }

  /**
   * Create/replace a private share and persist its first encrypted point as one
   * idempotent backend mutation. Safe to retry with the same operation id.
   */
  static async createGrantWithEnvelope(params: {
    vaultOwnerToken: string;
    recipientUserId: string;
    recipientKeyId: string;
    durationHours: number;
    clientOperationId: string;
    confirmedAt: string;
    envelope: OneLocationEncryptedEnvelope;
    reason?: string;
    shareKind?: string;
  }): Promise<{
    grant: OneLocationGrant;
    envelope: OneLocationEncryptedEnvelope;
    idempotentReplay: boolean;
  }> {
    return apiJsonWithRetry(
      "/api/one/location/grants/with-envelope",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          recipientUserId: params.recipientUserId,
          recipientKeyId: params.recipientKeyId,
          durationHours: params.durationHours,
          clientOperationId: params.clientOperationId,
          confirmedAt: params.confirmedAt,
          envelope: params.envelope,
          ...(params.reason ? { reason: params.reason } : {}),
          ...(params.shareKind ? { shareKind: params.shareKind } : {}),
        }),
      },
      1,
    );
  }

  static async storeEnvelope(params: {
    vaultOwnerToken: string;
    grantId: string;
    envelope: OneLocationEncryptedEnvelope;
  }): Promise<OneLocationStoredEnvelope> {
    const response = await apiJson<{
      envelope: OneLocationEncryptedEnvelope;
      recipientAlerted?: boolean;
    }>(
      `/api/one/location/grants/${encodeURIComponent(params.grantId)}/envelopes`,
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ envelope: params.envelope }),
      },
    );
    return {
      envelope: response.envelope,
      // Only Save My Soul notifies from this route, so every other share kind
      // legitimately omits the field. `null` means "not reported", which callers
      // must not treat as a delivery failure.
      recipientAlerted:
        typeof response.recipientAlerted === "boolean"
          ? response.recipientAlerted
          : null,
    };
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

  /**
   * Human-readable reason a Places search / ETA lookup failed. Distinguishes the
   * common local-dev case — the backend has no `GOOGLE_MAPS_API_KEY`, so the
   * proxy returns 503 "Maps is not configured on this backend." — from a genuine
   * network failure, so the UI doesn't mislead the user into "check your
   * connection" when the real fix is a server-side key.
   */
  static placesSearchErrorMessage(error: unknown): string {
    if (error instanceof ApiError) {
      const message = String(error.message || "").toLowerCase();
      if (error.status === 503 || message.includes("not configured")) {
        return "Place search isn't set up on this server yet (missing Maps key).";
      }
    }
    return "Couldn't search places. Check your connection.";
  }

  static nearbyCheckInErrorDetails(error: unknown): {
    message: string;
    retryLocation: boolean;
    openAppSettings: boolean;
    retryPlaces?: boolean;
  } {
    const code = apiErrorCode(error);
    if (code === "NEARBY_PRESENCE_LOCATION_TOO_COARSE") {
      return {
        message: "Turn on precise location, then try again.",
        retryLocation: true,
        openAppSettings: true,
      };
    }
    if (code === "NEARBY_PRESENCE_LOCATION_STALE") {
      return {
        message: "Your location reading expired. Refresh it and try again.",
        retryLocation: true,
        openAppSettings: false,
      };
    }
    if (code === "NEARBY_PRESENCE_OUTSIDE_RADIUS") {
      return {
        message:
          "You moved outside that place's range. Choose a nearby place again.",
        retryLocation: false,
        openAppSettings: false,
        retryPlaces: true,
      };
    }
    if (code === "ONE_LOCATION_PLACE_NOT_CHECK_INABLE") {
      return {
        message:
          "This place is no longer available. Choose another nearby place.",
        retryLocation: false,
        openAppSettings: false,
        retryPlaces: true,
      };
    }
    if (code === "NEARBY_PRESENCE_PHONE_VERIFICATION_REQUIRED") {
      return {
        message: "Verify your phone number before checking in nearby.",
        retryLocation: false,
        openAppSettings: false,
      };
    }
    if (code === "NEARBY_PRESENCE_UNAVAILABLE") {
      return {
        message: "Nearby check-in is not available in this environment.",
        retryLocation: false,
        openAppSettings: false,
      };
    }
    if (error instanceof ApiError && error.status === 429) {
      return {
        message: "Too many check-in attempts. Wait a moment and try again.",
        retryLocation: false,
        openAppSettings: false,
      };
    }
    return {
      message: "Check-in didn't complete. Your location is not visible.",
      retryLocation: false,
      openAppSettings: false,
    };
  }

  static async placesAutocomplete(params: {
    vaultOwnerToken: string;
    input: string;
    sessionToken?: string;
    lat?: number;
    lng?: number;
    nearbyOnly?: boolean;
  }): Promise<OneLocationNearbyPlaceSuggestion[]> {
    const response = await apiJson<{
      suggestions: OneLocationNearbyPlaceSuggestion[];
    }>("/api/one/location/maps/autocomplete", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        input: params.input,
        ...(params.sessionToken ? { sessionToken: params.sessionToken } : {}),
        ...(typeof params.lat === "number" ? { lat: params.lat } : {}),
        ...(typeof params.lng === "number" ? { lng: params.lng } : {}),
        ...(params.nearbyOnly ? { nearbyOnly: true } : {}),
      }),
    });
    return response.suggestions ?? [];
  }

  static async nearbyPlaces(params: {
    vaultOwnerToken: string;
    lat: number;
    lng: number;
    category?: OneLocationNearbyPlaceCategory;
  }): Promise<OneLocationNearbyPlaceSuggestion[]> {
    const response = await apiJson<{
      suggestions: OneLocationNearbyPlaceSuggestion[];
    }>("/api/one/location/maps/nearby-places", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        lat: params.lat,
        lng: params.lng,
        category: params.category ?? "all",
      }),
    });
    return response.suggestions ?? [];
  }

  static async getNearbyPresence(params: {
    vaultOwnerToken: string;
  }): Promise<OneLocationNearbyPresenceState> {
    return apiJson<OneLocationNearbyPresenceState>(
      "/api/one/location/nearby-presence",
      {
        method: "GET",
        headers: authHeaders(params.vaultOwnerToken),
      },
    );
  }

  static async checkInNearby(params: {
    vaultOwnerToken: string;
    placeId: string;
    point: PlainLocationPoint;
    durationMinutes: 30 | 60 | 120;
    consentAccepted: boolean;
    allowConnectionRequests: boolean;
  }): Promise<OneLocationNearbyPresenceState> {
    return apiJson<OneLocationNearbyPresenceState>(
      "/api/one/location/nearby-presence/check-in",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          placeId: params.placeId,
          currentLat: params.point.latitude,
          currentLng: params.point.longitude,
          accuracyM: params.point.accuracyM ?? null,
          capturedAt: params.point.capturedAt,
          durationMinutes: params.durationMinutes,
          consentAccepted: params.consentAccepted,
          allowConnectionRequests: params.allowConnectionRequests,
        }),
      },
    );
  }

  static async checkoutNearby(params: {
    vaultOwnerToken: string;
  }): Promise<OneLocationNearbyPresenceState> {
    return apiJson<OneLocationNearbyPresenceState>(
      "/api/one/location/nearby-presence",
      {
        method: "DELETE",
        headers: authHeaders(params.vaultOwnerToken),
      },
    );
  }

  static async requestNearbyConnection(params: {
    vaultOwnerToken: string;
    participantAlias: string;
  }): Promise<{ relationship: OneLocationNearbyAttendee["relationship"] }> {
    return apiJson<{ relationship: OneLocationNearbyAttendee["relationship"] }>(
      "/api/one/location/nearby-presence/connection-request",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ participantAlias: params.participantAlias }),
      },
    );
  }

  static async placeDetails(params: {
    vaultOwnerToken: string;
    placeId: string;
  }): Promise<DriveDestination> {
    const response = await apiJson<{ place: DriveDestination }>(
      "/api/one/location/maps/place-details",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ placeId: params.placeId }),
      },
    );
    return response.place;
  }

  static async reverseGeocode(params: {
    vaultOwnerToken: string;
    lat: number;
    lng: number;
  }): Promise<{
    name: string | null;
    formattedAddress: string | null;
    countryCode: string | null;
  }> {
    const response = await apiJson<{
      place: {
        name: string | null;
        formattedAddress: string | null;
        countryCode: string | null;
      };
    }>("/api/one/location/maps/reverse-geocode", {
      method: "POST",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({ lat: params.lat, lng: params.lng }),
    });
    return response.place;
  }

  static async routeEta(params: {
    vaultOwnerToken: string;
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
  }): Promise<RouteEta> {
    const response = await apiJson<{ eta: RouteEta }>(
      "/api/one/location/maps/route-eta",
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          originLat: params.originLat,
          originLng: params.originLng,
          destLat: params.destLat,
          destLng: params.destLng,
        }),
      },
    );
    return response.eta;
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
