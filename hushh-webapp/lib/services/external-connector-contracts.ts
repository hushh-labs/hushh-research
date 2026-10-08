/** Owner connector wire contracts; status never grants provider authority. */

export type ExternalConnectorAuthStyle = "api_key" | "oauth";

export type ExternalConnectorStatus =
  | "not_connected"
  | "connected"
  | "verifying"
  | "needs_reauth"
  | "revoked"
  | "error";

export type StripeConnectorReadiness = {
  toolingConnected: boolean;
  accountVerified: boolean;
  environmentVerified: boolean;
  accountToolsAvailable: boolean;
  capability: "documentation_only" | "account_balance_readonly";
  nextStep: "authenticated_account_contract_required" | "ready";
  managementPath: "/one/profile/connectors";
  verificationState?: "unverified" | "verified" | "unsupported" | "mismatch" | "expired";
  reasonCode?: string | null;
  verifiedAt?: string | null;
  configurationRevision?: string | null;
  catalogFingerprint?: string | null;
};

export type ExternalConnectorSummary = {
  connectorId: string;
  displayName: string;
  description: string;
  authStyle: ExternalConnectorAuthStyle;
  status: ExternalConnectorStatus;
  accountLabel?: string | null;
  connectedAt?: string | null;
  validationState?: string;
  profile?: "selected" | "live" | null;
  revocationOutcome?: string;
  lastErrorCode?: string | null;
  available?: boolean;
  /** Server-derived: an operator-registered OAuth provider with a reviewed manifest. */
  curatedOAuth?: boolean;
  /** Server-declared built-in card; presentation only and never an OAuth grant. */
  catalogCard?: boolean;
  /** Why a server-declared catalog card cannot yet start a connection. */
  catalogState?: "setup_pending" | "discovery_pending" | "unavailable" | null;
  stripeReadiness?: StripeConnectorReadiness | null;
};

export type ConnectorFeatures = Partial<
  Record<
    | "connections_panel_v2"
    | "google_drive_connection"
    | "google_drive_live"
    | "google_drive_picker"
    | "drive_document_indexing"
    | "drive_document_sharing"
    | "gmail_chat_reads"
    | "google_drive_chat_reads"
    | "curated_mcp_connectors",
    boolean
  >
>;
export type ConnectorOverview = {
  connectors: ExternalConnectorSummary[];
  features: ConnectorFeatures;
};
export type DriveDocument = {
  documentId: string;
  name: string;
  mimeType: string;
  status: string;
  backgroundProcessing?: boolean;
};

export type NativeDriveOAuthOutcome = "ready" | "cancelled" | "failed";

export type NativeDriveOAuthReturn = {
  attemptId: string;
  outcome: NativeDriveOAuthOutcome;
};

export type PendingNativeDriveAttempt = {
  attemptId: string;
  expiresAt: string;
};

/**
 * Metadata returned only after the native Picker browser flow has settled at
 * the server.  These are candidates, not selected One documents: the owner
 * must still explicitly confirm them through the owner-protected endpoint.
 */
export type NativeDrivePickerCandidate = {
  documentId: string;
  name: string;
  mimeType: string;
};

export type PendingNativeDrivePicker = {
  attemptId: string;
  expiresAt: string;
  files: NativeDrivePickerCandidate[];
};

export type ConnectorEffectGuard = () => boolean;
