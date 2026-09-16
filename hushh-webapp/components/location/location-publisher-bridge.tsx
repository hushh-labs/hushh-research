"use client";

/**
 * App-level Location publisher for the voice-first area.
 *
 * Mounted ONCE (AgentOwnerGate) while Live is on, so publishing survives
 * navigation. It owns three things:
 *
 *  1. The continuous watch -> coarsen -> encrypt -> storeEnvelope loop for
 *     every active owner grant, gated by `effective === "sharing"` (server
 *     `sharing_state === "on"` AND OS granted AND not paused). The moment
 *     app sharing turns off — a `turn_sharing_off` tool result, a resolved
 *     tap confirmation, or the settings resource changing — the watch is
 *     cleared and native background sharing is stopped.
 *  2. The `publish_location_envelopes` / `register_recipient_key` /
 *     `report_os_permission` client steps the relay asks the device to run.
 *  3. The `request_os_permission` directive, which is REFUSED unless the
 *     server-side setup progress shows consent was accepted first.
 *
 * No UI. Success is reported to the relay only from what actually happened
 * (a stored envelope, a registered key, the OS's own answer).
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Capacitor } from "@capacitor/core";

import { useAuth } from "@/hooks/use-auth";
import {
  LocationAccountSettingsResource,
  useLocationAccountSettings,
  type LocationOsPermissionReported,
} from "@/lib/location/account-settings";
import {
  resolvePublishPrecision,
  type LocationPublishPrecision,
} from "@/lib/location/coarsen";
import {
  indexRecipientsByUserId,
  publishPointToGrants,
  type PublishFailure,
} from "@/lib/location/publisher";
import {
  getSetupProgress,
  LocationSetupProgressResource,
} from "@/lib/location/setup-progress";
import {
  activeOwnerGrants,
  useLocationSharingState,
  useOneLocationStateSnapshot,
} from "@/lib/location/sharing-state";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { buildBackgroundShareSession } from "@/lib/one-location/background-share";
import { syncBackgroundShare } from "@/lib/one-location/background-share-runtime";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import {
  LocationBus,
  type LocationPermission,
} from "@/lib/one-location/location-bus";
import { resolveLocationRecoveryGuide } from "@/lib/one-location/location-permission-recovery";
import { isLocationPermissionDeniedError } from "@/lib/one-location/location-readiness";
import { haversineMeters } from "@/lib/one-location/marker-interpolation";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationGrant,
  OneLocationState,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import type { ToolResultPublic } from "@/lib/one-voice/protocol";
import {
  useVoiceSessionStore,
  useVoiceToolEffects,
} from "@/lib/one-voice/session-store";
import type { ClientStepView } from "@/lib/one-voice/session-types";
import { getApiBaseUrl } from "@/lib/services/api-service";
import { useVault } from "@/lib/vault/vault-context";

/** Same movement gate the hub used: no re-publish for GPS jitter. */
export const LIVE_LOCATION_MIN_MOVE_METERS = 25;
export const LIVE_LOCATION_MIN_PUBLISH_INTERVAL_MS = 8_000;
/** A held fix this old is still an honest answer for `point_policy: held_ok`. */
const HELD_OK_MAX_AGE_MS = 55_000;

/** Window event other owners dispatch after a tool result asks for a refresh. */
export const ONE_VOICE_REFRESH_EVENT = "one-voice:refresh";

const PUBLISH_STEP = "publish_location_envelopes";
const REGISTER_KEY_STEP = "register_recipient_key";
const REPORT_OS_PERMISSION_STEP = "report_os_permission";
const REQUEST_OS_PERMISSION_DIRECTIVE = "request_os_permission";

const CONSENT_REQUIRED_MESSAGE =
  "Accept the Location consent before the device permission prompt.";

/** Server codes that mean a grant we hold is no longer publishable. */
const GRANT_GONE_REASONS = new Set<string>([
  "LOCATION_GRANT_EXPIRED",
  "LOCATION_GRANT_NOT_ACTIVE",
  "LOCATION_GRANT_NOT_FOUND",
]);

type PublishStepPayload = {
  grant_ids: string[];
  purpose: string | null;
  precision_override: LocationPublishPrecision | null;
  sos: boolean;
  point_policy: string | null;
  grants: Array<{ grant_id: string; user_id: string; key_id: string }>;
};

