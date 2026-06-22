/**
 * lib/connect/types.ts
 *
 * Unified candidate model for the Connect Tab.
 * Existing MarketplaceRia, MarketplaceInvestor, and consent-center types are
 * preserved in their own modules — this is the *normalized* layer only used
 * by Connect UI components.
 */

// ─── Candidate Classification ─────────────────────────────────────────────────

export type ConnectCandidateKind =
  | "ria"
  | "investor"
  | "hushh_user"
  | "public_profile"
  | "contact_match";

export type ConnectCandidateSource =
  | "marketplace_ria"
  | "marketplace_investor"
  | "contact_match"
  | "active_connection"
  | "pending_connection"
  | "previous_connection"
  | "profile_visibility"
  | "public_sec"
  | "kai_test";

export type ConnectVisibilityPosture =
  | "private"
  | "default_available"
  | "limited"
  | "public"
  | string;

export type ConnectStatus =
  | "available"
  | "connected"
  | "pending"
  | "previous"
  | "passed"
  | "shortlisted"
  | "connect_requested"
  | "not_connectable"
  | "private";

export type ConnectPrimaryCta =
  | "connect"
  | "open_profile"
  | "view_connection"
  | "review_request"
  | "shortlist"
  | "undo_pass"
  | "none";

// ─── Reason ───────────────────────────────────────────────────────────────────

export type ConnectCandidateReason = {
  code: string;
  label: string;
  weight: number;
  source: ConnectCandidateSource;
};

// ─── Main Candidate ───────────────────────────────────────────────────────────

export type ConnectCandidate = {
  /**
   * Stable ID for deduplication.
   * Format rules:
   *   - userId exists        → "user:<userId>"
   *   - public profile only  → "public:<sourceType>:<publicProfileId>"
   *   - contact-only         → "contact:<stableLocalId>"
   */
  candidateId: string;
  kind: ConnectCandidateKind;
  sourceTypes: ConnectCandidateSource[];

  userId?: string | null;
  publicProfileId?: string | number | null;
  sourceType?: string | null;

  /** Raw backing profile objects for actions that need them */
  _rawRiaProfile?: unknown;
  _rawInvestorProfile?: unknown;
  _rawConsentEntry?: unknown;

  displayName: string;
  headline?: string | null;
  summary?: string | null;
  avatarUrl?: string | null;
  firmName?: string | null;
  locationLabel?: string | null;

  visibilityPosture?: ConnectVisibilityPosture | null;
  exposureEnabled?: boolean | null;
  isDiscoverable: boolean;

  verificationStatus?: string | null;
  verificationBadge?: string | null;

  connectionStatus: ConnectStatus;
  actionStatus?: "viewed" | "passed" | "shortlisted" | "connect_requested" | null;

  score: number;
  reasons: ConnectCandidateReason[];

  primaryCta: ConnectPrimaryCta;
  secondaryCtas: ConnectPrimaryCta[];

  profileHref?: string | null;
  connectionHref?: string | null;

  lastInteractionAt?: string | null;

  /** Test/demo profiles — hide connect CTAs */
  isTestProfile?: boolean;
};

// ─── Sections ─────────────────────────────────────────────────────────────────

export type ConnectSectionKey =
  | "contacts"
  | "active_connections"
  | "pending_connections"
  | "recommended"
  | "advisors"
  | "investors"
  | "recent_actions"
  | "hidden_or_unavailable";

export type ConnectSection = {
  key: ConnectSectionKey;
  label: string;
  description?: string | null;
  candidates: ConnectCandidate[];
  isEmpty: boolean;
};

// ─── Contact State ────────────────────────────────────────────────────────────

export type ConnectContactState = {
  available: boolean;
  loading: boolean;
  permissionStatus?: string | null;
  summary?: string | null;
  error?: string | null;
  matchedCount?: number;
  totalContacts?: number;
  sourcePlatform?: "web" | "ios" | "android" | "native" | "unknown" | null;
  /** true once a scan has been completed at least once this session */
  hasScanned: boolean;
};

// ─── Discovery Hook Return ────────────────────────────────────────────────────

export type ConnectDiscoveryOptions = {
  query: string;
  activePersona: "investor" | "ria";
  view: "all" | "contacts" | "advisors" | "investors" | "connections";
  includeContacts: boolean;
  limit?: number;
};

export type ConnectDiscoveryResult = {
  candidates: ConnectCandidate[];
  sections: ConnectSection[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  iamUnavailable: boolean;
  contactState: ConnectContactState;
  actions: {
    refresh(): Promise<void>;
    matchContacts(): Promise<{
      matches: Array<{ user_id?: string | null }>;
      totalContacts: number;
      sourcePlatform?: "web" | "ios" | "android" | "native" | "unknown" | null;
    } | null>;
    recordAction(
      candidate: ConnectCandidate,
      action: "view_more" | "pass" | "shortlist" | "connect_request",
    ): Promise<void>;
    connect(candidate: ConnectCandidate): Promise<void>;
    openProfile(candidate: ConnectCandidate): void;
  };
};

// ─── Raw Aggregator Payload ───────────────────────────────────────────────────

export type ConnectRawPayload = {
  rias: unknown[];
  investors: unknown[];
  contactMatches: unknown[];
  activeConnections: unknown[];
  pendingConnections: unknown[];
  previousConnections: unknown[];
  riaRelationships: unknown[];
  investorActions: unknown[];
  iamUnavailable: boolean;
};
