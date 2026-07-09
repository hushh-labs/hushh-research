import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationGrant, PlainLocationPoint } from "@/lib/one-location/types";
import type { SosShareReadyRecipient } from "@/lib/one-location/sos-trigger";

export interface RunCheckInParams {
  vaultOwnerToken: string;
  /** Only share-ready recipients — caller pre-filters with isSosShareReadyRecipient. */
  recipients: SosShareReadyRecipient[];
  point: PlainLocationPoint;
  durationHours: number;
  note?: string | null;
  publish: (
    grant: OneLocationGrant,
    recipient: SosShareReadyRecipient,
    point: PlainLocationPoint,
  ) => Promise<void>;
}

/** Non-emergency check-in: bounded share to the user's ready trusted contacts.
 * Unlike SOS it uses a caller-chosen duration + note and records no SOS incident. */
export async function runCheckIn(params: RunCheckInParams): Promise<string[]> {
  const { vaultOwnerToken, recipients, point, durationHours, note, publish } = params;
  if (!recipients.length) throw new Error("No check-in recipients provided.");
  const reason = (note ?? "").trim() || "Checking in";
  const grantIds: string[] = [];
  for (const recipient of recipients) {
    const grant = await OneLocationService.createGrant({
      vaultOwnerToken,
      recipientUserId: recipient.userId,
      recipientKeyId: recipient.keyId,
      durationHours,
      reason,
    });
    grantIds.push(grant.id);
    await publish(grant, recipient, point);
  }
  return grantIds;
}