function readPublishPayload(
  payload: Record<string, unknown>,
): PublishStepPayload {
  const grantIds = Array.isArray(payload.grant_ids)
    ? payload.grant_ids
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    : [];
  const override = payload.precision_override;
  const grants = Array.isArray(payload.grants)
    ? payload.grants
        .map((row) => {
          if (!row || typeof row !== "object") return null;
          const record = row as Record<string, unknown>;
          const grantId = String(record.grant_id ?? "").trim();
          const userId = String(record.user_id ?? "").trim();
          const keyId = String(record.key_id ?? "").trim();
          return grantId && userId && keyId
            ? { grant_id: grantId, user_id: userId, key_id: keyId }
            : null;
        })
        .filter(
          (row): row is { grant_id: string; user_id: string; key_id: string } =>
            row !== null,
        )
    : [];
  return {
    grant_ids: grantIds,
    purpose: typeof payload.purpose === "string" ? payload.purpose : null,
    precision_override:
      override === "precise" || override === "approximate" ? override : null,
    sos: payload.sos === true || payload.purpose === "sos",
    point_policy:
      typeof payload.point_policy === "string" ? payload.point_policy : null,
    grants,
  };
}

/** Map the plugin's answer onto the server's reported-permission vocabulary. */
export function toReportedOsPermission(
  permission: LocationPermission | null | undefined,
): LocationOsPermissionReported {
  switch (permission) {
    case "granted":
      return "granted";
    case "denied":
    case "restricted":
      return "denied";
    case "prompt":
      return "prompt";
    default:
      return "unknown";
  }
}

function distanceMeters(
  from: PlainLocationPoint,
  to: PlainLocationPoint,
): number {
  return haversineMeters(
    { lat: from.latitude, lng: from.longitude },
    { lat: to.latitude, lng: to.longitude },
  );
}

function failuresPayload(
  failures: PublishFailure[],
): Array<Record<string, unknown>> {
  return failures.map((failure) => ({
    grant_id: failure.grantId,
    code: failure.code,
    reason: failure.reason ?? null,
  }));
}

function grantsKey(grants: readonly OneLocationGrant[]): string {
  return grants
    .map((grant) => `${grant.id}:${grant.recipientKeyId}`)
    .sort()
    .join(",");
}

