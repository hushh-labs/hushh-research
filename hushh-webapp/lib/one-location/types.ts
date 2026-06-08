export type LocationSourcePlatform =
  | "web"
  | "ios"
  | "android"
  | "native"
  | "unknown";

export type OneLocationRecommendationTier =
  | "needs_action"
  | "trusted_circle"
  | "kai_network"
  | "contacts"
  | "setup_needed"
  | "available"
  | string;

export type OneLocationRecommendationCategory =
  | "needs_action"
  | "trusted_circle"
  | "professional_network"
  | "location_ready"
  | "needs_setup"
  | string;

export type OneLocationRecommendationReason = {
  code: string;
  label: string;
  weight?: number;
};

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
  recommendationScore?: number;
  recommendationRank?: number;
  recommendationTier?: OneLocationRecommendationTier | null;
  recommendationCategory?: OneLocationRecommendationCategory | null;
  recommendationCategoryLabel?: string | null;
  recommendationReasons?: OneLocationRecommendationReason[];
  recommendationSummary?: string | null;
  trustLevel?: "high" | "medium" | "new" | "setup_needed" | string | null;
  relationshipType?: string | null;
  profileHeadline?: string | null;
  verificationBadge?: string | null;
  lastInteractionAt?: string | null;
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

export type OneLocationActivityRange = "7d" | "30d" | "90d" | "all";

export type OneLocationActivityKind = "share" | "request" | "public";

export type OneLocationActivityEvent = {
  id: string;
  kind: OneLocationActivityKind;
  eventType?: string;
  occurredAt: string;
  bucketKey?: string;
  bucketLabel?: string;
  title: string;
  detail: string;
};

export type OneLocationActivityBucket = {
  key: string;
  label: string;
  shares: number;
  requests: number;
  views: number;
  publicActivity: number;
  total: number;
};

type OneLocationActivitySummary = {
  sharedWithCount: number;
  activeShareCount: number;
  requestsReceivedCount: number;
  requestsSentCount: number;
  viewsCount: number;
  publicLinkCount: number;
  publicResponseCount: number;
  totalEvents: number;
};

export type OneLocationActivityResponse = {
  range: OneLocationActivityRange;
  summary: OneLocationActivitySummary;
  buckets: OneLocationActivityBucket[];
  events: OneLocationActivityEvent[];
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
