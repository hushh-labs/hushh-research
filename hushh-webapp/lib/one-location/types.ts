export type LocationSourcePlatform =
  | "web"
  | "ios"
  | "android"
  | "native"
  | "unknown";

export type OneLocationShareDurationMode = "timed" | "until_stopped";

export type AutoApproveScope =
  | { kind: "all_contacts" }
  | { kind: "circle"; circleId: string };

export type OneLocationAutoApprovePreference = {
  enabled: boolean;
  scope: AutoApproveScope | null;
  enabledAt: string | null;
  ruleVersion: number;
  updatedAt?: string | null;
};

export type OneLocationNearbyCheckInPreference = {
  visible: boolean;
  allowConnectionRequests: boolean;
  updatedAt?: string | null;
};

/**
 * What a bare emergency voice phrase ("save me", "turn on sos") does:
 * "open" shows the SOS screen, "trigger" goes straight to the send-alert
 * confirm card. Neither sends an alert by itself -- trigger_sos's own
 * confirm card is never skipped.
 */
export type OneLocationSosVoiceDefaultAction = "open" | "trigger";

export type OneLocationSosVoicePreference = {
  defaultAction: OneLocationSosVoiceDefaultAction;
  updatedAt?: string | null;
};

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
  photoUrl?: string | null;
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
  connectedFromContacts?: boolean;
  isRia?: boolean;
};

export type OneLocationRecipientPage = {
  items: OneLocationRecipient[];
  page: number;
  hasMore: boolean;
  totalCount: number;
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
  requesterPhotoUrl?: string | null;
  requesterMaskedPhone?: string | null;
  ownerDisplayName?: string | null;
  ownerPhotoUrl?: string | null;
  ownerMaskedPhone?: string | null;
  referredByUserId?: string | null;
  status: "pending" | "approved" | "denied" | "cancelled" | string;
  message?: string | null;
  requestedAt?: string | null;
  resolvedAt?: string | null;
  approvedGrantId?: string | null;
  /**
   * How much time the requester actually asked for. A request, never an
   * authorization — the grant is still written only when the owner approves.
   * Null means they expressed no preference and the owner picks the amount.
   */
  requestedDurationHours?: number | null;
  requestedDurationMode?: OneLocationShareDurationMode | string | null;
  /**
   * The live grant this ask wants lengthened. Present makes the ask "3 hours
   * MORE" rather than "3 hours"; the backend resolves it from the real grant
   * between the two people, so it is trustworthy on both sides.
   */
  extendsGrantId?: string | null;
  /** True exactly when `extendsGrantId` is set; carried so surfaces read one flag. */
  isExtension?: boolean;
  /** Expiry of the share being extended, for "on top of the 45 minutes left". */
  extendsGrantExpiresAt?: string | null;
  /**
   * Bumped whenever a still-pending ask changes (1 hour re-asked as 4). Keeps
   * the client's per-request notification de-dup from swallowing the new ask.
   */
  requestRevision?: number | null;
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
  /**
   * The owner's own share link, app-relative (`/one/location/view/<token>`).
   *
   * Present only for the owner, and only while the invite is still usable. The
   * token used to be returned exactly once, at creation, and nothing could
   * recover it afterwards -- so after a reload the app knew a link was live and
   * had nothing to copy. The server now derives it from the invite id and hands
   * it back on every read.
   *
   * Still optional, and callers must treat it that way: an invite minted before
   * the token was derivable has no recoverable link, and the field is absent
   * rather than wrong.
   */
  publicUrl?: string | null;
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
  /** False for a system Circle: everything else an owner may do still applies. */
  canDeleteCircle?: boolean;
  /** Stated by the server rather than inferred from "not the owner".
   *
   *  A system Circle's owner was offered a Leave that `_end_membership`
   *  refuses every time, and a Trusted Circle cannot be left by anybody: its
   *  roster IS the connection graph, so the way out is to disconnect. */
  canLeaveCircle?: boolean;
  canModerateInvites: boolean;
};

export type OneLocationCircleSummary = {
  id: string;
  name: string;
  kind: OneLocationCircleKind;
  role: OneLocationCircleRole;
  memberCount: number;
  /** `null` where the product does not impose one.
   *
   *  A Trusted Circle mirrors the connection graph and connections are not
   *  capped, so the server reports no ceiling for it rather than the number it
   *  happens to store. */
  memberLimit: number | null;
  /**
   * Provisioned and depended on by the product (today: the SMS/Emergency
   * Circle). Members are managed normally; the Circle itself cannot be deleted.
   *
   * A Trusted Circle is deliberately NOT flagged here -- migration 163 carries
   * the reasoning -- so read `systemKind` to ask "is this the product's", and
   * this only to ask "is this the emergency one, on a server old enough not to
   * say".
   */
  isSystem?: boolean;
  /** Which product-managed Circle this is, or `null` for one a person named. */
  systemKind?: "sms" | "trusted" | null;
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
  /**
   * The viewer's relationship with this member.
   *
   * Sharing a Circle is not being connected -- a joiner is paired with whoever
   * invited them and nobody else -- so the roster is where the introduction the
   * Circle declines to make can be offered explicitly.
   */
  relationship?: OneLocationCircleMemberRelationship;
  /** False when there is nothing to request: self, connected, or already pending. */
  canConnect?: boolean;
  connectedFromContacts?: boolean;
  isRia?: boolean;
};

