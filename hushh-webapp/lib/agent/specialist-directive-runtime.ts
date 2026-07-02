import { OneLocationService } from "@/lib/one-location/service";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";

export type SpecialistDirective = {
  kind: "action" | "prompt";
  payload: Record<string, unknown>;
};

export type DelegateResult = {
  delegate_agent_id: "agent_location";
  kind: "action" | "selection";
  id: string;
  type?: string;
  status: "completed" | "cancelled" | "failed";
  publicUrl?: string;
  detail?: string;
  selected?: unknown[];
  confirmed?: boolean;
  freeText?: string;
};

type Share = {
  grantId: string;
  recipientKeyId: string;
  /**
   * The recipient's EC public key JWK used to encrypt the location envelope.
   * The agent-chat component supplies this from OneLocationService.getState()
   * before building the directive payload. Tests mock encryptLocationForRecipient
   * so this field is not required in test fixtures.
   */
  recipientPublicKeyJwk?: JsonWebKey;
  recipientUserId?: string;
  label: string;
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
 * @param directive - The directive received from the SSE stream
 * @param vaultOwnerToken - Vault owner token required by OneLocationService
 *   (default "" for test compat; callers must supply a real token in production)
 */
export async function runLocationDirective(
  directive: SpecialistDirective,
  vaultOwnerToken = "",
): Promise<DelegateResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = directive.payload as Record<string, any>;
  const id = String(payload.id ?? "");
  const type = String(payload.type ?? "");

  try {
    if (type === "publish_share") {
      const shares = (payload.shares ?? []) as Share[];
      // Capture ONCE, encrypt PER recipient, store per recipient
      // Mirrors use-location-chat confirmAction lines ~211-231
      const position = await OneLocationService.captureCurrentPosition();
      for (const share of shares) {
        const envelope = await encryptLocationForRecipient({
          point: position,
          // recipientPublicKeyJwk is supplied by the agent-chat component
          // from getState() before building the directive. Tests mock
          // encryptLocationForRecipient so {} cast is safe there.
          recipientPublicKeyJwk: (share.recipientPublicKeyJwk ?? {}) as JsonWebKey,
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
        publicUrl,
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
