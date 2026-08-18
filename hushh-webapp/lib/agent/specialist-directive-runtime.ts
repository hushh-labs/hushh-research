import {
  isReadOnlyLocationQuery,
  formatLocationQueryResponse,
} from "@/lib/agent/tools/location-tools";
import { publicInviteUrlLabel } from "@/lib/one-location/public-invite-url";
import { OneLocationService } from "@/lib/one-location/service";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
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
    | "agent_email"
    | "agent_calendar";
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
  selected?: Record<string, unknown>[];
  confirmed?: boolean;
  freeText?: string;
  // Human-readable label for the chat chip (e.g. "Abdul Zalil · 8 hours").
  display?: string;
};

type Share = {
  grantId: string;
  recipientKeyId: string;
  recipientUserId?: string;
  label: string;
};

/**
 * Run a location specialist_directive in the browser, reusing the exact crypto
 * logic from use-location-chat confirmAction. Returns a coordinate-free
 * DelegateResult for the follow-up turn.
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
    // ── Handle Read-Only Query Directives ──────────────────────────────────────
    if (isReadOnlyLocationQuery(type)) {
      let queryData = payload;
      if (vaultOwnerToken) {
        try {
          const state = await OneLocationService.getState(vaultOwnerToken);
          queryData = {
            ...payload,
            incomingShares: (state.receivedGrants ?? []).filter((g) => g.status === "active"),
            activeShares: (state.ownerGrants ?? []).filter((g) => g.status === "active"),
            publicLinks: (state.publicInvites ?? []).filter((i) => i.status === "active"),
          };
        } catch {
          // Fall back to directive payload if service fetch fails
        }
      }
      const formatted = formatLocationQueryResponse(type, queryData);
      return {
        delegate_agent_id: "agent_location",
        kind: "action",
        id,
        type,
        status: "completed",
        detail: formatted.chatAnswer,
      };
    }

    if (type === "publish_share") {
      const shares = (payload.shares ?? []) as Share[];
      // Capture ONCE, encrypt PER recipient, store per recipient.
      // Mirrors use-location-chat confirmAction lines ~211-231: capture the
      // position, load server state once, and for each share look up the
      // recipient's public key from server state (never from the directive).
      const position = await OneLocationService.captureCurrentPosition();
      const state = await OneLocationService.getState(vaultOwnerToken);
      for (const share of shares) {
        const recipient = (state.recipients ?? []).find(
          (r) => r.keyId === share.recipientKeyId,
        );
        if (!recipient?.publicKeyJwk) {
          throw new Error(`${share.label} hasn't set up location sharing yet`);
        }
        const envelope = await encryptLocationForRecipient({
          point: position,
          recipientPublicKeyJwk: recipient.publicKeyJwk,
          recipientKeyId: share.recipientKeyId,
        });
        await OneLocationService.storeEnvelope({
          vaultOwnerToken,
          grantId: share.grantId,
          envelope,
        });
      }
      return {
        delegate_agent_id: "agent_location",
        kind: "action",
        id,
        type,
        status: "completed",
      };
    }

    if (type === "create_public_link") {
      // Real field is `locationSnapshot` (not `publicLocation` as brief guessed)
      const locationSnapshot = await OneLocationService.captureCurrentPosition();
      const { publicUrl } = await OneLocationService.createPublicInvite({
        vaultOwnerToken,
        durationHours: Number(payload.durationHours ?? 1),
        locationSnapshot,
      });
      return {
        delegate_agent_id: "agent_location",
        kind: "action",
        id,
        type,
        status: "completed",
        publicUrl: publicInviteUrlLabel(publicUrl),
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
      await runSosPanic({
        vaultOwnerToken,
        recipients: ready,
        point,
        publish: async (grant, recipient, pt) => {
          const envelope = await encryptLocationForRecipient({
            point: pt,
            recipientPublicKeyJwk: recipient.publicKeyJwk,
            recipientKeyId: recipient.keyId,
          });
          await OneLocationService.storeEnvelope({
            vaultOwnerToken,
            grantId: grant.id,
            envelope,
          });
        },
      });
      return {
        delegate_agent_id: "agent_location",
        kind: "action",
        id,
        type,
        status: "completed",
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
      const state = await OneLocationService.getState(vaultOwnerToken);
      const connected = selectSosConnectedRecipients(
        state.recipients ?? [],
        state.networkConnections,
        currentUserId,
      );
      const ready = connected.filter(isSosShareReadyRecipient);
      if (!ready.length) {
        return { delegate_agent_id: "agent_location", kind: "action", id, type, status: "cancelled" };
      }
      const point = await OneLocationService.captureCurrentPosition();
      await runCheckIn({
        vaultOwnerToken,
        recipients: ready,
        point,
        durationHours: Number(payload.durationHours) || 1,
        note: payload.note ?? null,
        publish: async (grant, recipient, pt) => {
          const envelope = await encryptLocationForRecipient({
            point: pt,
            recipientPublicKeyJwk: recipient.publicKeyJwk,
            recipientKeyId: recipient.keyId,
          });
          await OneLocationService.storeEnvelope({ vaultOwnerToken, grantId: grant.id, envelope });
        },
      });
      return { delegate_agent_id: "agent_location", kind: "action", id, type, status: "completed" };
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