export type OneLocationCircleMemberRelationship =
  | "self"
  | "none"
  | "pending_outgoing"
  | "pending_incoming"
  | "connected";

export type OneLocationCircleDetail = OneLocationCircleSummary & {
  members: OneLocationCircleMember[];
  activeInviteCode?: OneLocationCircleInviteCode | null;
  /** True only for a legacy active code that must be explicitly rotated by the owner. */
  inviteCodeNeedsOwnerRotation?: boolean;
};

/** Circle metadata/capabilities returned without materializing its roster. */
export type OneLocationCircleOverview = OneLocationCircleSummary & {
  activeInviteCode?: OneLocationCircleInviteCode | null;
  /** True only for a legacy active code that must be explicitly rotated by the owner. */
  inviteCodeNeedsOwnerRotation?: boolean;
};

export type OneLocationCircleMemberPage = {
  items: OneLocationCircleMember[];
  page: number;
  hasMore: boolean;
  totalCount: number;
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
  connectedFromContacts?: boolean;
  isRia: boolean;
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

export type OneLocationCircleEligibleConnectionsPage =
  OneLocationCircleEligibleConnections & {
    page: number;
    hasMore: boolean;
    totalCount: number;
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
  /** Server-owned, cross-device standing approval rule. */
  autoApprovePreference?: OneLocationAutoApprovePreference;
  /** Server-owned Nearby Check-In visibility and connection-request defaults. */
  nearbyCheckInPreferences?: OneLocationNearbyCheckInPreference;
  /** Server-owned default for a bare emergency voice phrase (open vs trigger). */
  sosVoicePreference?: OneLocationSosVoicePreference;
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
  | "transit"
  | "worship"
  | "civic"
  // The catch-all. A real venue that belongs to none of the above, plus every
  // venue Google names but does not describe -- so a row is never reachable
  // from "All" alone.
  | "other";

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
  /**
   * The venue's public point. Present on nearby results so the map can pin the
   * place the owner is choosing separately from where they are standing.
   * Autocomplete does not return it; the sheet resolves it on selection.
   */
  latitude?: number | null;
  longitude?: number | null;
  /**
   * Category chips this place belongs to. Lets the drawer filter the merged
   * nearby sweep locally instead of re-querying per chip and re-truncating.
   */
  categories?: OneLocationNearbyPlaceCategory[] | null;
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
  /**
   * The owner's own check-in anchor — the public venue they picked, not their
   * live position. Returned only to the owner so the map can keep showing where
   * they checked in after a reload, and how far they have since drifted from
   * it. No other participant's anchor is ever exposed.
   */
  placeLat?: number | null;
  placeLng?: number | null;
  /**
   * The provider place id for that anchor, so the checkout pane can offer the
   * Google review hand-off without guessing which venue it was. Optional: an
   * older backend simply omits it, and everything except that one button works
   * exactly the same without it.
   */
  placeId?: string | null;
};

/** One person's own star rating for a place they were recorded at. */
export type OneLocationPlaceRating = {
  id: string;
  placeId: string;
  placeLabel: string;
  rating: number;
  /** False for a category that never carries a public average (health, worship,
   *  legal, funeral, shelter). The rating is still the author's own. */
  countsTowardAverage: boolean;
  consentVersion: string;
  /** False once the consent text has moved on, until the author re-accepts. */
  consentCurrent: boolean;
  visitedAt?: string | null;
  visitCount: number;
  revision: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  googleReviewUrl?: string | null;
};

/** A completed visit the owner could still rate. */
export type OneLocationRateableVisit = {
  visitId: string;
  placeId: string;
  placeLabel: string | null;
  placeCategory?: string | null;
  visitedAt?: string | null;
  expiresAt?: string | null;
  googleReviewUrl?: string | null;
  consentVersion: string;
};

export type OneLocationNearbyPresenceState = {
  presence: OneLocationNearbyPresence | null;
  attendees: OneLocationNearbyAttendee[];
  checkedOut?: boolean;
  /**
   * On checkout only: the place just left, and whether it can be rated.
   *
   * Returned by the server rather than remembered on the device, because the
   * client never held the place id in the first place -- the presence payload
   * has only a label and a point. Absent whenever there is nothing rateable,
   * which the pane treats as "no rating step", never as an error.
   */
  reviewPrompt?: OneLocationRateableVisit | null;
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

/**
 * Result of storing one encrypted envelope.
 *
 * `recipientAlerted` reports whether the recipient had a device the alert could
 * be delivered to — not FCM's eventual delivery result, which stays
 * asynchronous. Only Save My Soul notifies from the envelope-store route, so
 * every other share kind leaves it `null`. `null` means "not reported" and must
 * never be rendered as a delivery failure.
 */
export type OneLocationStoredEnvelope = {
  envelope: OneLocationEncryptedEnvelope;
  recipientAlerted: boolean | null;
};

export type OneLocationMapPreferences = {
  /**
   * General map visibility. "ghost" hides this account from its connections at
   * large; "foreground_private" does not.
   *
   * It is NOT a switch over private sharing. An active grant is delivered to
   * the one person it names in either mode, because creating that grant was
   * already the decision to be seen by them -- the server used to require both
   * and, since this defaults to "ghost", that made private sharing silently
   * inert by default. See `list_map_state` in
   * `consent-protocol/hushh_mcp/services/one_location_agent_service.py`.
   */
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
