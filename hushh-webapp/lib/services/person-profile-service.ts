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
};

export type ViewerPersonProfile = PublicPersonProfile & {
  relationship: PersonRelationship;
  requestableScopes: RequestablePersonScope[];
  grants: PersonGrant[];
  requestHistory: PersonInformationRequestHistory[];
};

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
  status: "pending" | "granted" | "denied" | "expired" | "revoked";
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
    status: "pending" | "granted" | "denied" | "revoked";
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
  ): Promise<ViewerPersonProfile> {
    return jsonOrThrow<ViewerPersonProfile>(
      await ApiService.apiFetch(`/api/one/people/${encodeURIComponent(personRef)}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      }),
    );
  }

  static async createInformationRequest(input: {
    personRef: string;
    scopeRefs: string[];
    purpose: string;
    durationSeconds: number;
    connectorKeyId: string;
    idempotencyKey: string;
    vaultOwnerToken: string;
  }): Promise<InformationRequestBundle> {
    return jsonOrThrow<InformationRequestBundle>(
      await ApiService.apiFetch("/api/one/information-requests", {
        method: "POST",
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
