export type LocationContactTier = "family" | "friend";
export type LocationContactStatus = "active" | "revoked";
export type LocationShareStatus = "active" | "expired" | "deactivated" | "revoked";
export type LocationAccessRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "auto_approved";
export type LocationSourcePlatform = "web" | "ios" | "android" | "native" | "unknown";
export type PublicLocationShareState =
  | "active"
  | "expired"
  | "deactivated"
  | "revoked"
  | "invalid";

export interface LocationLatestPoint {
  ownerUserId?: string;
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  headingDeg?: number | null;
  speedMps?: number | null;
  capturedAt: string;
  sourcePlatform: LocationSourcePlatform;
  updatedAt?: string | null;
}

export interface LocationLiveState {
  transport: "gcp_polling";
  pollIntervalMs: number;
  staleAfterSeconds: number;
  serverTime: string | null;
  isLive: boolean;
  freshnessSeconds: number | null;
  stoppedAt: string | null;
}

export interface LocationContact {
  id: string;
  ownerUserId: string;
  displayName: string;
  tier: LocationContactTier;
  autoApprove: boolean;
  status: LocationContactStatus;
  createdAt: string | null;
  updatedAt: string | null;
  revokedAt: string | null;
}

export interface LocationShare {
  id: string;
  ownerUserId: string;
  contactId: string | null;
  contactDisplayName: string | null;
  contactTier: LocationContactTier | null;
  contactAutoApprove: boolean | null;
  status: LocationShareStatus;
  liveMode: boolean;
  expiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastViewedAt: string | null;
  deactivatedAt: string | null;
  revokedAt: string | null;
}

export interface LocationAccessRequest {
  id: string;
  shareId: string;
  ownerUserId: string;
  contactId: string | null;
  contactDisplayName: string | null;
  contactTier: LocationContactTier | null;
  status: LocationAccessRequestStatus;
  requesterLabel: string | null;
  requesterMessage: string | null;
  requestedAt: string | null;
  resolvedAt: string | null;
  renewedShareId: string | null;
}

export interface LocationOwnerState {
  contacts: LocationContact[];
  shares: LocationShare[];
  accessRequests: LocationAccessRequest[];
  latest: LocationLatestPoint | null;
  limits: {
    family: number;
    friend: number;
  };
}

export interface LocationCreateShareResponse {
  share: LocationShare;
  token: string;
  latest: LocationLatestPoint;
}

export interface LocationPublicView {
  state: PublicLocationShareState;
  canRequestAccess: boolean;
  share: LocationShare | null;
  latest: LocationLatestPoint | null;
  live?: LocationLiveState | null;
}

export interface LocationAccessRequestResponse {
  status: LocationAccessRequestStatus;
  accessRequest: LocationAccessRequest | null;
  share: LocationShare | null;
  publicView: LocationPublicView | null;
}

export interface LocationUpdateSession {
  token: string;
  expiresAt: string | null;
  endpointPath: string;
}

export interface LocationHeartbeatResult {
  ok: boolean;
  latest: LocationLatestPoint;
}
