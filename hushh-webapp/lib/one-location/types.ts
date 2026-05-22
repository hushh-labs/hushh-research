export type LocationSourcePlatform =
  | "web"
  | "ios"
  | "android"
  | "native"
  | "unknown";

export type OneLocationRecipient = {
  userId: string;
  displayName: string;
  maskedPhone?: string | null;
  phoneVerified: boolean;
  keyId?: string | null;
  publicKeyJwk?: JsonWebKey | null;
  keyAlgorithm: string;
  keyRegisteredAt?: string | null;
  canReceiveLocation: boolean;
};

export type OneLocationGrant = {
  id: string;
  ownerUserId: string;
  recipientUserId: string;
  ownerDisplayName?: string | null;
  ownerMaskedPhone?: string | null;
  recipientDisplayName?: string | null;
  recipientMaskedPhone?: string | null;
  recipientKeyId: string;
  status: "active" | "expired" | "revoked" | string;
  consentScope: string;
  capabilityScopes: string[];
  durationHours: number;
  expiresAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  revokedAt?: string | null;
  latestEnvelopeId?: string | null;
};

export type OneLocationAccessRequest = {
  id: string;
  ownerUserId: string;
  requesterUserId: string;
  requesterDisplayName?: string | null;
  requesterMaskedPhone?: string | null;
  referredByUserId?: string | null;
  status: "pending" | "approved" | "denied" | "cancelled" | string;
  message?: string | null;
  requestedAt?: string | null;
  resolvedAt?: string | null;
  approvedGrantId?: string | null;
};

export type OneLocationReferral = {
  id: string;
  grantId: string;
  ownerUserId: string;
  referringUserId: string;
  referredUserId: string;
  requestId?: string | null;
  status: string;
  createdAt?: string | null;
  resolvedAt?: string | null;
};

export type OneLocationPublicInvite = {
  id: string;
  ownerUserId: string;
  ownerLabel?: string | null;
  ownerDisplayName?: string | null;
  ownerMaskedPhone?: string | null;
  status: "active" | "expired" | "revoked" | string;
  durationHours: number;
  expiresAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  revokedAt?: string | null;
};

export type OneLocationPublicInviteSubmission = {
  id: string;
  inviteId: string;
  ownerUserId: string;
  visitorDisplayName: string;
  visitorMaskedPhone?: string | null;
  matchedUserId?: string | null;
  requestId?: string | null;
  requestStatus?: string | null;
  status:
    | "pending_identity"
    | "identity_pending_key"
    | "matched_request_pending"
    | "approved"
    | "denied"
    | "cancelled"
    | string;
  message?: string | null;
  submittedAt?: string | null;
  resolvedAt?: string | null;
};

export type OneLocationState = {
  recipients: OneLocationRecipient[];
  ownerGrants: OneLocationGrant[];
  receivedGrants: OneLocationGrant[];
  requests: OneLocationAccessRequest[];
  referrals: OneLocationReferral[];
  publicInvites: OneLocationPublicInvite[];
  publicInviteSubmissions: OneLocationPublicInviteSubmission[];
  capabilityScopes: string[];
};

export type PlainLocationPoint = {
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  capturedAt: string;
  sourcePlatform: LocationSourcePlatform;
};

export type OneLocationEncryptedEnvelope = {
  id?: string;
  grantId?: string;
  ownerUserId?: string;
  recipientUserId?: string;
  recipientKeyId: string;
  algorithm: "ECDH-P256-AES256-GCM";
  ciphertext: string;
  iv: string;
  senderEphemeralPublicKeyJwk: JsonWebKey;
  capturedAt: string;
  sourcePlatform: LocationSourcePlatform;
  createdAt?: string | null;
  metadata?: Record<string, unknown>;
};
