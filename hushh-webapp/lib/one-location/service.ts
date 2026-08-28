import { Capacitor } from "@capacitor/core";

import { HushhLocation } from "@/lib/capacitor";
import {
  LocationBus,
  type LocationSnapshot,
} from "@/lib/one-location/location-bus";
import type { AutoApproveScope } from "@/lib/one-location/location-control-state";
import { resolveRuntimeFrontendUrl } from "@/lib/runtime/settings";
import { ApiError, apiErrorCode, apiJson } from "@/lib/services/api-client";
import type {
  ActionResult,
  LocationChatResponse,
  SelectionResult,
  OneLocationAccessRequest,
  OneLocationActivityRange,
  OneLocationActivityResponse,
  OneLocationAutoApprovePreference,
  OneLocationCircleInvite,
  OneLocationCircleDetail,
  OneLocationCircleEligibleConnections,
  OneLocationCircleEligibleConnectionsPage,
  OneLocationCircleInviteCode,
  OneLocationCircleInvitePreview,
  OneLocationCircleKind,
  OneLocationCircleMemberInvite,
  OneLocationCircleMemberPage,
  OneLocationCircleOverview,
  OneLocationCircleSummary,
  OneLocationEncryptedEnvelope,
  OneLocationStoredEnvelope,
  OneLocationEncryptedPrivateKey,
  OneLocationNearbyAttendee,
  OneLocationNearbyCheckInPreference,
  OneLocationNearbyPlaceCategory,
  OneLocationNearbyPlaceSuggestion,
  OneLocationNearbyPresenceState,
  OneLocationSosVoicePreference,
  OneLocationGrant,
  OneLocationMapPreferences,
  OneLocationMapState,
  OneLocationNetworkConnection,
  OneLocationPublicInvite,
  OneLocationPublicInviteSubmission,
  OneLocationRecipient,
  OneLocationRecipientPage,
  OneLocationReferral,
  OneLocationShareDurationMode,
  OneLocationState,
  PlainLocationPoint,
  DriveDestination,
  RouteEta,
} from "@/lib/one-location/types";

function authHeaders(vaultOwnerToken: string): Record<string, string> {
  return { Authorization: `Bearer ${vaultOwnerToken}` };
}

/**
 * Origin prefix for a route served by the Next.js app rather than the Python
 * backend. Empty on web (relative is correct); the web origin on native, where
 * a relative path would otherwise resolve against the backend.
 */
function nextRouteOrigin(): string {
  return Capacitor.isNativePlatform() ? resolveRuntimeFrontendUrl() : "";
}

function jsonAuthHeaders(vaultOwnerToken: string): Record<string, string> {
  return {
    ...authHeaders(vaultOwnerToken),
    "Content-Type": "application/json",
  };
}

let locationMutationSequence = 0;

