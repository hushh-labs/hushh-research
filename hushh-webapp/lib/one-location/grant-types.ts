import type { OneLocationShareDurationMode } from "./types";

export type OneLocationGrant = {
  id: string;
  ownerUserId: string;
  recipientUserId: string;
  ownerDisplayName?: string | null;
  ownerPhotoUrl?: string | null;
  ownerMaskedPhone?: string | null;
  recipientDisplayName?: string | null;
  recipientPhotoUrl?: string | null;
  recipientMaskedPhone?: string | null;
  recipientKeyId: string;
  status: "active" | "expired" | "revoked" | string;
  consentScope: string;
  capabilityScopes: string[];
  durationMode?: OneLocationShareDurationMode | string | null;
  durationHours: number | null;
  expiresAt?: string | null;
  /** Legacy recipient projection; current Feed uses exact grant incidents. */
  feedLatestSms?: boolean;
  feedSmsConfirmed?: boolean;
  feedItemId?: string | null;
  feedConfirmedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  revokedAt?: string | null;
  latestEnvelopeId?: string | null;
  /** Optional provenance for an explicit share started from a named Circle. */
  sourceCircleId?: string | null;
  /**
   * Share intent surfaced by the backend so the recipient's notification, bell,
   * and Consent Manager can distinguish an emergency SOS from a friendly
   * Check-In from a plain location share. "share" is the neutral default.
   */
  shareKind?: "sos" | "check_in" | "share" | "drive_to" | string | null;
  /**
   * Optional human note attached to the share (e.g. a Check-In message). Already
   * coordinate-free and bounded by the backend; shown verbatim to the recipient.
   */
  shareMessage?: string | null;
  /**
   * When the recipient cleared this ended share from their Feed, on any
   * device. Present only on received grants; the owner never sees it.
   */
  recipientClearedAt?: string | null;
};
