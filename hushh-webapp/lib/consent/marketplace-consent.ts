"use client";

// Frontend recognizer for Information Marketplace consent entries inside the
// shared consent center (/consents). Mirrors `location-consent.ts`: the consent
// center stays generic over `ConsentCenterEntry`, and marketplace access
// requests "plug in" through a metadata flag + this small parser.
//
// Marketplace rows are emitted by the backend `MarketplaceCenterContributor`
// (see hushh_mcp/services/marketplace_center_contributor.py). They carry
// `metadata.request_source === "marketplace_access_request"`, an id of the form
// `marketplace_request:{id}`, and enough context (role/domain/scope_handle/
// slice_name) for the approve hook to seal a slice for the buyer.

type MetadataLike = Record<string, unknown> | null | undefined;

/** The request source flag the backend contributor stamps on every row. */
export const MARKETPLACE_REQUEST_SOURCE = "marketplace_access_request";

const MARKETPLACE_ID_PREFIX = "marketplace_request";

function readString(metadata: MetadataLike, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A consent entry belongs to the Information Marketplace when its metadata
 * carries the marketplace request source. (Scope is not a reliable signal here
 * because marketplace scopes reuse the generic `attr.<domain>` family.)
 */
export function isMarketplaceConsent(metadata: MetadataLike, _scope?: string | null): boolean {
  return readString(metadata, "request_source") === MARKETPLACE_REQUEST_SOURCE;
}

/** The caller's role for a marketplace consent row. */
export type MarketplaceConsentRole = "owner" | "buyer" | "unknown";

export interface MarketplaceConsentEntryRef {
  /** The underlying marketplace access-request id. */
  requestId: string;
  /** Whether the caller is the seller (`owner`) or the requester (`buyer`). */
  role: MarketplaceConsentRole;
  /** Domain of the requested slice (e.g. `travel`). */
  domain: string;
  /** The published scope handle, when the request carried one. */
  scopeHandle: string;
  /** Human label for the requested slice. */
  sliceName: string;
}

interface ParseableMarketplaceConsentEntry {
  id?: string | null;
  request_id?: string | null;
  scope?: string | null;
  scope_description?: string | null;
  metadata?: MetadataLike;
}

/**
 * Resolve a consent-center entry back to its marketplace access request. The id
 * suffix (`marketplace_request:{id}`) is the authoritative request id, with
 * `metadata.request_id` / `request_id` as fallbacks.
 */
export function parseMarketplaceConsentEntry(
  entry: ParseableMarketplaceConsentEntry,
): MarketplaceConsentEntryRef {
  const rawId = String(entry.id || "").trim();
  const separatorIndex = rawId.indexOf(":");
  const prefix = separatorIndex >= 0 ? rawId.slice(0, separatorIndex) : "";
  const suffix = separatorIndex >= 0 ? rawId.slice(separatorIndex + 1) : "";

  const requestId =
    (prefix === MARKETPLACE_ID_PREFIX ? suffix.trim() : "") ||
    readString(entry.metadata, "request_id") ||
    String(entry.request_id || "").trim();

  const roleRaw = readString(entry.metadata, "role");
  const role: MarketplaceConsentRole =
    roleRaw === "owner" || roleRaw === "buyer" ? roleRaw : "unknown";

  return {
    requestId,
    role,
    domain: readString(entry.metadata, "domain"),
    scopeHandle:
      readString(entry.metadata, "scope_handle") || String(entry.scope || "").trim(),
    sliceName:
      readString(entry.metadata, "slice_name") ||
      String(entry.scope_description || "").trim(),
  };
}