function newLocationMutationOperationId(prefix: string): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  }
  locationMutationSequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${locationMutationSequence.toString(36)}`;
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

/**
 * How long a captured fix stays reusable. Deliberately well under the 60s the
 * backend allows between capture and confirmation, so a reused point still
 * passes the server's freshness check and still describes where the user
 * actually is.
 */
export const CAPTURE_DEFAULT_MAX_AGE_MS = 20_000;

/**
 * The window for a caller that needs a fix describing where the user is *now*
 * — dropping a pin, saving a place, anchoring a check-in.
 *
 * Deliberately a few seconds rather than zero. `maxAgeMs: 0` forces a full
 * device acquisition on every press, and on a laptop with no GPS that is well
 * over a second of dead time before any UI appears. But a fix taken five
 * seconds ago is not meaningfully different: at walking pace that is about
 * seven metres, comfortably inside the 10-35m accuracy the device reports
 * anyway. So the "fresh" reading and the reused one describe the same place,
 * and one of them is free.
 *
 * Zero is still correct for the live-share publisher — nobody is waiting on it,
 * and a recipient watching someone move must see the newest fix there is.
 */
export const CAPTURE_FRESH_MAX_AGE_MS = 5_000;

/**
 * How old a fix may be and still be served after the device failed to produce
 * a new one.
 *
 * A different question from the caller's `maxAgeMs`, which asks "may I skip
 * the GPS?" — five or twenty seconds is right for that, and using it here
 * would make this fallback fire essentially never, which is the bug. This asks
 * "the device just failed and I am holding a position: is it still an honest
 * answer to where you are?" Ten minutes is the budget this codebase already
 * chose for exactly that question, in the nearby check-in sheet.
 */
export const CAPTURE_STALE_FALLBACK_MAX_AGE_MS = 10 * 60 * 1_000;

function resolveSourcePlatform(): PlainLocationPoint["sourcePlatform"] {
  const platform = Capacitor.getPlatform();
  if (platform === "ios" || platform === "android") return platform;
  return "web";
}

/**
 * A bus snapshot as the point every caller here expects.
 *
 * `sourcePlatform` falls back to the running platform only when the snapshot
 * does not carry one — a floor, not a guess that overrides the truth. The
 * field is sealed into the envelope and rendered to the recipient, so it must
 * never be absent.
 */
function toPlainPoint(snapshot: LocationSnapshot): PlainLocationPoint {
  return {
    latitude: snapshot.latitude,
    longitude: snapshot.longitude,
    accuracyM: snapshot.accuracyM ?? null,
    capturedAt: snapshot.capturedAt,
    sourcePlatform: snapshot.sourcePlatform ?? resolveSourcePlatform(),
  };
}

function withinAge(capturedAt: string, maxAgeMs: number): boolean {
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return false;
  const age = Date.now() - capturedMs;
  return age >= 0 && age <= maxAgeMs;
}

/** Live bus-backed watches, keyed by the id handed to the caller. */
const busWatches = new Map<string, () => void>();
let busWatchSeq = 0;

function captureFailure(state: { error: string | null }): Error {
  const original = LocationBus.getLastCaptureError();
  if (original instanceof Error) return original;
  return new Error(state.error ?? "Could not get your location.");
}

/**
 * Read a paged payload's list HERE, at the boundary, rather than leaving it to
 * the caller.
 *
 * Every caller hands the list straight to a React state updater --
 * `setPagedRecipientsByUserId((current) => { for (const row of result.items)
 * ... })`. React invokes those updaters AFTER the awaited call has returned,
 * which is outside the caller's own `try`/`catch` and outside any `.catch()` on
 * the promise. So a payload with no list never reaches the handler written for
 * exactly that case: it escapes as an unhandled render error and takes the
 * whole page down. `/one/location` died this way on `result.items is not
 * iterable` when a backend answered 200 with the unpaged `{ recipients: [...] }`
 * shape that this same route also returns.
 *
 * It throws rather than coercing to an empty page -- unlike the
 * `eligibleConnections ?? []` read further down -- and the difference is
 * deliberate. Every caller's catch keeps the LAST GOOD page; an empty array
 * would replace it. On a screen whose only job is choosing people, "no one" is
 * a worse answer than "that read failed", because it looks like data.
 */
function pagedItems<T>(payload: { items?: T[] } | null, endpoint: string): T[] {
  if (!Array.isArray(payload?.items)) {
    throw new ApiError(
      `Malformed paged response from ${endpoint}: expected an "items" array.`,
      200,
      payload,
    );
  }
  return payload.items;
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

  /**
   * The account's current position, from the one store that holds it.
   *
   * This used to keep its own cache — a fix and an in-flight promise, twenty
   * seconds of reuse — parallel to and unaware of `LocationBus`. Two stores
   * for one question, and the whole One Location surface was on this one,
   * which had none of the bus's resilience: no memory across a reload, and no
   * answer at all when the device declined to produce a fix. Every caller here
   * inherited that. The heartbeat published the result once every twenty
   * seconds: "Could not get your location", while a movement watch two effects
   * away was delivering fixes the entire time.
   *
   * Delegating gets all of it at once — coalescing, the restored fix from the
   * previous session, and the distinction between a device that refused and a
   * device that merely did not answer this time.
   *
   * `maxAgeMs` is forwarded rather than left to the bus's own default: the bus
   * allows two minutes, and the backend rejects a point older than sixty
   * seconds between capture and confirmation, so a share built on the bus
   * default would fail for a reason the owner cannot see.
   */
  static async captureCurrentPosition(options?: {
    maxAgeMs?: number;
    /**
     * "I need a fix that describes where the user is right now" — dropping a
     * pin, saving a place, anchoring a check-in.
     *
     * Prefer this over `maxAgeMs: 0` at a call site. It says what the caller
     * needs rather than a number, and it keeps the freshness policy in one
     * place. It is also deliberately not importable state: a caller that had to
     * import a constant from this module would break the moment a test mocked
     * the module without re-exporting it.
     */
    fresh?: boolean;
  }): Promise<PlainLocationPoint> {
    const maxAgeMs =
      options?.maxAgeMs ??
      (options?.fresh ? CAPTURE_FRESH_MAX_AGE_MS : CAPTURE_DEFAULT_MAX_AGE_MS);

    const snapshot = await LocationBus.ensure({ maxAgeMs });
    // Read the state AFTER the await, never a copy taken before it: a watch
    // fix can land while this call is in flight, and the newer answer is the
    // right one to serve.
    const state = LocationBus.getState();

    if (snapshot && state.status === "ready") return toPlainPoint(snapshot);

    // The device failed and we are holding a position. A failed refresh is not
    // a location we do not have, and until now the two were indistinguishable
    // to every caller on this surface — which is what put "turn on location"
    // in front of people whose location was perfectly well known.
    if (
      snapshot &&
      withinAge(snapshot.capturedAt, CAPTURE_STALE_FALLBACK_MAX_AGE_MS)
    ) {
      return toPlainPoint(snapshot);
    }

    // Two things still throw, and both are dead ends the owner has to see: a
    // platform that refused (the bus returns null on a denial even while
    // holding a fix, so this is reached), and having no position at all.
    throw captureFailure(state);
  }

  /**
   * Declare the held fix untrustworthy. Call when the device may have moved
   * without us — a permission change, or the app returning from background.
   *
   * The position stays on screen; only its right to satisfy the next call
   * without re-reading the device is revoked.
   */
  static invalidateCapturedPosition(): void {
    LocationBus.invalidate();
  }

  /** Test seam. Never call from app code. */
  static __resetCaptureCacheForTests(): void {
    LocationBus.__resetForTests();
  }

  /**
   * Start continuous, movement-driven location tracking. `onPoint` fires every
   * time the device reports a new fix (as the user moves), powering true live
   * location instead of a fixed-interval re-fetch. Returns a watch id; pass it
   * to `clearLocationWatch` to stop. Foreground-only.
   *
   * Backed by the bus's refcounted watch rather than a device subscription of
   * its own. The Location page starts two of these — one to publish movement,
   * one to draw the owner's own marker — and each used to open a separate OS
   * watch. On iOS that matters beyond battery: the plugin holds exactly one
   * pending location call, and a second request rejects the first with "A
   * newer location request replaced this request", which arrived in the
   * publisher's catch as a location failure.
   *
   * Adapting here rather than at the two call sites means any other caller
   * that appears also feeds the shared store instead of competing with it.
   */
  static async watchCurrentPosition(
    onPoint: (point: PlainLocationPoint) => void,
    onError?: (error: { message: string; code?: number }) => void,
  ): Promise<string> {
    const stop = await LocationBus.watch();
    const id = `bus:${++busWatchSeq}`;
    let lastSeenAt: string | null = null;

    const unsubscribe = LocationBus.subscribe((state) => {
      if (state.snapshot && state.snapshotOrigin === "fresh") {
        // subscribe() fires on every emit, including a permission-only one.
        // Without this the same coordinate would be re-delivered as movement.
        if (state.snapshot.capturedAt === lastSeenAt) return;
        lastSeenAt = state.snapshot.capturedAt;
        onPoint(toPlainPoint(state.snapshot));
        return;
      }
      if (state.status === "denied" && onError) {
        onError({ message: state.error ?? "Location is off.", code: 1 });
      }
    });

    busWatches.set(id, () => {
      unsubscribe();
      stop();
    });
    return id;
  }

  static async clearLocationWatch(id: string): Promise<void> {
    const release = busWatches.get(id);
    if (release) {
      busWatches.delete(id);
      release();
      return;
    }
    // A raw plugin id from a watch started before this adapter existed.
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

  static async updateAutoApprovePreference(params: {
    vaultOwnerToken: string;
    enabled: boolean;
    scope?: AutoApproveScope | null;
  }): Promise<OneLocationAutoApprovePreference> {
    const response = await apiJson<{
      preference: OneLocationAutoApprovePreference;
    }>("/api/one/location/auto-approve-preference", {
      method: "PATCH",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        enabled: params.enabled,
        scopeKind: params.enabled ? params.scope?.kind : undefined,
        circleId:
          params.enabled && params.scope?.kind === "circle"
            ? params.scope.circleId
            : undefined,
      }),
    });
    return response.preference;
  }

  static async getNearbyCheckInPreferences(
    vaultOwnerToken: string,
  ): Promise<OneLocationNearbyCheckInPreference> {
    const response = await apiJson<{
      preferences: OneLocationNearbyCheckInPreference;
    }>("/api/one/location/nearby-check-in-preferences", {
      headers: jsonAuthHeaders(vaultOwnerToken),
    });
    return response.preferences;
  }

  static async updateNearbyCheckInPreferences(params: {
    vaultOwnerToken: string;
    visible: boolean;
    allowConnectionRequests: boolean;
  }): Promise<OneLocationNearbyCheckInPreference> {
    const response = await apiJson<{
      preferences: OneLocationNearbyCheckInPreference;
    }>("/api/one/location/nearby-check-in-preferences", {
      method: "PATCH",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        visible: params.visible,
        allowConnectionRequests: params.allowConnectionRequests,
      }),
    });
    return response.preferences;
  }

  static async getSosVoicePreference(
    vaultOwnerToken: string,
  ): Promise<OneLocationSosVoicePreference> {
    const response = await apiJson<{
      preference: OneLocationSosVoicePreference;
    }>("/api/one/location/sos-voice-preference", {
      headers: jsonAuthHeaders(vaultOwnerToken),
    });
    return response.preference;
  }

  static async updateSosVoicePreference(params: {
    vaultOwnerToken: string;
    defaultAction: OneLocationSosVoicePreference["defaultAction"];
  }): Promise<OneLocationSosVoicePreference> {
    const response = await apiJson<{
      preference: OneLocationSosVoicePreference;
    }>("/api/one/location/sos-voice-preference", {
      method: "PATCH",
      headers: jsonAuthHeaders(params.vaultOwnerToken),
      body: JSON.stringify({
        defaultAction: params.defaultAction,
      }),
    });
    return response.preference;
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

  static async listRecipientsPage(params: {
    vaultOwnerToken: string;
    page?: number;
    limit?: number;
    query?: string;
  }): Promise<OneLocationRecipientPage> {
    const search = new URLSearchParams({
      page: String(params.page ?? 1),
      limit: String(params.limit ?? 50),
    });
    if (params.query?.trim()) search.set("query", params.query.trim());
    const endpoint = `/api/one/location/recipients?${search.toString()}`;
    const payload = await apiJson<Partial<OneLocationRecipientPage>>(endpoint, {
      headers: authHeaders(params.vaultOwnerToken),
    });
    const items = pagedItems(payload, "/api/one/location/recipients");
    return {
      items,
      page: Math.max(1, Number(payload.page ?? params.page ?? 1)),
      hasMore: Boolean(payload.hasMore),
      totalCount: Math.max(0, Number(payload.totalCount ?? items.length)),
    };
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

  static async getCircleOverview(params: {
    vaultOwnerToken: string;
    circleId: string;
  }): Promise<OneLocationCircleOverview> {
    const response = await apiJson<{ circle: OneLocationCircleOverview }>(
      `/api/one/location/circles/${encodeURIComponent(params.circleId)}/overview`,
      { headers: authHeaders(params.vaultOwnerToken) },
    );
    return response.circle;
  }

  static async listCircleMembersPage(params: {
    vaultOwnerToken: string;
    circleId: string;
    page?: number;
    limit?: number;
    query?: string;
  }): Promise<OneLocationCircleMemberPage> {
    const search = new URLSearchParams({
      page: String(params.page ?? 1),
      limit: String(params.limit ?? 50),
    });
    if (params.query?.trim()) search.set("query", params.query.trim());
    const route = `/api/one/location/circles/${encodeURIComponent(params.circleId)}/members`;
    const payload = await apiJson<Partial<OneLocationCircleMemberPage>>(
      `${route}?${search.toString()}`,
      { headers: authHeaders(params.vaultOwnerToken) },
    );
    const items = pagedItems(payload, route);
    return {
      items,
      page: Math.max(1, Number(payload.page ?? params.page ?? 1)),
      hasMore: Boolean(payload.hasMore),
      totalCount: Math.max(0, Number(payload.totalCount ?? items.length)),
    };
  }

  /**
   * Find-or-create the SMS/Emergency Circle and migrate legacy contacts in.
   *
   * Safe to call on every bootstrap: the second and every later call return the
   * same Circle, and a contact the owner has since removed is not re-added.
   */
  static async ensureSmsSystemCircle(params: {
    vaultOwnerToken: string;
  }): Promise<OneLocationCircleDetail> {
    const response = await apiJson<{ circle: OneLocationCircleDetail }>(
      "/api/one/location/circles/sms-system",
      { method: "POST", headers: authHeaders(params.vaultOwnerToken) },
    );
    return response.circle;
  }

  /**
   * Find-or-create the Trusted Circle and top up its roster.
   *
   * The accept hook writes both sides of a NEW connection, so a pair that
   * connects from here on needs nothing else. What it cannot do is account for
   * the connections somebody already had: without this call, a person with
   * forty of them sees no Trusted Circle at all until their next accept, and
   * then sees one holding a single name under the words "Everyone you're
   * connected to" -- which is worse than not showing it.
   *
   * So the list reconciles before it reads. Safe on every call: the reconcile
   * adds only connections with no membership row of ANY status, so a removal
   * stays removed.
   */
  static async ensureTrustedSystemCircle(params: {
    vaultOwnerToken: string;
    summaryOnly?: boolean;
  }): Promise<OneLocationCircleDetail | OneLocationCircleOverview> {
    const response = await apiJson<{
      circle: OneLocationCircleDetail | OneLocationCircleOverview;
    }>(
      `/api/one/location/circles/trusted${params.summaryOnly ? "?summaryOnly=true" : ""}`,
      { method: "POST", headers: authHeaders(params.vaultOwnerToken) },
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

  static async listNamedCircleEligibleConnectionsPage(params: {
    vaultOwnerToken: string;
    circleId: string;
    page?: number;
    limit?: number;
    query?: string;
  }): Promise<OneLocationCircleEligibleConnectionsPage> {
    const search = new URLSearchParams({
      page: String(params.page ?? 1),
      limit: String(params.limit ?? 50),
    });
    if (params.query?.trim()) search.set("query", params.query.trim());
    const response = await apiJson<{
      eligibleConnections?: OneLocationCircleEligibleConnections["eligibleConnections"];
      connections?: OneLocationCircleEligibleConnections["eligibleConnections"];
      pendingInvites?: OneLocationCircleMemberInvite[];
      remainingCapacity?: number;
      page?: number;
      hasMore?: boolean;
      totalCount?: number;
    }>(
      `/api/one/location/circles/${encodeURIComponent(params.circleId)}/eligible-connections?${search.toString()}`,
      { headers: authHeaders(params.vaultOwnerToken) },
    );
    const eligibleConnections =
      response.eligibleConnections ?? response.connections ?? [];
    return {
      eligibleConnections,
      pendingInvites: response.pendingInvites ?? [],
      remainingCapacity: Math.max(0, Number(response.remainingCapacity ?? 0)),
      page: Math.max(1, Number(response.page ?? params.page ?? 1)),
      hasMore: Boolean(response.hasMore),
      totalCount: Math.max(
        0,
        Number(response.totalCount ?? eligibleConnections.length),
      ),
    };
  }

  /**
   * Add people to a Circle, and say who actually went in.
   *
   * The name is history: this once created pending invitations, and the server
   * still answers on a route called `circle-member-invites`. It adds outright
   * now -- `create_member_invites` writes the memberships and marks any open
   * invitation `accepted` with `resolvedBy: "direct_add"` -- and it returns
   * `invites: []` unconditionally alongside an `added` array of user ids.
   *
   * This read only `invites`, so it returned an empty array from a call that
   * had just added several people. Nothing broke, because the one caller
   * ignores the result; the next caller would have believed it.
   *
   * Returns the user ids that went in. `invites` is still read as a fallback
   * so a build talking to a server that predates `added` keeps working.
   */
  static async createNamedCircleMemberInvites(params: {
    vaultOwnerToken: string;
    circleId: string;
    inviteeUserIds: string[];
  }): Promise<string[]> {
    const response = await apiJson<{
      added?: string[];
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
    if (Array.isArray(response.added)) {
      return response.added
        .map((userId) => String(userId || "").trim())
        .filter(Boolean);
    }
    const legacy =
      response.invites ?? (response.invite ? [response.invite] : []);
    return legacy
      .map((invite) => String(invite?.inviteeUserId || "").trim())
      .filter(Boolean);
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
  static async getMapState(
    vaultOwnerToken: string,
  ): Promise<OneLocationMapState> {
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
    /**
     * True when the server handed back the link that was already live rather
     * than minting a second one. Its window is restarted for the duration that
     * was just asked for, so the link is honestly "live for an hour" either
     * way -- but it is the SAME URL, and anyone already holding it keeps
     * watching. Worth saying out loud rather than reporting "link created".
     */
    reused?: boolean;
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

  /**
   * Move the pin on the caller's own live public link to where they are now.
   *
   * The snapshot used to be written once, at create time, and never again, so
   * a link shared as a live location showed one frozen point for its whole
   * window. The owner's foreground heartbeat calls this while a public link is
   * live.
   *
   * Writes the position and nothing else: the server refuses to touch
   * `expiresAt` here, so a heartbeat can never extend a window past what the
   * owner agreed to share.
   */
  static async refreshPublicInviteLocation(params: {
    vaultOwnerToken: string;
    inviteId: string;
    locationSnapshot: PlainLocationPoint;
  }): Promise<{ invite: OneLocationPublicInvite }> {
    return apiJson(
      `/api/one/location/public-invites/${encodeURIComponent(params.inviteId)}/location`,
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({ locationSnapshot: params.locationSnapshot }),
      },
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
    durationHours?: number | null;
    durationMode?: OneLocationShareDurationMode;
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
          ...(typeof params.durationHours === "number"
            ? { durationHours: params.durationHours }
            : {}),
          ...(params.durationMode ? { durationMode: params.durationMode } : {}),
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
   * Second channel for a Save my Soul alert: email the contacts of the grants
   * this alert just created.
   *
   * The push notification is the first channel and it reaches nobody when a
   * contact has notifications off or has uninstalled — an email survives both.
   *
   * The coordinates travel in this request because the server cannot read them
   * anywhere else: location envelopes keep coordinates inside the ciphertext,
   * so only this device holds the plaintext. They are used for one send and
   * are not stored server-side.
   *
   * Resolves rather than throws on failure. It is called after the alert has
   * already gone out, so a mail problem must never surface as a failed SOS.
   */
  static async sendSosEmails(params: {
    vaultOwnerToken: string;
    grantIds: string[];
    latitude: number;
    longitude: number;
    accuracyM?: number | null;
    /**
     * When the position was measured. Save my Soul sends the last known
     * position rather than nothing when the device will not produce a new one,
     * so the email has to be able to say how old it is — an unstamped
     * twenty-minute-old coordinate presented as "now" sends help confidently
     * to the wrong place.
     */
    capturedAt?: string | null;
    note?: string | null;
    emergencyNumber?: string | null;
  }): Promise<{
    emailed: number;
    attempted: number;
    configured: boolean;
    /** Contacts on this alert with no email on file, by display name. */
    withoutEmail: string[];
  }> {
    const fallback = {
      emailed: 0,
      attempted: 0,
      configured: false,
      withoutEmail: [] as string[],
    };
    if (!params.grantIds.length) return fallback;
    try {
      const response = await apiJson<{
        emailed?: number;
        attempted?: number;
        configured?: boolean;
        withoutEmail?: string[];
        // Unlike every other call in this file, this one does NOT go to the
        // Python backend — it is a Next.js route (only the webapp lane holds
        // MAIL_API_KEY). On native, a relative path resolves against the
        // backend, where this path does not exist, so the alert's email leg
        // would 404 on iOS and Android — the two platforms an SOS is most
        // likely to be sent from. Same treatment as `/api/auth/mail`.
      }>(`${nextRouteOrigin()}/api/one/location/sos-email`, {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          grantIds: params.grantIds,
          latitude: params.latitude,
          longitude: params.longitude,
          ...(typeof params.accuracyM === "number"
            ? { accuracyM: params.accuracyM }
            : {}),
          ...(params.capturedAt ? { capturedAt: params.capturedAt } : {}),
          ...(params.note ? { note: params.note } : {}),
          ...(params.emergencyNumber
            ? { emergencyNumber: params.emergencyNumber }
            : {}),
        }),
      });
      return {
        emailed: Number(response?.emailed ?? 0),
        attempted: Number(response?.attempted ?? 0),
        configured: response?.configured === true,
        withoutEmail: Array.isArray(response?.withoutEmail)
          ? response.withoutEmail.map(String).filter(Boolean)
          : [],
      };
    } catch {
      return fallback;
    }
  }

  /**
   * Create/replace a private share and persist its first encrypted point as one
   * idempotent backend mutation. Safe to retry with the same operation id.
   */
  static async createGrantWithEnvelope(params: {
    vaultOwnerToken: string;
    recipientUserId: string;
    recipientKeyId: string;
    durationHours?: number | null;
    durationMode?: OneLocationShareDurationMode;
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
          ...(typeof params.durationHours === "number"
            ? { durationHours: params.durationHours }
            : {}),
          ...(params.durationMode ? { durationMode: params.durationMode } : {}),
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

  /**
   * Latest ciphertext for a share we receive.
   *
   * `allow_empty=1` asks the backend to answer "the share is live but the owner
   * hasn't published a point yet" with `200 { envelope: null }` instead of a
   * `404 LOCATION_ENVELOPE_MISSING`. That state is a normal step on the happy
   * path — the recipient almost always opens One before the owner's first GPS
   * fix lands — and a 404 makes the browser log a failed request every poll for
   * something that was never an error. The flag is opt-in per request so
   * already-shipped native bundles keep the legacy contract they branch on.
   */
  static async viewEnvelope(params: {
    vaultOwnerToken: string;
    grantId: string;
  }): Promise<{
    grant: OneLocationGrant;
    envelope: OneLocationEncryptedEnvelope | null;
    status?: "published" | "awaiting_first_publish" | string;
  }> {
    return apiJson(
      `/api/one/location/grants/${encodeURIComponent(
        params.grantId,
      )}/envelope?allow_empty=1`,
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

  /**
   * Bring a grant's expiry earlier. Either the owner or the recipient may
   * call this -- shortening only ever reduces exposure, so it needs no
   * fresh consent from the other side. The backend rejects any duration
   * that would move the expiry later; extending access is the owner's
   * consent to give again, via `requestAccess`, not something either side
   * can grant themselves through this call.
   */
  static async shortenGrant(params: {
    vaultOwnerToken: string;
    grantId: string;
    durationHours: number;
    clientOperationId?: string;
  }): Promise<OneLocationGrant> {
    const clientOperationId =
      params.clientOperationId || newLocationMutationOperationId("loc_shorten");
    const response = await apiJsonWithRetry<{ grant: OneLocationGrant }>(
      `/api/one/location/grants/${encodeURIComponent(params.grantId)}/shorten`,
      {
        method: "PATCH",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          durationHours: params.durationHours,
          clientOperationId,
        }),
      },
    );
    return response.grant;
  }

  /**
   * Ask an owner for location access, for a specific amount of time.
   *
   * `requestedDurationHours` is what the person actually picked. It used to be
   * collected by the Ask screen and dropped at this boundary, so the owner was
   * asked an unquantified question and approved whatever their own control
   * happened to say. It is a REQUEST, never an authorization — the grant is
   * still written only when the owner approves.
   *
   * `extendsGrantId` marks this as extra time on a share already running. The
   * backend verifies it against the real grant between the two people and
   * detects the extension itself if it is omitted, so passing it is a hint that
   * sharpens the copy, never something a caller can use to claim time.
   */

  /**
   * Set a new end time on a share you own, longer or shorter.
   *
   * `shortenGrant` above is the recipient's control and stays shorten-only.
   * This one is the owner's, and it is allowed to add time because the owner
   * is the person whose location is being shown -- there is no second party
   * whose consent would be missing. The server enforces that by matching on
   * the owner alone.
   *
   * `durationHours` is null when `durationMode` is "until_stopped".
   */
  static async setGrantDuration(params: {
    vaultOwnerToken: string;
    grantId: string;
    durationHours: number | null;
    durationMode: OneLocationShareDurationMode;
    clientOperationId?: string;
  }): Promise<OneLocationGrant> {
    const clientOperationId =
      params.clientOperationId ||
      newLocationMutationOperationId("loc_duration");
    const response = await apiJsonWithRetry<{ grant: OneLocationGrant }>(
      `/api/one/location/grants/${encodeURIComponent(params.grantId)}/duration`,
      {
        method: "PATCH",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          durationHours: params.durationHours,
          durationMode: params.durationMode,
          clientOperationId,
        }),
      },
    );
    return response.grant;
  }

  static async requestAccess(params: {
    vaultOwnerToken: string;
    ownerUserId: string;
    message?: string;
    requestedDurationHours?: number | null;
    requestedDurationMode?: string | null;
    extendsGrantId?: string | null;
  }): Promise<OneLocationAccessRequest> {
    const durationHours = Number(params.requestedDurationHours);
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
          requestedDurationHours:
            Number.isFinite(durationHours) && durationHours > 0
              ? durationHours
              : undefined,
          requestedDurationMode: params.requestedDurationMode || undefined,
          extendsGrantId: params.extendsGrantId || undefined,
        }),
      },
      1,
    );
    return response.request;
  }

  /**
   * Approve a pending request. Omitting `durationHours` grants exactly what was
   * asked for — the owner pressed a button that named the amount, so re-deriving
   * a different one from a control they never touched is how an approval used to
   * hand an hour to someone who had asked for four.
   */
  static async approveRequest(params: {
    vaultOwnerToken: string;
    requestId: string;
    approvalMode: "manual" | "automatic";
    durationHours?: number | null;
    durationMode?: string | null;
    /** Current server-owned standing-rule version. Omit for manual approval. */
    autoApproveRuleVersion?: number | null;
  }): Promise<{
    request: OneLocationAccessRequest;
    grant: OneLocationGrant;
    recipient?: OneLocationRecipient;
  }> {
    const durationHours = Number(params.durationHours);
    return apiJson(
      `/api/one/location/requests/${encodeURIComponent(params.requestId)}/approve`,
      {
        method: "POST",
        headers: jsonAuthHeaders(params.vaultOwnerToken),
        body: JSON.stringify({
          approvalMode: params.approvalMode,
          durationHours:
            Number.isFinite(durationHours) && durationHours > 0
              ? durationHours
              : undefined,
          durationMode: params.durationMode || undefined,
          // Preserve 0 so the backend rejects a malformed/stale automatic
          // context. Omitting it would downgrade the same call to an explicit
          // manual approval and bypass standing-rule validation.
          autoApproveRuleVersion: params.autoApproveRuleVersion ?? undefined,
        }),
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

  /**
   * Take back a pending request you sent.
   *
   * Not the same call as `denyRequest`, which is the OWNER refusing an ask
   * made of them. The backend keys this one on the requester, so it can only
   * ever end a request the caller themselves sent.
   */
  static async withdrawRequest(params: {
    vaultOwnerToken: string;
    requestId: string;
  }): Promise<OneLocationAccessRequest> {
    const response = await apiJson<{ request: OneLocationAccessRequest }>(
      `/api/one/location/requests/${encodeURIComponent(params.requestId)}/withdraw`,
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
