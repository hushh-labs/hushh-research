import { ApiService } from "@/lib/services/api-service";
import type { KycScopedExportPackage } from "@/lib/services/one-kyc-client-zk-service";

export type PublicPersonProfile = {
  personRef: string;
  displayName: string;
  photoUrl: string | null;
  verifiedRole: string | null;
};

export type PersonRelationship = {
  status: "none" | "pending_outgoing" | "pending_incoming" | "connected";
  connectionId: string | null;
  connectedAt: string | null;
  requestId: string | null;
};

export type RequestablePersonScope = {
  scopeRef: string;
  label: string | null;
  description: string | null;
  domain: string | null;
  sensitivity: string | null;
  wildcard: boolean;
  pathSegments?: string[];
};

export type PersonGrant = {
  scopeRef: string | null;
  label: string;
  domain: string | null;
  requestId: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
  status: "granted";
  encryptedExportAvailable: boolean;
  /** Current encrypted export revision; never contains export contents. */
  exportRevision?: number | null;
};

export type ViewerPersonProfile = PublicPersonProfile & {
  relationship: PersonRelationship;
  requestableScopes: RequestablePersonScope[];
  grants: PersonGrant[];
  requestHistory: PersonInformationRequestHistory[];
  scopeCatalog?: PersonScopeCatalog;
};

export type PersonScopeCatalog = {
  page: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
  nextPage: number | null;
  catalogRevision: string;
  paginationReset: boolean;
  domains: Array<{ domain: string; count: number }>;
};

export function mergePersonScopePage(
  current: ViewerPersonProfile,
  next: ViewerPersonProfile,
): ViewerPersonProfile {
  if (current.personRef !== next.personRef) throw new Error("The selected person could not be verified.");
  if (!current.scopeCatalog || !next.scopeCatalog || next.scopeCatalog.paginationReset
    || current.scopeCatalog.catalogRevision !== next.scopeCatalog.catalogRevision
    || next.scopeCatalog.page === 1) return next;
  if (next.scopeCatalog.page !== current.scopeCatalog.nextPage) {
    throw new Error("Available information changed. Please check again.");
  }
  const scopes = new Map(current.requestableScopes.map(item => [item.scopeRef, item]));
  next.requestableScopes.forEach(item => scopes.set(item.scopeRef, item));
  return { ...next, requestableScopes: [...scopes.values()] };
}

export type PersonInformationRequestHistory = {
  bundleId: string;
  requestId: string;
  scopeRef: string;
  label: string;
  sensitivity: string | null;
  purpose: string;
  durationSeconds: number;
  createdAt: string | null;
  expiresAt: number | null;
  status:
    | "pending"
    | "granted"
    | "denied"
    | "expired"
    | "revoked"
    | "cancelled";
};

export type PersonRequestHistoryPage = {
  bundles: Array<{
    bundleId: string;
    purpose: string;
    durationSeconds: number;
    createdAt: string;
    cancelled: boolean;
    itemCount: number;
  }>;
  nextCursor: string | null;
};

export type InformationRequestBundle = {
  personRef: string;
  bundleId: string;
  purpose: string;
  durationSeconds: number;
  cancelled: boolean;
  items: Array<{
    requestId: string;
    scopeRef: string;
    label: string;
    sensitivity: string | null;
    status:
      | "pending"
      | "granted"
      | "denied"
      | "expired"
      | "revoked"
      | "cancelled";
  }>;
};

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    detail?: string;
  };

  if (!response.ok) {
    throw new Error(payload.detail || "Person profile is unavailable.");
  }
  return payload;
}

export class PersonProfileService {
  static async getRequestHistory(input: {
    personRef: string;
    idToken: string;
    cursor?: string;
    limit?: number;
  }): Promise<PersonRequestHistoryPage> {
    const query = new URLSearchParams({ limit: String(input.limit ?? 8) });
    if (input.cursor) query.set("cursor", input.cursor);
    return jsonOrThrow<PersonRequestHistoryPage>(
      await ApiService.apiFetch(
        `/api/one/people/${encodeURIComponent(input.personRef)}/request-history?${query}`,
        { cache: "no-store", headers: { Authorization: `Bearer ${input.idToken}` } },
      ),
    );
  }

