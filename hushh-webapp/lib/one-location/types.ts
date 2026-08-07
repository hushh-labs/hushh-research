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

export type OneLocationViewerCapabilities = {
  hasLocationRecipientKey?: boolean;
  canBootstrapRecipientKey?: boolean;
  canShareLocation?: boolean;
  canRequestLocation?: boolean;
};

type KaiCircleCandidateReadiness =
  | "location_ready"
  | "target_setup_needed"
  | "viewer_setup_needed"
  | "invite_only"
  | "not_shareable";

export type KaiCircleCandidate = {
  candidateId: string;
  userId?: string | null;
  displayName: string;
  maskedPhone?: string | null;
  phoneVerified: boolean;
  keyId?: string | null;
  publicKeyJwk?: JsonWebKey | null;
  keyAlgorithm: string;
  keyRegisteredAt?: string | null;
  canReceiveLocation: boolean;
  isShareReady: boolean;
  readiness: KaiCircleCandidateReadiness;
  connectCandidateId?: string | null;
  connectKind?: string | null;
  connectStatus?: string | null;
  sourceTypes: string[];
  profileHref?: string | null;
  connectionHref?: string | null;
  isPublicProfileOnly?: boolean;
  isDiscoverable: boolean;
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

export type KaiCircleSectionKey =
  | "needs_action"
  | "trusted_circle"
  | "professional_network"
  | "connect_matches"
  | "location_ready"
  | "needs_setup";

export type KaiCircleSection = {
  key: KaiCircleSectionKey;
  title: string;
  description: string;
  candidates: KaiCircleCandidate[];
};

type KaiCircleCtaId =
  | "share_location"
  | "request_location"
  | "ask_to_setup_one_location"
  | "open_connect_profile"
  | "approve"
  | "deny"
  | "view_shared_location"
  | "revoke_access";

export type KaiCircleCta = {
  id: KaiCircleCtaId;
  label: string;
  enabled: boolean;
  reason?: string | null;
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
  locationAvailable?: boolean;
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

export type OneLocationCircleInvite = {
  id?: string;
  ownerUserId?: string | null;
  ownerLabel?: string | null;
  status: "active" | "claimed" | "expired" | "revoked" | string;
  durationHours: number;
  expiresAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  revokedAt?: string | null;
  claimedAt?: string | null;
  claimedByUserId?: string | null;
  requestId?: string | null;
  message?: string | null;
};

export type OneLocationCircleKind = "family" | "friends" | "other";
export type OneLocationCircleRole = "owner" | "member";

export type OneLocationCircleViewerCapabilities = {
  canInviteMembers: boolean;
  canViewInviteCode: boolean;
  canRotateInviteCode: boolean;
  canManageCircle: boolean;
  canModerateInvites: boolean;
};

export type OneLocationCircleSummary = {
  id: string;
  name: string;
  kind: OneLocationCircleKind;
  role: OneLocationCircleRole;
  memberCount: number;
  memberLimit: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  viewerCapabilities?: OneLocationCircleViewerCapabilities;
};

export type OneLocationCircleMember = {
  userId: string;
  displayName: string;
  photoUrl?: string | null;
  role: OneLocationCircleRole;
  joinedAt?: string | null;
  phoneVerified: boolean;
  secureLocationReady: boolean;
  keyId?: string | null;
  publicKeyJwk?: JsonWebKey | null;
  keyAlgorithm?: string | null;
  keyRegisteredAt?: string | null;
  canReceiveLocation?: boolean;
};

export type OneLocationCircleDetail = OneLocationCircleSummary & {
  members: OneLocationCircleMember[];
  activeInviteCode?: OneLocationCircleInviteCode | null;
  /** True only for a legacy active code that must be explicitly rotated by the owner. */
  inviteCodeNeedsOwnerRotation?: boolean;
};

export type OneLocationCircleInviteCode = {
  id: string;
  circleId: string;
  /** Re-readable by active members; never persist it in client storage or URLs. */
  code: string;
  expiresAt: string;
};

export type OneLocationCircleInvitePreview = {
  name: string;
  kind: OneLocationCircleKind;
  ownerDisplayName: string;
  memberCount: number;
  expiresAt: string;
  alreadyMember: boolean;
};

export type OneLocationCircleEligibleConnection = {
  connectionId: string;
  userId: string;
  displayName: string;
  photoUrl?: string | null;
  connectedAt?: string | null;
};

export type OneLocationCircleMemberInviteStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired"
  | string;

export type OneLocationCircleMemberInvite = {
  id: string;
  circleId: string;
  circleName: string;
  circleKind: OneLocationCircleKind;
  inviterUserId: string;
  inviterDisplayName: string;
  inviteeUserId: string;
  inviteeDisplayName?: string | null;
  inviteePhotoUrl?: string | null;
  status: OneLocationCircleMemberInviteStatus;
  createdAt?: string | null;
  expiresAt?: string | null;
  respondedAt?: string | null;
  cancelledAt?: string | null;
};

export type OneLocationCircleEligibleConnections = {
  eligibleConnections: OneLocationCircleEligibleConnection[];
  pendingInvites: OneLocationCircleMemberInvite[];
  remainingCapacity: number;
};

export type OneLocationNetworkConnection = {
  id: string;
  userAId: string;
  userBId: string;
  inviterUserId: string;
  inviteeUserId: string;
  inviteId?: string | null;
  status: "active" | "revoked" | string;
  connectedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  revokedAt?: string | null;
};

// Opaque vault-key-encrypted (AES-256-GCM) blob wrapping the recipient's ECDH
// private key JWK. Produced/consumed on the client; the server stores it verbatim.
export type OneLocationEncryptedPrivateKey = {
  ciphertext: string;
  iv: string;
  tag: string;
  algorithm?: string;
};

// The caller's OWN active recipient key, returned only to that user by list_state.
// Lets any of the user's devices recover the same keypair after vault unlock.
export type OneLocationMyRecipientKey = {
  keyId: string | null;
  publicKeyJwk?: JsonWebKey | null;
  keyAlgorithm: string;
  encryptedPrivateKeyJwk?: OneLocationEncryptedPrivateKey | null;
  keyRegisteredAt?: string | null;
};

export type OneLocationState = {
  recipients: OneLocationRecipient[];
  circles?: OneLocationCircleSummary[];
  /** Pending targeted invitations for this user to join a named Circle. */
  circleMemberInvites?: OneLocationCircleMemberInvite[];
  myRecipientKey?: OneLocationMyRecipientKey | null;
  kaiCircleCandidates?: KaiCircleCandidate[];
  viewerCapabilities?: OneLocationViewerCapabilities;
  ownerGrants: OneLocationGrant[];
  receivedGrants: OneLocationGrant[];
  requests: OneLocationAccessRequest[];
  referrals: OneLocationReferral[];
  publicInvites: OneLocationPublicInvite[];
  circleInvites?: OneLocationCircleInvite[];
  networkConnections?: OneLocationNetworkConnection[];
  /** Owner-selected, connected recipients eligible for Save My Soul alerts. */
  smsContactUserIds?: string[];
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

export type OneLocationNearbyPlaceCategory =
  | "all"
  | "food_drink"
  | "health"
  | "shopping_services"
  | "hotels_stays"
  | "education"
  | "outdoors_landmarks"
  | "transit";

export type OneLocationNearbyPlaceSuggestion = {
  placeId: string;
  /** Compatibility label used by autocomplete and older provider responses. */
  text: string;
  name?: string | null;
  address?: string | null;
  primaryType?: string | null;
  category?: string | null;
  /** Present for strict nearby results; generic autocomplete does not return it. */
  distanceMeters?: number | null;
};

export type OneLocationNearbyRelationship =
  | "none"
  | "pending_outgoing"
  | "pending_incoming"
  | "connected";

export type OneLocationNearbyAttendee = {
  /** Rotating, presence-scoped alias. A stable user id is never returned. */
  participantAlias: string;
  displayName: string;
  relationship: OneLocationNearbyRelationship;
  canConnect: boolean;
};

export type OneLocationNearbyPresence = {
  status: "active";
  audience: "all_opted_in";
  /** Fixed mutual-discovery radius selected by the server contract. */
  radiusMeters: number;
  allowConnectionRequests: boolean;
  consentVersion: string;
  checkedInAt: string;
  expiresAt: string;
  placeLabel?: string | null;
};

export type OneLocationNearbyPresenceState = {
  presence: OneLocationNearbyPresence | null;
  attendees: OneLocationNearbyAttendee[];
  checkedOut?: boolean;
};

export type DriveDestination = {
  label: string;
  latitude: number;
  longitude: number;
  placeId?: string | null;
};

export type TrafficLevel = "light" | "moderate" | "heavy";

export type RouteEta = {
  etaSeconds: number;
  distanceMeters: number;
  trafficLevel?: TrafficLevel | null;
};

/**
 * Drive-To payload carried INSIDE the encrypted envelope (never sent to the
 * backend in plaintext). Recipients decrypt the point and read destination +
 * latest ETA from here.
 */
export type DriveSharePayload = {
  destination: DriveDestination;
  etaSeconds: number | null;
  distanceMeters: number | null;
  etaComputedAt: string;
};

export type CheckInSharePayload = {
  /**
   * User-authored Check-In note. It is encrypted with the coordinates and is
   * never persisted in grant, audit, URL, or notification metadata.
   */
  message: string;
};

export type PlainLocationPoint = {
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  capturedAt: string;
  sourcePlatform: LocationSourcePlatform;
  /**
   * Present only for Drive-To shares. Encrypted together with the point, so the
   * backend never sees the destination or ETA.
   */
  drive?: DriveSharePayload | null;
  /**
   * Present only for Check-In shares. Encrypted together with the point.
   */
  checkIn?: CheckInSharePayload | null;
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
  /**
   * Privacy boundary for this ciphertext. Only foreground_map_visible is
   * eligible for Your Map; direct/background shares are never promoted.
   */
  publicationContext?:
    | "private_background"
    | "private_foreground"
    | "foreground_map_visible";
  createdAt?: string | null;
  metadata?: Record<string, unknown>;
};

export type OneLocationMapPreferences = {
  presenceMode: "ghost" | "foreground_private";
  rendererConsentVersion?: string | null;
  updatedAt?: string | null;
};

export type OneLocationMapMarker = {
  grant: OneLocationGrant;
  envelope: OneLocationEncryptedEnvelope;
};

export type OneLocationMapState = {
  preferences: OneLocationMapPreferences;
  freshnessSeconds: number;
  markers: OneLocationMapMarker[];
};

export interface ShareTarget {
  grantId: string;
  recipientUserId: string;
  recipientKeyId: string;
  label: string;
}

export type ClientActionType = "publish_share" | "view_envelope" | "create_public_link" | "sos_panic" | "check_in";

export interface ClientAction {
  id: string;
  type: ClientActionType;
  shares?: ShareTarget[];
  grantId?: string;
  durationHours?: number;
  note?: string | null;
  summary: string;
}

export interface ActionResult {
  id: string;
  type: ClientActionType;
  status: "completed" | "cancelled" | "failed";
  publicUrl?: string;
  detail?: string;
}

export interface PromptOption {
  label: string;
  ref: Record<string, unknown>;
  hint?: string | null;
}

export type ClientPromptKind = "select" | "confirm";

export interface ClientPrompt {
  id: string;
  kind: ClientPromptKind;
  purpose: string;
  question: string;
  options?: PromptOption[];
  minSelections?: number;
  maxSelections?: number | null;
  allowFreeText?: boolean;
  confirmLabel?: string | null;
  cancelLabel?: string | null;
  destructive?: boolean;
}

export interface SelectionResult {
  id: string;
  kind: ClientPromptKind;
  selected?: Record<string, unknown>[];
  confirmed?: boolean;
  freeText?: string;
  status: "answered" | "cancelled";
  display?: string;
}

export interface LocationChatResponse {
  conversationId: string;
  response: string;
  isComplete: boolean;
  stateChanged: boolean;
  clientAction?: ClientAction;
  clientPrompt?: ClientPrompt;
  availability?: {
    state: "runtime_unavailable";
    reasonCode: "managed_runtime_unavailable";
  };
}
