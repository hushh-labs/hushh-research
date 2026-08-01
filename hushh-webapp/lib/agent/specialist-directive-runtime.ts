import { publicInviteUrlLabel } from "@/lib/one-location/public-invite-url";
import { OneLocationService } from "@/lib/one-location/service";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
import {
  prepareLocationPointForSharing,
} from "@/lib/one-location/location-precision";
import { executePrivateLocationAction } from "@/lib/one-location/client-action-executor";
import { readOneLocationControlState } from "@/lib/one-location/location-control-state";
import type {
  ClientAction,
  LocationSharingMode,
  ShareTarget,
} from "@/lib/one-location/types";
import {
  isSosShareReadyRecipient,
  runSosPanic,
  selectSmsRecipients,
  selectSosConnectedRecipients,
} from "@/lib/one-location/sos-trigger";
import { runCheckIn } from "@/lib/one-location/check-in-trigger";

export type SpecialistDirective = {
  kind: "action" | "prompt";
  payload: Record<string, unknown>;
};

export type DelegateResult = {
  delegate_agent_id:
    | "agent_location"
    | "agent_connected_systems"
    | "agent_connections"
    | "agent_email";
  kind: "action" | "selection";
  id: string;
  // promptKind is only set for kind:"selection" turns. It carries the location
  // ClientPrompt kind ("select"|"confirm") so the A2A discriminator ("selection")
  // is never misread as the location prompt kind on the backend.
  promptKind?: "select" | "confirm";
  type?: string;
  status: "completed" | "cancelled" | "failed" | "answered";
  publicUrl?: string;
  detail?: string;
  durationHours?: number;
  locationMode?: LocationSharingMode;
  selected?: Record<string, unknown>[];
  confirmed?: boolean;
  freeText?: string;
  // Human-readable label for the chat chip (e.g. "Abdul Zalil · 8 hours").
  display?: string;
};

/**
 * Run a location specialist_directive in the browser, reusing the exact crypto
 * logic from use-location-chat confirmAction. Returns a coordinate-free
 * DelegateResult for the follow-up turn.
 *
 * Adaptations vs brief:
 * - encryptLocationForRecipient takes { point, recipientPublicKeyJwk, recipientKeyId }
 *   not positional args (brief guessed wrong signature)
 * - storeEnvelope takes { vaultOwnerToken, grantId, envelope } not (grantId, envelope)
 * - createPublicInvite uses field `locationSnapshot` not `publicLocation`, requires vaultOwnerToken
 * - viewEnvelope (not viewGrantEnvelope), takes { vaultOwnerToken, grantId }
 * - All service methods except captureCurrentPosition require vaultOwnerToken;
 *   added as second param defaulting to "" for test compat (mocks ignore it)
 *
 * SECURITY: the recipient public-key JWK is always sourced from the server via
 * OneLocationService.getState() (matching use-location-chat confirmAction) and
 * NEVER read from the directive payload — the directive is produced by an LLM,
 * so trusting a payload-supplied JWK would let a hallucinating/adversarial agent
 * substitute a key it controls.
 *
 * @param directive - The directive received from the SSE stream
 * @param vaultOwnerToken - Vault owner token required by OneLocationService
 *   (default "" for test compat; callers must supply a real token in production)
 */