export function LocationPublisherBridge() {
  const { userId } = useAuth();
  const { vaultOwnerToken, vaultKey } = useVault();
  const uid = userId ?? null;
  const sharing = useLocationSharingState();
  const settings = useLocationAccountSettings();
  const state = useOneLocationStateSnapshot();

  const tokenRef = useRef(vaultOwnerToken);
  tokenRef.current = vaultOwnerToken;
  const vaultKeyRef = useRef(vaultKey);
  vaultKeyRef.current = vaultKey;
  const uidRef = useRef(uid);
  uidRef.current = uid;
  const sharingRef = useRef(sharing);
  sharingRef.current = sharing;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const stateRef = useRef(state);
  stateRef.current = state;

  const grants = useMemo(() => activeOwnerGrants(state), [state]);
  const recipientsByUserId = useMemo(
    () => indexRecipientsByUserId(state?.recipients),
    [state],
  );
  const grantsSignature = grantsKey(grants);
  const grantsRef = useRef(grants);
  grantsRef.current = grants;
  const recipientsRef = useRef(recipientsByUserId);
  recipientsRef.current = recipientsByUserId;

  const publishing =
    sharing.effective === "sharing" &&
    Boolean(vaultOwnerToken) &&
    grants.length > 0;
  const appSharing = sharing.appSharing;
  const precision = sharing.precision;

  // Refs the watch loop reads without re-subscribing.
  const watchIdRef = useRef<string | null>(null);
  const lastPublishedRef = useRef<PlainLocationPoint | null>(null);
  const lastPublishedAtRef = useRef(0);
  const inFlightRef = useRef(false);
  const handledStepsRef = useRef(new Set<string>());
  const handledDirectivesRef = useRef(new Set<string>());

  const invalidateState = useCallback(() => {
    const owner = uidRef.current;
    if (!owner) return;
    OneLocationStateResource.invalidate(owner);
  }, []);

  // ---------------------------------------------------------------------
  // 1. Continuous publish loop
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!publishing) return;
    let cancelled = false;
    lastPublishedRef.current = null;
    lastPublishedAtRef.current = 0;

    const publishMovement = async (point: PlainLocationPoint) => {
      if (cancelled) return;
      const token = tokenRef.current;
      if (!token) return;
      if (sharingRef.current.effective !== "sharing") return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      if (inFlightRef.current) return;

      const now = Date.now();
      const previous = lastPublishedRef.current;
      const moved = previous
        ? distanceMeters(previous, point)
        : Number.POSITIVE_INFINITY;
      const since = now - lastPublishedAtRef.current;
      if (
        previous &&
        (moved < LIVE_LOCATION_MIN_MOVE_METERS ||
          since < LIVE_LOCATION_MIN_PUBLISH_INTERVAL_MS)
      ) {
        return;
      }

      inFlightRef.current = true;
      try {
        const result = await publishPointToGrants({
          point,
          grants: grantsRef.current,
          recipientsByUserId: recipientsRef.current,
          precision: sharingRef.current.precision,
          vaultOwnerToken: token,
          encrypt: encryptLocationForRecipient,
          store: (params) => OneLocationService.storeEnvelope(params),
        });
        if (cancelled) return;
        if (result.published.length > 0) {
          lastPublishedRef.current = point;
          lastPublishedAtRef.current = Date.now();
        }
        const refused = result.failures.some(
          (failure) => failure.code === "permission_denied",
        );
        const grantGone = result.failures.some((failure) =>
          GRANT_GONE_REASONS.has(String(failure.reason ?? "")),
        );
        if (refused || grantGone) {
          // The server refused (sharing off) or a grant expired or was
          // revoked underneath us. Re-read rather than keep re-publishing
          // against a state we no longer hold.
          invalidateState();
        }
        if (refused) {
          const owner = uidRef.current;
          if (owner && tokenRef.current) {
            void LocationAccountSettingsResource.load(owner, tokenRef.current, {
              force: true,
            }).catch(() => undefined);
          }
        }
      } catch (error) {
        console.warn("[LocationPublisherBridge] Live publish skipped:", error);
      } finally {
        inFlightRef.current = false;
      }
    };

    void (async () => {
      try {
        const watchId = await OneLocationService.watchCurrentPosition(
          (point) => void publishMovement(point),
          (error) => {
            console.warn(
              "[LocationPublisherBridge] Live watch error:",
              error.message,
            );
          },
        );
        if (cancelled) {
          void OneLocationService.clearLocationWatch(watchId).catch(
            () => undefined,
          );
          return;
        }
        watchIdRef.current = watchId;
      } catch (error) {
        console.warn(
          "[LocationPublisherBridge] Could not start live watch:",
          error,
        );
      }
    })();

    return () => {
      cancelled = true;
      const watchId = watchIdRef.current;
      watchIdRef.current = null;
      if (watchId) {
        void OneLocationService.clearLocationWatch(watchId).catch(
          () => undefined,
        );
      }
    };
    // `grantsSignature` and `precision` restart the loop when the set of
    // recipients or the coarsening changes; the refs carry the live values.
  }, [publishing, grantsSignature, precision, invalidateState]);

  // ---------------------------------------------------------------------
  // 1b. App sharing off => stop native background publishing at once
  // ---------------------------------------------------------------------
  const wasAppSharingRef = useRef(appSharing);
  useEffect(() => {
    const was = wasAppSharingRef.current;
    wasAppSharingRef.current = appSharing;
    if (was && !appSharing) {
      // The watch effect above has already been torn down by `publishing`
      // flipping; native needs an explicit stop.
      void OneLocationService.stopBackgroundShare().catch(() => undefined);
    }
  }, [appSharing]);

  // ---------------------------------------------------------------------
  // 1c. Native background share follows the current grants
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const token = tokenRef.current;
    if (!token) return;
    const session = buildBackgroundShareSession({
      activeGrants: grantsRef.current,
      recipients: Array.from(recipientsRef.current.values()),
      vaultOwnerToken: token,
      backendBaseUrl: getApiBaseUrl(),
      minMoveMeters: LIVE_LOCATION_MIN_MOVE_METERS,
      minIntervalMs: LIVE_LOCATION_MIN_PUBLISH_INTERVAL_MS,
    });
    void syncBackgroundShare({ enabled: publishing, session }).catch(
      () => undefined,
    );
  }, [publishing, grantsSignature, vaultOwnerToken]);

  useEffect(
    () => () => {
      void OneLocationService.stopBackgroundShare().catch(() => undefined);
    },
    [],
  );

  // ---------------------------------------------------------------------
  // 2. `one-voice:refresh` => the state resource is stale
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onRefresh = () => {
      invalidateState();
      const owner = uidRef.current;
      const token = tokenRef.current;
      if (owner && token) {
        void LocationAccountSettingsResource.load(owner, token, {
          force: true,
        }).catch(() => undefined);
      }
    };
    window.addEventListener(ONE_VOICE_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ONE_VOICE_REFRESH_EVENT, onRefresh);
  }, [invalidateState]);

  // ---------------------------------------------------------------------
  // 3. Tool results and resolved confirmations
  // ---------------------------------------------------------------------
  const applyPostureResult = useCallback(
    (tool: string | null, result: ToolResultPublic | null) => {
      const owner = uidRef.current;
      if (!owner || !result) return;
      const status = String(result.status ?? "");
      const sharingState = result.sharing_state;

      if (
        tool === "turn_sharing_off" ||
        (status === "off" && sharingState === "off")
      ) {
        if (status === "off") {
          // Server-confirmed. The settings resource flips `appSharing` and the
          // watch loop above tears down; grants were revoked server-side.
          LocationAccountSettingsResource.merge(owner, {
            sharing_state: "off",
            sharing_enabled: false,
          });
          void OneLocationService.stopBackgroundShare().catch(() => undefined);
          invalidateState();
        }
        return;
      }
      if (
        tool === "turn_sharing_on" ||
        (status === "on" && sharingState === "on")
      ) {
        if (status === "on") {
          LocationAccountSettingsResource.merge(owner, {
            sharing_state: "on",
            sharing_enabled: true,
          });
        }
        return;
      }
      if (tool === "set_precision") {
        if (status === "precise" || status === "approximate") {
          LocationAccountSettingsResource.merge(owner, { precision: status });
        }
        return;
      }
      if (tool === "advance_location_setup" && status === "advanced") {
        // `complete` turns sharing on server-side; re-read rather than guess.
        const token = tokenRef.current;
        if (token) {
          void LocationAccountSettingsResource.load(owner, token, {
            force: true,
          }).catch(() => undefined);
        }
        return;
      }
      const refresh = Array.isArray(result.ui_refresh)
        ? result.ui_refresh.map(String)
        : [];
      if (
        refresh.includes("location_state") ||
        refresh.includes("location_map")
      )
        invalidateState();
      if (refresh.includes("location_settings")) {
        const token = tokenRef.current;
        if (token) {
          void LocationAccountSettingsResource.load(owner, token, {
            force: true,
          }).catch(() => undefined);
        }
      }
      if (refresh.includes("location_setup")) {
        LocationSetupProgressResource.invalidate(owner);
      }
    },
    [invalidateState],
  );

  // ---------------------------------------------------------------------
  // 4. Client steps
  // ---------------------------------------------------------------------
  const loadFreshState = useCallback(
    async (owner: string, token: string): Promise<OneLocationState | null> => {
      OneLocationStateResource.invalidate(owner);
      try {
        return await OneLocationStateResource.load(owner, () =>
          OneLocationService.getState(token),
        );
      } catch {
        return stateRef.current;
      }
    },
    [],
  );

  const runPublishStep = useCallback(
    async (
      step: ClientStepView,
      report: (
        status: "ok" | "failed",
        payload?: Record<string, unknown>,
      ) => void,
    ) => {
      const owner = uidRef.current;
      const token = tokenRef.current;
      const payload = readPublishPayload(step.payload);
      if (!owner || !token) {
        report("failed", {
          code: "vault_locked",
          grant_ids: payload.grant_ids,
        });
        return;
      }
      if (payload.grant_ids.length === 0) {
        report("failed", { code: "no_grants", grant_ids: [] });
        return;
      }

      // Precision: SOS is always precise; otherwise the server's override or
      // the stored preference. Never a value this device merely assumes.
      let preference = settingsRef.current.settings?.precision ?? null;
      if (!preference) {
        try {
          preference = (
            await LocationAccountSettingsResource.load(owner, token)
          ).precision;
        } catch {
          preference = null;
        }
      }
      const precisionForStep = resolvePublishPrecision({
        preference,
        override: payload.precision_override,
        sos: payload.sos,
        purpose: payload.purpose,
      });

      // A fresh fix unless the tool said a held one is acceptable.
      let point: PlainLocationPoint;
      try {
        const held = payload.point_policy === "held_ok";
        point = await OneLocationService.captureCurrentPosition({
          maxAgeMs: held ? HELD_OK_MAX_AGE_MS : 0,
        });
      } catch (error) {
        const denied = isLocationPermissionDeniedError(error);
        report("failed", {
          code: denied ? "permission_denied" : "no_fix",
          grant_ids: payload.grant_ids,
          precision: precisionForStep,
          failures: payload.grant_ids.map((grantId) => ({
            grant_id: grantId,
            code: denied ? "permission_denied" : "store_failed",
            reason: denied ? "os_denied" : "no_fix",
          })),
        });
        return;
      }

      // Grants were just created by the tool: the held snapshot is stale.
      const freshState = await loadFreshState(owner, token);
      const byId = new Map(
        (freshState?.ownerGrants ?? []).map((grant) => [grant.id, grant]),
      );
      const grantsForStep: OneLocationGrant[] = [];
      for (const grantId of payload.grant_ids) {
        const known = byId.get(grantId);
        if (known) {
          grantsForStep.push(known);
          continue;
        }
        // The SOS step names each armed grant with its recipient and key so
        // a state read that lags the write can still publish.
        const armed = payload.grants.find((row) => row.grant_id === grantId);
        if (armed) {
          grantsForStep.push({
            id: armed.grant_id,
            ownerUserId: owner,
            recipientUserId: armed.user_id,
            recipientKeyId: armed.key_id,
            status: "active",
            consentScope: "location.live",
            capabilityScopes: [],
            durationHours: null,
            shareKind: payload.sos ? "sos" : payload.purpose,
          });
        }
      }
      const recipients = indexRecipientsByUserId(
        freshState?.recipients ?? stateRef.current?.recipients,
      );
      const missing = payload.grant_ids.filter(
        (grantId) => !grantsForStep.some((grant) => grant.id === grantId),
      );

      const result = await publishPointToGrants({
        point,
        grants: grantsForStep,
        recipientsByUserId: recipients,
        precision: precisionForStep,
        vaultOwnerToken: token,
        sos: payload.sos,
        encrypt: encryptLocationForRecipient,
        store: (params) => OneLocationService.storeEnvelope(params),
      });
      const failures = [
        ...failuresPayload(result.failures),
        ...missing.map((grantId) => ({
          grant_id: grantId,
          code: "store_failed",
          reason: "grant_not_found",
        })),
      ];
      const published = result.published.map((row) => row.grantId);
      const response = {
        published,
        failures,
        precision: result.precision,
        captured_at: result.capturedAt,
        grant_ids: payload.grant_ids,
      };
      if (published.length > 0) {
        lastPublishedRef.current = point;
        lastPublishedAtRef.current = Date.now();
        invalidateState();
        report("ok", response);
      } else {
        report("failed", response);
      }
    },
    [invalidateState, loadFreshState],
  );

  const runRegisterKeyStep = useCallback(
    async (
      report: (
        status: "ok" | "failed",
        payload?: Record<string, unknown>,
      ) => void,
    ) => {
      const owner = uidRef.current;
      const token = tokenRef.current;
      if (!owner || !token) {
        report("failed", { code: "vault_locked" });
        return;
      }
      try {
        const recipient = await bootstrapCurrentUserLocationRecipientKey({
          userId: owner,
          vaultOwnerToken: token,
          vaultKey: vaultKeyRef.current,
        });
        invalidateState();
        report("ok", { key_id: recipient.keyId ?? null });
      } catch (error) {
        report("failed", {
          code: "register_failed",
          reason: error instanceof Error ? error.message : null,
        });
      }
    },
    [invalidateState],
  );

  const runReportOsPermissionStep = useCallback(
    async (
      report: (
        status: "ok" | "failed",
        payload?: Record<string, unknown>,
      ) => void,
    ) => {
      // A read, never a prompt: the directive path owns the prompt.
      const permission = await LocationBus.syncPermission();
      report("ok", { os_permission_state: toReportedOsPermission(permission) });
    },
    [],
  );

  // ---------------------------------------------------------------------
  // 5. `request_os_permission` directive
  // ---------------------------------------------------------------------
  const runRequestOsPermission = useCallback(
    async (settle: (status: "opened" | "failed" | "ignored") => void) => {
      const owner = uidRef.current;
      const token = tokenRef.current;
      const store = useVoiceSessionStore.getState();
      if (!owner || !token) {
        store.dispatch({
          type: "local_error",
          error: {
            code: "vault_locked",
            message: "Unlock your vault to continue Location setup.",
            recoverable: true,
          },
        });
        settle("failed");
        return;
      }

      // Consent first, always. The server's row is the only proof that counts.
      let consentAccepted = false;
      try {
        const progress = await getSetupProgress(token);
        LocationSetupProgressResource.write(owner, progress);
        consentAccepted = Boolean(progress.consent_accepted_at);
      } catch {
        consentAccepted = false;
      }
      if (!consentAccepted) {
        store.dispatch({
          type: "local_error",
          error: {
            code: "consent_required",
            message: CONSENT_REQUIRED_MESSAGE,
            recoverable: true,
          },
        });
        settle("failed");
        return;
      }

      let permission: LocationPermission | null = null;
      try {
        const answer = await OneLocationService.requestLocationPermission();
        permission = answer.state;
      } catch (error) {
        permission = isLocationPermissionDeniedError(error) ? "denied" : null;
      }
      const reported = toReportedOsPermission(permission);
      try {
        const update = await settingsRef.current.update({
          osPermissionReported: reported,
        });
        LocationAccountSettingsResource.write(owner, update.settings);
      } catch {
        // The prompt still happened; the setup flow re-reads on its own.
      }
      LocationBus.invalidate();
      settle("opened");

      if (permission === "denied" || permission === "restricted") {
        const guide = resolveLocationRecoveryGuide({
          userAgent:
            typeof navigator !== "undefined" ? navigator.userAgent : null,
          isNativeApp: Capacitor.isNativePlatform(),
          nativePlatform: Capacitor.getPlatform(),
        });
        morphyToast.warning(guide.title, {
          description: guide.steps.join(" "),
          duration: 8000,
        });
        if (guide.canOpenSettings) {
          void OneLocationService.openAppSettings().catch(() => undefined);
        }
      }
    },
    [],
  );

  useVoiceToolEffects({
    onToolResult: (tool, result) => applyPostureResult(tool, result),
    onPendingResolved: (pendingActionId, status, result) => {
      if (status !== "executed") return;
      const pending = useVoiceSessionStore.getState().state.pendingAction;
      const tool =
        pending && pending.pending_action_id === pendingActionId
          ? pending.tool
          : null;
      applyPostureResult(tool, result);
    },
    onDirective: (directiveId, kind, _payload, settle) => {
      if (kind !== REQUEST_OS_PERMISSION_DIRECTIVE) return;
      if (handledDirectivesRef.current.has(directiveId)) return;
      handledDirectivesRef.current.add(directiveId);
      void runRequestOsPermission(settle);
    },
    onClientStep: (step, report) => {
      // Each step is reported exactly once; the provider that handed us
      // `report` owns the store transition that clears it.
      if (handledStepsRef.current.has(step.stepId)) return;
      let reported = false;
      const once = (
        status: "ok" | "failed",
        payload?: Record<string, unknown>,
      ) => {
        if (reported) return;
        reported = true;
        report(status, payload);
      };
      if (step.kind === PUBLISH_STEP) {
        handledStepsRef.current.add(step.stepId);
        void runPublishStep(step, once);
        return;
      }
      if (step.kind === REGISTER_KEY_STEP) {
        handledStepsRef.current.add(step.stepId);
        void runRegisterKeyStep(once);
        return;
      }
      if (step.kind === REPORT_OS_PERMISSION_STEP) {
        handledStepsRef.current.add(step.stepId);
        void runReportOsPermissionStep(once);
      }
    },
  });

  return null;
}