  static async getInformationRequestExports(input: {
    bundleId: string;
    vaultOwnerToken: string;
  }): Promise<Array<{ requestId: string; scopeRef: string; encryptedExport: KycScopedExportPackage }>> {
    const payload = await jsonOrThrow<{
      exports: Array<{ requestId: string; scopeRef: string; encryptedExport: KycScopedExportPackage }>;
    }>(
      await ApiService.apiFetch(
        `/api/one/information-requests/${encodeURIComponent(input.bundleId)}/exports`,
        { headers: { Authorization: `Bearer ${input.vaultOwnerToken}` } },
      ),
    );
    return payload.exports || [];
  }

  static async getInformationRequest(input: {
    bundleId: string;
    vaultOwnerToken: string;
  }): Promise<InformationRequestBundle> {
    return jsonOrThrow<InformationRequestBundle>(
      await ApiService.apiFetch(
        `/api/one/information-requests/${encodeURIComponent(input.bundleId)}`,
        { headers: { Authorization: `Bearer ${input.vaultOwnerToken}` } },
      ),
    );
  }

  static async cancelInformationRequest(input: {
    bundleId: string;
    vaultOwnerToken: string;
  }): Promise<InformationRequestBundle> {
    return jsonOrThrow<InformationRequestBundle>(
      await ApiService.apiFetch(
        `/api/one/information-requests/${encodeURIComponent(input.bundleId)}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${input.vaultOwnerToken}` },
        },
      ),
    );
  }

  static async getPublic(personRef: string): Promise<PublicPersonProfile> {
    return jsonOrThrow<PublicPersonProfile>(
      await ApiService.apiFetch(`/api/public/people/${encodeURIComponent(personRef)}`, {
        cache: "no-store",
      }),
    );
  }

  static async getViewer(
    personRef: string,
    idToken: string,
    catalog?: { page?: number; revision?: string; query?: string; domain?: string },
  ): Promise<ViewerPersonProfile> {
    const query = new URLSearchParams();
    if (catalog?.page) query.set("catalog_page", String(catalog.page));
    if (catalog?.revision) query.set("catalog_revision", catalog.revision);
    if (catalog?.query) query.set("catalog_query", catalog.query);
    if (catalog?.domain) query.set("catalog_domain", catalog.domain);
    const result = await jsonOrThrow<ViewerPersonProfile>(
      await ApiService.apiFetch(`/api/one/people/${encodeURIComponent(personRef)}${query.size ? `?${query}` : ""}`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${idToken}` },
      }),
    );
    if (result.personRef !== personRef) throw new Error("The selected person could not be verified.");
    return result;
  }

  static async createInformationRequest(input: {
    personRef: string;
    scopeRefs: string[];
    purpose: string;
    durationSeconds: number;
    connectorKeyId: string;
    idempotencyKey: string;
    vaultOwnerToken: string;
    signal?: AbortSignal;
  }): Promise<InformationRequestBundle> {
    const result = await jsonOrThrow<InformationRequestBundle>(
      await ApiService.apiFetch("/api/one/information-requests", {
        method: "POST",
        signal: input.signal,
        headers: { Authorization: `Bearer ${input.vaultOwnerToken}` },
        body: JSON.stringify({
          person_ref: input.personRef,
          scope_refs: input.scopeRefs,
          purpose: input.purpose,
          duration_seconds: input.durationSeconds,
          connector_key_id: input.connectorKeyId,
          idempotency_key: input.idempotencyKey,
        }),
      }),
    );
    if (result.personRef !== input.personRef) throw new Error("The selected person could not be verified.");
    return result;
  }

  static async connect(personRef: string, idToken: string): Promise<PersonRelationship> {
    const payload = await jsonOrThrow<{ relationship: PersonRelationship }>(
      await ApiService.apiFetch(`/api/one/people/${encodeURIComponent(personRef)}/connection`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({}),
      }),
    );
    return payload.relationship;
  }

  static async cancelConnectionRequest(
    personRef: string,
    idToken: string,
  ): Promise<PersonRelationship> {
    const payload = await jsonOrThrow<{ relationship: PersonRelationship }>(
      await ApiService.apiFetch(
        `/api/one/people/${encodeURIComponent(personRef)}/connection/cancel`,
        { method: "POST", headers: { Authorization: `Bearer ${idToken}` } },
      ),
    );
    return payload.relationship;
  }

  static async removeConnection(
    personRef: string,
    idToken: string,
  ): Promise<PersonRelationship> {
    const payload = await jsonOrThrow<{ relationship: PersonRelationship }>(
      await ApiService.apiFetch(`/api/one/people/${encodeURIComponent(personRef)}/connection`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${idToken}` },
      }),
    );
    return payload.relationship;
  }
}