export async function runLocationDirective(
  directive: SpecialistDirective,
  vaultOwnerToken = "",
  currentUserId: string | null = null,
): Promise<DelegateResult> {
  const payload = directive.payload as Record<string, any>;
  const id = String(payload.id ?? "");
  const type = String(payload.type ?? "");

  try {
    if (type === "publish_share") {
      const shares = (payload.shares ?? []) as ShareTarget[];
      const action: ClientAction = {
        id,
        type: "publish_share",
        shares,
        summary: String(payload.summary ?? "Review location sharing"),
      };
      const outcome = await executePrivateLocationAction({
        action,
        vaultOwnerToken,
        userId: currentUserId,
      });
      return {
        delegate_agent_id: "agent_location",
        kind: "action",
        id,
        type,
        status: "completed",
        detail:
          outcome.successfulCount < outcome.totalCount
            ? `${outcome.successfulCount} of ${outcome.totalCount} private shares started. ${outcome.failureDetails?.join(" ") ?? ""}`.trim()
            : undefined,
        durationHours: shares[0]?.durationHours,
        locationMode: shares[0]?.locationMode,
      };
    }

    if (type === "create_public_link") {
      if (readOneLocationControlState(currentUserId).paused) {
        throw new Error(
          "Location is paused on this device. Resume it before capturing a snapshot.",
        );
      }
      const locationMode: LocationSharingMode =
        payload.locationMode === "precise" ? "precise" : "approximate";
      const point = await OneLocationService.captureCurrentPosition();
      const permission = await OneLocationService.getPermissionState();
      if (readOneLocationControlState(currentUserId).paused) {
        throw new Error(
          "Location was paused before the snapshot could be created.",
        );
      }
      if (locationMode === "precise" && permission.precise === false) {
        throw new Error(
          "Turn on Precise Location in device settings to capture a precise point.",
        );
      }
      const locationSnapshot = prepareLocationPointForSharing(
        point,
        locationMode,
      );
      const response = await OneLocationService.createPublicInvite({
        vaultOwnerToken,
        durationHours: Number(payload.durationHours ?? 1),
        locationSnapshot,
      });
      if (readOneLocationControlState(currentUserId).paused) {
        await OneLocationService.revokePublicInvite({
          vaultOwnerToken,
          inviteId: response.invite.id,
        }).catch(() => undefined);
        throw new Error(
          "Location was paused before the one-time link completed.",
        );
      }
      return {
        delegate_agent_id: "agent_location",
        kind: "action",
        id,
        type,
        status: "completed",
        publicUrl: publicInviteUrlLabel(response.publicUrl),
        durationHours: Number(payload.durationHours ?? 1),
        locationMode,
      };
    }

    if (type === "view_envelope") {
      // Real method is viewEnvelope (not viewGrantEnvelope as brief guessed)
      await OneLocationService.viewEnvelope({
        vaultOwnerToken,
        grantId: String(payload.grantId ?? ""),
      });
      // Result is coordinate-free; decryption happens in the UI layer if needed
      return {
        delegate_agent_id: "agent_location",
        kind: "action",
        id,
        type,
        status: "completed",
      };
    }

    if (type === "sos_panic") {
      if (!currentUserId) {
        throw new Error("Sign in again before sharing location.");
      }
      const state = await OneLocationService.getState(vaultOwnerToken);
      const connected = selectSosConnectedRecipients(
        state.recipients ?? [],
        state.networkConnections,
        currentUserId,
      );
      const ready = selectSmsRecipients(
        connected,
        state.smsContactUserIds,
      ).filter(isSosShareReadyRecipient);
      if (!ready.length) {
        return {
          delegate_agent_id: "agent_location",
          kind: "action",
          id,
          type,
          status: "cancelled",
        };
      }
      const point = await OneLocationService.captureCurrentPosition();
      const incident = await runSosPanic({
        userId: currentUserId,
        vaultOwnerToken,
        recipients: ready,
        point,
        operationId: id,
        prepareEnvelope: async (recipient, capturedPoint) =>
          encryptLocationForRecipient({
            point: prepareLocationPointForSharing(capturedPoint, "precise"),
            recipientPublicKeyJwk: recipient.publicKeyJwk,
            recipientKeyId: recipient.keyId,
          }),
      });
      return {
        delegate_agent_id: "agent_location",
        kind: "action",
        id,
        type,
        status: "completed",
        detail:
          incident.grantIds.length < ready.length
            ? `SOS location reached ${incident.grantIds.length} of ${ready.length} contacts.`
            : undefined,
      };
    }

    if (type === "request_device_location_permission") {
      // Actually trigger the OS/browser permission prompt (native plugins call
      // requestWhenInUseAuthorization / ACCESS_FINE_LOCATION; the web fallback
      // calls getCurrentPosition, which is what surfaces the browser's own
      // permission dialog). No coordinates cross this boundary.
      const state = await OneLocationService.requestLocationPermission();
      return {
        delegate_agent_id: "agent_location",
        kind: "action",
        id,
        type,
        status: state.state === "granted" ? "completed" : "cancelled",
        detail: state.state,
      };
    }

    if (type === "check_in") {
      if (!currentUserId) {
        throw new Error("Sign in again before sharing location.");
      }
      const state = await OneLocationService.getState(vaultOwnerToken);
      const connected = selectSosConnectedRecipients(
        state.recipients ?? [],
        state.networkConnections,
        currentUserId,
      );
      const ready = connected.filter(isSosShareReadyRecipient);
      if (!ready.length) {
        return {
          delegate_agent_id: "agent_location",
          kind: "action",
          id,
          type,
          status: "cancelled",
        };
      }
      const point = await OneLocationService.captureCurrentPosition();
      const grantIds = await runCheckIn({
        userId: currentUserId,
        vaultOwnerToken,
        recipients: ready,
        point,
        durationHours: Number(payload.durationHours) || 1,
        note: payload.note ?? null,
        operationId: id,
        prepareEnvelope: async (recipient, capturedPoint) =>
          encryptLocationForRecipient({
            point: prepareLocationPointForSharing(capturedPoint, "precise"),
            recipientPublicKeyJwk: recipient.publicKeyJwk,
            recipientKeyId: recipient.keyId,
          }),
      });
      return {
        delegate_agent_id: "agent_location",
        kind: "action",
        id,
        type,
        status: "completed",
        detail:
          grantIds.length < ready.length
            ? `Checked in with ${grantIds.length} of ${ready.length} contacts.`
            : undefined,
      };
    }

    return {
      delegate_agent_id: "agent_location",
      kind: "action",
      id,
      type,
      status: "failed",
      detail: "unsupported directive",
    };
  } catch (error) {
    return {
      delegate_agent_id: "agent_location",
      kind: "action",
      id,
      type,
      status: "failed",
      detail: error instanceof Error ? error.message : "action failed",
    };
  }
}
