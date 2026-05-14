// AUTO-GENERATED — Beast Mode Architecture by Abdul Gaffar
// Source:  consent-protocol/schemas.py
// Script:  scripts/export_schemas.py
// Sync CI: scripts/ci/schema-sync-check.sh
//
// DO NOT EDIT MANUALLY.
// Re-generate with:  cd consent-protocol && uv run python ../scripts/export_schemas.py
//
// This file bridges the Python FastAPI backend (Pydantic v2) and the Next.js
// frontend (TypeScript), eliminating manual interface re-definition and
// ensuring 100% type parity across the consent approval flow.

export interface ConsentApprovalPayload {
  userId: string;
  requestId: string;
  /** Unix timestamp in milliseconds when the approval was initiated. */
  timestamp?: number | null;
  /** Consent scopes being approved, e.g. ['attr.financial.*']. */
  permissionLevels?: string[];
  encryptedData?: string | null;
  encryptedIv?: string | null;
  encryptedTag?: string | null;
  wrappedExportKey?: string | null;
  wrappedKeyIv?: string | null;
  wrappedKeyTag?: string | null;
  senderPublicKey?: string | null;
  wrappingAlg?: string | null;
  connectorKeyId?: string | null;
  durationHours?: number | null;
  sourceContentRevision?: number | null;
  sourceManifestRevision?: number | null;
}

// ---------------------------------------------------------------------------
// Convenience aliases — wire-format matches FastAPI camelCase JSON output
// ---------------------------------------------------------------------------

/** Minimum fields required in every approval request body. */
export type ConsentApprovalRequired = Pick<
  ConsentApprovalPayload,
  "userId" | "requestId"
>;

/** Full approval request body (required core + optional ZK-encrypted fields). */
export type ConsentApprovalBody = ConsentApprovalPayload;
